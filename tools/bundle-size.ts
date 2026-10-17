// Bundle budget (NFR-10): JavaScript of the web build ≤ 600 KB gzip excluding WASM and the code loaded on demand
// (OCR, digital signatures), PDFium WASM ≤ 6 MB gzip. Run after `pnpm build`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const build = join(import.meta.dirname, '../apps/web/build');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const gz = (files: string[]): number => files.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
const files = walk(build);
// The SQLite worker bundle ships with its package but is not loaded: the database runs in-page.
// The OCR files (worker, WebAssembly cores, language data) load only when text recognition runs.
// The digital-signature code (pkijs and the signing services) is imported on demand the first time a
// signature is read or made. It is found in the build as the chunks no entry or route node imports
// statically and that carry the PDF signature markers, together with the chunks only they import.
const staticImports = (f: string): string[] =>
  [...readFileSync(f, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*["'](\.[^"']+\.js)["']/g)].map((m) =>
    resolve(dirname(f), m[1]!),
  );
const dynamicImports = (f: string): string[] =>
  [...readFileSync(f, 'utf8').matchAll(/\bimport\(\s*[`"'](\.[^`"']+\.js)[`"']/g)].map((m) =>
    resolve(dirname(f), m[1]!),
  );
const closure = (roots: string[], skip = new Set<string>(), dynamic = false): Set<string> => {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    if (seen.has(f) || skip.has(f)) continue;
    seen.add(f);
    queue.push(...staticImports(f), ...(dynamic ? dynamicImports(f) : []));
  }
  return seen;
};
const jsFiles = files.filter(
  (f) =>
    f.endsWith('.js') && !/sqlite3-(worker1|opfs)/.test(f) && !/\/ocr\//.test(f) && !/\/workers\//.test(f),
);
const initial = closure(jsFiles.filter((f) => /\/(entry|nodes)\//.test(f)));
const ocsp = jsFiles.filter((f) => !initial.has(f) && /OCSPRequest/.test(readFileSync(f, 'utf8')));
const lazySigning = closure(
  jsFiles.filter(
    (f) => !initial.has(f) && (ocsp.includes(f) || staticImports(f).some((i) => ocsp.includes(i))),
  ),
  initial,
  true,
);
const js = gz(
  files.filter(
    (f) =>
      f.endsWith('.js') && !/sqlite3-(worker1|opfs)/.test(f) && !/\/ocr\//.test(f) && !lazySigning.has(f),
  ),
);
const ocr = gz(
  files.filter((f) =>
    /\/ocr\/core\/tesseract-core-simd-lstm\.wasm\.js$|\/ocr\/worker\.min\.js$|\.traineddata\.gz$/.test(f),
  ),
);
const pdfium = gz(files.filter((f) => /pdfium.*\.wasm$/.test(f)));
const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
console.warn(
  `bundle: JavaScript ${kb(js)} gzip (budget 600 KB, signing code on demand: ${kb(gz([...lazySigning]))} not counted), PDFium WASM ${kb(pdfium)} gzip (budget 6144 KB), OCR (one core + English + Italian) ${kb(ocr)} gzip (budget 12288 KB)`,
);
if (js > 600 * 1024 || pdfium > 6 * 1024 * 1024 || ocr > 12 * 1024 * 1024) {
  console.error('bundle: over budget');
  process.exit(1);
}
