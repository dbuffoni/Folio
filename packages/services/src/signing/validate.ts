// Validation of the signatures a PDF already carries (FR-SIG-04…06): integrity of the signed bytes,
// signer certificate and chain against the user's trusted certificates, validity period, and bytes
// appended after the last signature. Offline; revocation is a separate, opt-in step.
import type { PDFDict as PDFDictT } from 'pdf-lib';
import type { Certificate } from 'pkijs';
import { certDer, describeCertificate, certFingerprint, type CertificateInfo } from './certs.ts';
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
    const v = field.lookupMaybe(n('V'), PDFDict);
    if (!v || field.lookup(n('FT')) !== n('Sig')) return;
    const range = v.lookupMaybe(n('ByteRange'), PDFArray);
    const contents = v.lookup(n('Contents'));
    if (!range || !(contents instanceof PDFHexString)) return;
    const byteRange = Array.from({ length: range.size() }, (_, i) =>
      (range.lookup(i, PDFNumber) as { asNumber(): number }).asNumber(),
    );
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

function sameName(a: Certificate, b: Certificate): boolean {
  return a.subject.isEqual(b.issuer);
}

async function chainTo(
  signer: Certificate,
  pool: Certificate[],
  trustedFp: Set<string>,
): Promise<{ path: Certificate[]; trusted: boolean }> {
  const path = [signer];
  let cur = signer;
  for (let depth = 0; depth < 10; depth++) {
    if (trustedFp.has(await certFingerprint(cur))) return { path, trusted: true };
    if (cur.issuer.isEqual(cur.subject)) return { path, trusted: false };
    let next: Certificate | undefined;
    for (const c of pool) {
      if (!sameName(c, cur) || path.includes(c)) continue;
      try {
        if (await cur.verify(c)) {
          next = c;
          break;
        }
      } catch {
        /* wrong issuer */
      }
    }
    if (!next) return { path, trusted: false };
    path.push(next);
    cur = next;
  }
  return { path, trusted: false };
}

export function pdfDateToIso(d: string | undefined): string | undefined {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(d ?? '');
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
  const tz = m[7];
  if (!tz || tz === 'Z') return `${iso}Z`;
  const t = /([+-])(\d{2})'?(\d{2})/.exec(tz);
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
    const at = timestamp?.time ? new Date(timestamp.time) : now;
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
