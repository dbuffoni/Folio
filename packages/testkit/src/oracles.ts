// Typed wrappers around independent PDF tools (SPEC §16.4). Folio output is never judged by Folio alone.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import type { RasterImage } from '@folio/ports';

const run = promisify(execFile);
const HOME_BIN = join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.local', 'bin');
const env = { ...process.env, PATH: `${process.env.PATH ?? ''}${delimiter}${HOME_BIN}` };

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
async function exec(cmd: string, args: string[], opts: { binary?: boolean } = {}): Promise<Result & { raw?: Buffer }> {
  try {
    const r = await run(cmd, args, { env, maxBuffer: 256 * 1024 * 1024, encoding: opts.binary ? 'buffer' : 'utf8' });
    // Tools on Windows end lines with CRLF; the parsers below split on \n.
    return { code: 0, stdout: opts.binary ? '' : (r.stdout as string).replace(/\r\n/g, '\n'), stderr: String(r.stderr), raw: opts.binary ? (r.stdout as unknown as Buffer) : undefined };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: unknown; stderr?: unknown };
    if (err.code === 'ENOENT') throw new Error(`Oracle tool "${cmd}" is not installed`);
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

/** Runs `fn` with the bytes written to a temp file; cleans up afterwards. */
export async function withTempPdf<T>(pdf: Uint8Array, fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'folio-oracle-'));
  try {
    const path = join(dir, 'in.pdf');
    await writeFile(path, pdf);
    return await fn(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const toolCache = new Map<string, boolean>();
export async function hasTool(name: 'qpdf' | 'pdfcpu' | 'mutool' | 'pdftoppm' | 'pdftotext' | 'pdffonts' | 'pdfinfo'): Promise<boolean> {
  if (!toolCache.has(name)) {
    try {
      await run(name, [name === 'pdfcpu' ? 'version' : name === 'mutool' ? '-v' : name === 'qpdf' ? '--version' : '-v'], { env });
      toolCache.set(name, true);
    } catch (e) {
      toolCache.set(name, (e as { code?: unknown }).code !== 'ENOENT');
    }
  }
  return toolCache.get(name)!;
}

export interface CheckResult {
  ok: boolean;
  warnings: string[];
  output: string;
}
/** `qpdf --check`: exit 0 clean, 3 warnings, 2 errors. */
export async function qpdfCheck(pdf: Uint8Array, password?: string): Promise<CheckResult> {
  return withTempPdf(pdf, async (path) => {
    const r = await exec('qpdf', [...(password ? [`--password=${password}`] : []), '--check', path]);
    const output = r.stdout + r.stderr;
    const warnings = output.split('\n').filter((l) => /WARNING|warning:/.test(l));
    return { ok: r.code === 0, warnings, output };
  });
}
/** `pdfcpu validate` in relaxed mode. */
export async function pdfcpuValidate(pdf: Uint8Array, password?: string): Promise<CheckResult> {
  return withTempPdf(pdf, async (path) => {
    const r = await exec('pdfcpu', ['validate', ...(password ? ['--upw', password] : []), path]);
    const output = r.stdout + r.stderr;
    return { ok: r.code === 0 && /validation ok/.test(output), warnings: [], output };
  });
}
/** Text of the document (or one 1-based page) as extracted by poppler. */
export async function pdftotext(pdf: Uint8Array, opts: { page?: number; layout?: boolean; password?: string } = {}): Promise<string> {
  return withTempPdf(pdf, async (path) => {
    const args = ['-enc', 'UTF-8', ...(opts.layout ? ['-layout'] : []), ...(opts.password ? ['-upw', opts.password] : [])];
    if (opts.page) args.push('-f', String(opts.page), '-l', String(opts.page));
    const r = await exec('pdftotext', [...args, path, '-']);
    if (r.code !== 0) throw new Error(`pdftotext failed: ${r.stderr}`);
    return r.stdout;
  });
}
export function decodePng(bytes: Uint8Array): RasterImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
}
export function encodePng(img: RasterImage): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return new Uint8Array(PNG.sync.write(png));
}
/** Renders one 1-based page with poppler at `dpi`. */
export async function pdftoppm(pdf: Uint8Array, page: number, dpi = 72): Promise<RasterImage> {
  return withTempPdf(pdf, async (path, dir) => {
    const r = await exec('pdftoppm', ['-r', String(dpi), '-png', '-f', String(page), '-l', String(page), path, join(dir, 'out')]);
    if (r.code !== 0) throw new Error(`pdftoppm failed: ${r.stderr}`);
    const file = (await readdir(dir)).find((f) => f.startsWith('out') && f.endsWith('.png'));
    if (!file) throw new Error('pdftoppm produced no image');
    return decodePng(await readFile(join(dir, file)));
  });
}
/** Renders one 1-based page with MuPDF at `dpi`. */
export async function mutoolDraw(pdf: Uint8Array, page: number, dpi = 72): Promise<RasterImage> {
  return withTempPdf(pdf, async (path, dir) => {
    const out = join(dir, 'mu.png');
    const r = await exec('mutool', ['draw', '-q', '-r', String(dpi), '-o', out, path, String(page)]);
    if (r.code !== 0) throw new Error(`mutool draw failed: ${r.stderr}`);
    return decodePng(await readFile(out));
  });
}
/** `mutool show file path` — prints a PDF object, e.g. `trailer/Root/AcroForm`. */
export async function mutoolShow(pdf: Uint8Array, objectPath: string): Promise<string> {
  return withTempPdf(pdf, async (path) => (await exec('mutool', ['show', path, objectPath])).stdout);
}
export interface PdfInfo {
  pages: number;
  encrypted: boolean;
  title: string;
  author: string;
  subject: string;
  keywords: string;
  producer: string;
  pageSize: string;
  raw: Record<string, string>;
}
export async function pdfinfo(pdf: Uint8Array, password?: string): Promise<PdfInfo> {
  return withTempPdf(pdf, async (path) => {
    const r = await exec('pdfinfo', [...(password ? ['-upw', password] : []), path]);
    if (r.code !== 0) throw new Error(`pdfinfo failed: ${r.stderr}`);
    const raw: Record<string, string> = {};
    for (const line of r.stdout.split('\n')) {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (m) raw[m[1]!.trim()] = m[2]!.trim();
    }
    return {
      pages: Number(raw['Pages'] ?? 0),
      encrypted: /^yes/.test(raw['Encrypted'] ?? 'no'),
      title: raw['Title'] ?? '',
      author: raw['Author'] ?? '',
      subject: raw['Subject'] ?? '',
      keywords: raw['Keywords'] ?? '',
      producer: raw['Producer'] ?? '',
      pageSize: raw['Page size'] ?? '',
      raw,
    };
  });
}
export interface FontRow {
  name: string;
  type: string;
  embedded: boolean;
  subset: boolean;
}
export async function pdffonts(pdf: Uint8Array): Promise<FontRow[]> {
  return withTempPdf(pdf, async (path) => {
    const r = await exec('pdffonts', [path]);
    return r.stdout
      .split('\n')
      .slice(2)
      .filter((l) => l.trim())
      .map((l) => {
        const m = /^(\S+)\s+(.+?)\s{2,}(\S.*?)\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/.exec(l);
        return m ? { name: m[1]!, type: m[2]!.trim(), embedded: m[4] === 'yes', subset: m[5] === 'yes' } : { name: l.trim(), type: '', embedded: false, subset: false };
      });
  });
}
export interface AnnotRow {
  page: number;
  type: string;
  id: string;
  rect: string;
  content: string;
}
/** Annotations as listed by pdfcpu (type per page). */
export async function pdfcpuAnnotations(pdf: Uint8Array): Promise<string> {
  return withTempPdf(pdf, async (path) => {
    const r = await exec('pdfcpu', ['annotations', 'list', path]);
    return r.stdout + r.stderr;
  });
}
export interface FieldRow {
  type: string;
  name: string;
  value: string;
}
/** Form fields as listed by pdfcpu. */
export async function pdfcpuFormFields(pdf: Uint8Array): Promise<FieldRow[]> {
  return withTempPdf(pdf, async (path) => {
    const r = await exec('pdfcpu', ['form', 'list', path]);
    const rows: FieldRow[] = [];
    let cols: string[] = [];
    for (const line of r.stdout.split('\n')) {
      const cells = line.split('│').map((c) => c.trim());
      if (cells.length < 4) continue;
      if (cells.includes('Id') && cells.includes('Name')) {
        cols = cells;
        continue;
      }
      if (!/\d/.test(cells[cols.indexOf('Id')] ?? '')) continue;
      const type = cells[0]!.replace(/^\d+\s+/, '').replace(/^[*\s]+/, '');
      rows.push({ type, name: cells[cols.indexOf('Name')]!, value: (cells[cols.indexOf('Value')] ?? '').replace(/\\n/g, '\n') });
    }
    return rows;
  });
}
/** Encrypts with AES-256 (fixtures only — Folio itself never writes encrypted files in Release 1). */
export async function qpdfEncrypt(
  pdf: Uint8Array,
  userPassword: string,
  ownerPassword = userPassword,
  /** Extra qpdf restriction flags, for example `--print=none --modify=none` (256-bit: print/modify/extract/annotate/form/assemble/accessibility). */
  restrictions: string[] = [],
): Promise<Uint8Array> {
  return withTempPdf(pdf, async (path, dir) => {
    const out = join(dir, 'enc.pdf');
    const r = await exec('qpdf', ['--static-id', '--encrypt', userPassword, ownerPassword, '256', ...restrictions, '--', path, out]);
    if (r.code !== 0 && r.code !== 3) throw new Error(`qpdf --encrypt failed: ${r.stderr}`);
    return new Uint8Array(await readFile(out));
  });
}
/** Uncompressed, human-greppable rewrite of the file (QDF mode) for content-stream assertions. */
export async function qpdfQdf(pdf: Uint8Array): Promise<string> {
  return withTempPdf(pdf, async (path, dir) => {
    const out = join(dir, 'qdf.pdf');
    await exec('qpdf', ['--qdf', '--object-streams=disable', path, out]);
    return (await readFile(out)).toString('latin1');
  });
}

/** `pdfsig` verdicts, one per signature in file order. */
export interface PdfsigRow {
  field: string;
  signer: string;
  validSignature: boolean;
  totalDocumentSigned: boolean;
  certificate: string;
}
export async function pdfsig(pdf: Uint8Array): Promise<PdfsigRow[]> {
  return withTempPdf(pdf, async (path) => {
    const r = await exec('pdfsig', [path]);
    const rows: PdfsigRow[] = [];
    let cur: PdfsigRow | undefined;
    for (const line of r.stdout.split('\n')) {
      if (/^Signature #\d+:/.test(line)) rows.push((cur = { field: '', signer: '', validSignature: false, totalDocumentSigned: false, certificate: '' }));
      else if (cur) {
        const t = line.replace(/^\s*-\s*/, '');
        if (t.startsWith('Signature Field Name:')) cur.field = t.split(':')[1]!.trim();
        else if (t.startsWith('Signer Certificate Common Name:')) cur.signer = t.split(':')[1]!.trim();
        else if (t.startsWith('Total document signed')) cur.totalDocumentSigned = true;
        else if (t.startsWith('Signature Validation:')) cur.validSignature = /is Valid/.test(t);
        else if (t.startsWith('Certificate Validation:')) cur.certificate = t.slice('Certificate Validation:'.length).trim();
      }
    }
    return rows;
  });
}

/** A PKCS#12 file made by OpenSSL, the independent producer our importer is tested against. */
export async function opensslPkcs12(opts: { cn: string; password: string; ec?: boolean; legacy?: boolean; ed25519?: boolean; curve?: string; /** Raw `-newkey` arguments, e.g. ['rsa-pss'] */ newkey?: string[]; certOnly?: boolean; days?: number }): Promise<{ p12: Uint8Array; certPem: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'folio-ossl-'));
  try {
    const key = join(dir, 'k.pem');
    const crt = join(dir, 'c.pem');
    const out = join(dir, 'o.p12');
    const keyArgs = opts.newkey ? ['-newkey', ...opts.newkey] : opts.ed25519 ? ['-newkey', 'ed25519'] : opts.ec || opts.curve ? ['-newkey', 'ec', '-pkeyopt', `ec_paramgen_curve:${opts.curve ?? 'prime256v1'}`] : ['-newkey', 'rsa:2048'];
    const made = await exec('openssl', ['req', '-x509', ...keyArgs, '-nodes', '-keyout', key, '-out', crt, '-days', String(opts.days ?? 30), '-subj', `/CN=${opts.cn}/O=Folio`, '-addext', 'keyUsage=digitalSignature,nonRepudiation']);
    if (made.code !== 0) throw new Error(`openssl req failed: ${made.stderr}`);
    const exp = await exec('openssl', ['pkcs12', '-export', '-inkey', key, '-in', crt, '-out', out, '-passout', `pass:${opts.password}`, ...(opts.legacy ? ['-legacy'] : []), ...(opts.certOnly ? ['-nokeys'] : [])]);
    if (exp.code !== 0) throw new Error(`openssl pkcs12 failed: ${exp.stderr}`);
    return { p12: new Uint8Array(await readFile(out)), certPem: await readFile(crt, 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A PKCS#12 file holding a leaf, its CA (and optionally an unrelated extra certificate), as a corporate CA hands them out.
 * `triple` uses the SHA-1 / 3DES protection older Windows exports have; `friendly` sets the bag name.
 */
export async function opensslPkcs12Chain(opts: { cn: string; caCn: string; password: string; triple?: boolean; friendly?: string; extraCa?: boolean; /** Leaf issued by an intermediate; the bundle lists the root first. */ deep?: boolean; /** Extra `openssl pkcs12 -export` arguments. */ args?: string[] }): Promise<{ p12: Uint8Array; leafPem: string; caPem: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'folio-ossl-'));
  try {
    const f = (n: string) => join(dir, n);
    const steps: string[][] = [
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '30', '-subj', `/CN=${opts.caCn}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=keyCertSign,cRLSign'],
      ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('k.pem'), '-out', f('l.csr'), '-subj', `/CN=${opts.cn}/O=Folio`],
      ['x509', '-req', '-in', f('l.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('l.pem'), '-days', '30'],
    ];
    for (const a of steps) {
      const r = await exec('openssl', a);
      if (r.code !== 0) throw new Error(`openssl ${a[0]} failed: ${r.stderr}`);
    }
    let bundle = await readFile(f('ca.pem'), 'utf8');
    if (opts.deep) {
      const mid: string[][] = [
        ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('m.key'), '-out', f('m.csr'), '-subj', '/CN=Intermediate'],
        ['x509', '-req', '-in', f('m.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('m.pem'), '-days', '30', '-extfile', f('m.ext')],
        ['x509', '-req', '-in', f('l.csr'), '-CA', f('m.pem'), '-CAkey', f('m.key'), '-CAcreateserial', '-out', f('l.pem'), '-days', '30'],
      ];
      await writeFile(f('m.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign,cRLSign\n');
      for (const a of mid) {
        const r = await exec('openssl', a);
        if (r.code !== 0) throw new Error(`openssl ${a[0]} failed: ${r.stderr}`);
      }
      bundle += await readFile(f('m.pem'), 'utf8');
    }
    if (opts.extraCa) {
      const r = await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('x.key'), '-out', f('x.pem'), '-days', '30', '-subj', '/CN=Unrelated']);
      if (r.code !== 0) throw new Error(`openssl req failed: ${r.stderr}`);
      bundle += await readFile(f('x.pem'), 'utf8');
    }
    await writeFile(f('bundle.pem'), bundle);
    const args = ['pkcs12', '-export', '-inkey', f('k.pem'), '-in', f('l.pem'), '-certfile', f('bundle.pem'), '-out', f('o.p12'), '-passout', `pass:${opts.password}`];
    if (opts.friendly) args.push('-name', opts.friendly);
    if (opts.args) args.push(...opts.args);
    if (opts.triple) args.push('-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-legacy');
    const exp = await exec('openssl', args);
    if (exp.code !== 0) throw new Error(`openssl pkcs12 failed: ${exp.stderr}`);
    return { p12: new Uint8Array(await readFile(f('o.p12'))), leafPem: await readFile(f('l.pem'), 'utf8'), caPem: await readFile(f('ca.pem'), 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs `check` on the pdfsig verdicts, or does nothing where pdfsig does not exist (Windows). */
export async function withPdfsig(pdf: Uint8Array, check: (rows: PdfsigRow[]) => void): Promise<void> {
  try {
    await exec('pdfsig', ['-v']);
  } catch {
    if (process.platform === 'win32') return;
    throw new Error('Oracle tool "pdfsig" is not installed');
  }
  check(await pdfsig(pdf));
}
