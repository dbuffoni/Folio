// Validation of the signatures a PDF already carries (FR-SIG-04…06): integrity of the signed bytes,
// signer certificate and chain against the user's trusted certificates, validity period, and bytes
// appended after the last signature. Offline; revocation is a separate, opt-in step.
import type { PDFDict as PDFDictT, PDFNumber as PDFNumberT } from 'pdf-lib';
import type { Certificate } from 'pkijs';
import { certDer, describeCertificate, certFingerprint, type CertificateInfo } from './certs.ts';
import { chainTo } from './chain.ts';
import { parseCms, verifyDetached } from './cms.ts';
import { checkChainRevocation } from './revocation.ts';
import { verifyTimestampToken, type BinaryTransport, type TimestampInfo } from './timestamp.ts';

export type SignatureStatus = 'valid' | 'valid-untrusted' | 'invalid' | 'unknown';
export type TrustState = 'trusted' | 'untrusted' | 'expired' | 'not-yet-valid';
export type RevocationState = 'not-checked' | 'good' | 'revoked' | 'unknown';

export interface SignatureReport {
  /** 0-based, in file order. */
  index: number;
  fieldName: string;
  status: SignatureStatus;
  /** Integrity of the signed bytes. */
  integrity: 'ok' | 'tampered' | 'malformed' | 'unsupported';
  signer?: CertificateInfo;
  /** DER of the signer certificate, for "Trust this signer". */
  signerDer?: Uint8Array;
  chain: CertificateInfo[];
  trust: TrustState;
  /** The chain reached a trusted certificate. */
  chainComplete: boolean;
  signingTime?: string;
  reason?: string;
  location?: string;
  /** The signed range covers the whole file. */
  coversWholeFile: boolean;
  /** Bytes (a later revision) follow the signed range. */
  changedAfterSigning: boolean;
  timestamp?: TimestampInfo;
  revocation: RevocationState;
  /** Why the status is what it is, for the details view. */
  message?: string;
}

export interface ValidateOptions {
  /** DER of every certificate the user trusts (roots or signer certificates). */
  trusted?: Uint8Array[];
  /** "Now"; injected for tests. */
  now?: Date;
  /** Opt-in OCSP/CRL lookups; absent = nothing is sent and revocation stays "not-checked". */
  revocation?: BinaryTransport;
}

interface RawSignature {
  fieldName: string;
  byteRange: number[];
  contents: Uint8Array;
  reason?: string;
  location?: string;
  m?: string;
}

/** The signature dictionaries of the file, found through the signature fields. */
export async function readSignatures(bytes: Uint8Array): Promise<RawSignature[]> {
  const { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFHexString, PDFString } =
    await import('pdf-lib');
  const n = PDFName.of;
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  } catch {
    return [];
  }
  const text = (v: unknown): string | undefined =>
    v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
  const out: Array<RawSignature & { order: number }> = [];
  const seen = new Set<PDFDictT>();
  const visit = (field: PDFDictT, prefix: string): void => {
    const t = text(field.lookup(n('T')));
    const name = t ? (prefix ? `${prefix}.${t}` : t) : prefix;
    const kids = field.lookupMaybe(n('Kids'), PDFArray);
    if (kids)
      for (let i = 0; i < kids.size(); i++) {
        const kid = kids.lookupMaybe(i, PDFDict);
        if (kid && !seen.has(kid)) {
          seen.add(kid);
          visit(kid, name);
        }
      }
    // /V of a text field is a string, of a choice field an array: only a signature field holds a dictionary.
    const raw = field.lookup(n('V'));
    const v = raw instanceof PDFDict ? raw : undefined;
    if (!v || field.lookup(n('FT')) !== n('Sig')) return;
    const range = v.lookupMaybe(n('ByteRange'), PDFArray);
    const contents = v.lookup(n('Contents'));
    if (!range || !(contents instanceof PDFHexString)) return;
    // A range that is not all numbers stays empty, and the signature is reported as malformed.
    const items = Array.from({ length: range.size() }, (_, i) => range.lookup(i));
    const byteRange = items.every((x) => x instanceof PDFNumber)
      ? items.map((x) => (x as PDFNumberT).asNumber())
      : [];
    out.push({
      fieldName: name,
      byteRange,
      contents: contents.asBytes(),
      reason: text(v.lookup(n('Reason'))),
      location: text(v.lookup(n('Location'))),
      m: text(v.lookup(n('M'))),
      order: byteRange[2] ?? 0,
    });
  };
  const fields = doc.catalog.lookupMaybe(n('AcroForm'), PDFDict)?.lookupMaybe(n('Fields'), PDFArray);
  if (fields)
    for (let i = 0; i < fields.size(); i++) {
      const f = fields.lookupMaybe(i, PDFDict);
      if (f && !seen.has(f)) {
        seen.add(f);
        visit(f, '');
      }
    }
  return out.sort((a, b) => a.order - b.order);
}

const isHexDigit = (ch: number): boolean =>
  (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66);

/** Length of the DER value at the start of `der` (tag, length and content), or -1. */
function derLength(der: Uint8Array): number {
  if (der.length < 2) return -1;
  const first = der[1]!;
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  if (n === 0 || n > 4 || der.length < 2 + n) return -1;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + der[2 + i]!;
  return 2 + n + len;
}

/** Why the ByteRange gap `[b, c)` is not exactly `<hex of contents>`, or undefined when it is. */
function checkGap(bytes: Uint8Array, b: number, c: number, contents: Uint8Array): string | undefined {
  const bad = 'The signed byte range does not hold exactly the signature value';
  if (c - b < 2 || bytes[b] !== 0x3c /* < */ || bytes[c - 1] !== 0x3e /* > */) return bad;
  const digits = c - b - 2;
  if (digits % 2 !== 0 || digits / 2 !== contents.length) return bad;
  for (let i = b + 1; i < c - 1; i++) if (!isHexDigit(bytes[i]!)) return bad;
  for (let i = 0; i < contents.length; i++) {
    const at = b + 1 + i * 2;
    const v = parseInt(String.fromCharCode(bytes[at]!, bytes[at + 1]!), 16);
    if (v !== contents[i]) return bad;
  }
  const used = derLength(contents);
  if (used < 0 || used > contents.length) return bad;
  for (let i = used; i < contents.length; i++) if (contents[i] !== 0) return bad;
  return undefined;
}

export function pdfDateToIso(d: string | undefined): string | undefined {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(d ?? '');
  if (!m) return undefined;
  const [y, mo, day, h, mi, s] = [m[1], m[2] ?? '01', m[3] ?? '01', m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].map(Number) as [number, number, number, number, number, number];
  // Out-of-range parts (month 13, 31 February, 25 h) mean no usable date, not an invalid ISO string.
  const check = new Date(Date.UTC(y, mo - 1, day, h, mi, s));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s)
    return undefined;
  const iso = `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
  const tz = m[7];
  if (!tz || tz === 'Z') return `${iso}Z`;
  const t = /([+-])(\d{2})'?(\d{2})/.exec(tz);
  if (t && (Number(t[2]) > 23 || Number(t[3]) > 59)) return undefined;
  return t ? `${iso}${t[1]}${t[2]}:${t[3]}` : `${iso}Z`;
}

/** Reports every signature of `bytes`. Never throws for a damaged signature: it is reported instead. */
export async function validateSignatures(
  bytes: Uint8Array,
  opts: ValidateOptions = {},
): Promise<SignatureReport[]> {
  const sigs = await readSignatures(bytes);
  const { parseCertificate } = await import('./certs.ts');
  const trustedCerts: Certificate[] = [];
  for (const der of opts.trusted ?? []) {
    try {
      trustedCerts.push(parseCertificate(der));
    } catch {
      /* ignore broken entries */
    }
  }
  const trustedFp = new Set(await Promise.all(trustedCerts.map(certFingerprint)));
  const now = opts.now ?? new Date();
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 10 || bytes[end - 1] === 13 || bytes[end - 1] === 32)) end--;
  const reports: SignatureReport[] = [];
  for (const [index, s] of sigs.entries()) {
    const [a, b, c, d] = s.byteRange;
    const base: SignatureReport = {
      index,
      fieldName: s.fieldName,
      status: 'unknown',
      integrity: 'malformed',
      chain: [],
      trust: 'untrusted',
      chainComplete: false,
      signingTime: pdfDateToIso(s.m),
      reason: s.reason,
      location: s.location,
      coversWholeFile: false,
      changedAfterSigning: false,
      revocation: 'not-checked',
    };
    const wellFormed =
      s.byteRange.length === 4 && a === 0 && b! >= 0 && c! >= b! && d! >= 0 && c! + d! <= bytes.length;
    if (!wellFormed) {
      reports.push({ ...base, message: 'The signed byte range is not valid' });
      continue;
    }
    // The gap must hold exactly this signature's /Contents as one plain hex string, padded with zeros
    // after the DER value: anything else is unsigned data hidden in the signature (R13).
    const gapProblem = checkGap(bytes, b!, c!, s.contents);
    if (gapProblem) {
      reports.push({ ...base, message: gapProblem });
      continue;
    }
    const lastSigned = c! + d!;
    base.coversWholeFile = lastSigned >= end;
    base.changedAfterSigning = lastSigned < end;
    const data = new Uint8Array(b! + d!);
    data.set(bytes.subarray(0, b!), 0);
    data.set(bytes.subarray(c!, c! + d!), b!);
    // The placeholder keeps trailing zero bytes; DER parsing ignores them.
    const cms = await verifyDetached(s.contents, data);
    if (!cms.ok) {
      const integrity =
        cms.reason === 'digest-mismatch' || cms.reason === 'bad-signature'
          ? 'tampered'
          : cms.reason === 'unsupported'
            ? 'unsupported'
            : 'malformed';
      reports.push({
        ...base,
        integrity,
        status: integrity === 'tampered' ? 'invalid' : 'unknown',
        message: cms.message,
      });
      continue;
    }
    const pool = [...cms.certificates, ...trustedCerts];
    const { path, trusted } = await chainTo(cms.signer, pool, trustedFp);
    let timestamp: TimestampInfo | undefined;
    try {
      const signed = parseCms(s.contents);
      timestamp = await verifyTimestampToken(signed, trustedCerts);
    } catch {
      timestamp = undefined;
    }
    // Only a token that verifies and comes from a trusted authority may move the time the chain is judged
    // at; anyone can make a token with an earlier time for a certificate that has since expired.
    const at = timestamp?.time && timestamp.verified && timestamp.trusted ? new Date(timestamp.time) : now;
    const expired = path.some((cert) => at > cert.notAfter.value);
    const early = path.some((cert) => at < cert.notBefore.value);
    const trust: TrustState = expired
      ? 'expired'
      : early
        ? 'not-yet-valid'
        : trusted
          ? 'trusted'
          : 'untrusted';
    const chain = await Promise.all(path.map(describeCertificate));
    let revocation: RevocationState = 'not-checked';
    if (opts.revocation) revocation = (await checkChainRevocation(path, opts.revocation)).state;
    reports.push({
      ...base,
      integrity: 'ok',
      signer: chain[0],
      signerDer: certDer(cms.signer),
      chain,
      chainComplete: trusted,
      trust,
      signingTime: (
        cms.signingTime ?? (base.signingTime ? new Date(base.signingTime) : undefined)
      )?.toISOString(),
      timestamp,
      revocation,
      status: revocation === 'revoked' ? 'invalid' : trust === 'trusted' ? 'valid' : 'valid-untrusted',
      message:
        trust === 'trusted'
          ? undefined
          : trust === 'untrusted'
            ? 'The signer is not in your trusted certificates'
            : trust === 'expired'
              ? 'A certificate of the chain has expired'
              : 'A certificate of the chain is not valid yet',
    });
  }
  return reports;
}
