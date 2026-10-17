// X.509 and PKCS#12 helpers for digital signatures (FR-SIG-01…). Pure TypeScript on WebCrypto and
// pkijs, so the desktop and the web build share one code path (ADR 0007).
import * as asn1js from 'asn1js';
import {
  type AuthenticatedSafe,
  type CertBag,
  Certificate,
  PFX,
  type PrivateKeyInfo,
  type SafeContents,
  type PKCS8ShroudedKeyBag,
  getCrypto,
  setEngine,
  CryptoEngine,
} from 'pkijs';
import { CertificateError } from './errors.ts';
export { CertificateError };

export type KeyAlgorithm = 'RSA' | 'ECDSA-P256' | 'ECDSA-P384';

/** Public facts about a certificate; the only thing the database ever stores. */
export interface CertificateInfo {
  /** SHA-256 of the DER encoding, lower-case hex. */
  fingerprint: string;
  subject: string;
  /** Common name of the subject, else the whole subject. */
  commonName: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  selfSigned: boolean;
  isCa: boolean;
  /** Key usage flag names, e.g. digitalSignature, nonRepudiation. */
  keyUsage: string[];
  keyAlgorithm: KeyAlgorithm | 'unsupported';
}


let engineReady = false;
export function ensureEngine(): void {
  if (engineReady) return;
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new CertificateError('unsupported', 'WebCrypto is not available');
  setEngine('folio', new CryptoEngine({ name: 'folio', crypto }));
  engineReady = true;
}

export const toHex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join(
    '',
  );
export const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** An ArrayBuffer with exactly these bytes (pkijs rejects views that do not start at 0). */
export function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

const OID_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'E',
  '2.5.4.5': 'serialNumber',
};
type Rdn = Certificate['subject'];
function nameText(name: Rdn): string {
  return name.typesAndValues
    .map((tv) => `${OID_NAMES[tv.type] ?? tv.type}=${String(tv.value.valueBlock.value)}`)
    .join(', ');
}
export function commonNameOf(name: Rdn): string {
  const cn = name.typesAndValues.find((tv) => tv.type === '2.5.4.3');
  return cn ? String(cn.value.valueBlock.value) : nameText(name);
}

const KEY_USAGE_BITS = [
  'digitalSignature',
  'nonRepudiation',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
];

export function parseCertificate(der: Uint8Array): Certificate {
  ensureEngine();
  const asn1 = asn1js.fromBER(ab(der));
  if (asn1.offset === -1) throw new CertificateError('invalid', 'Not a DER certificate');
  try {
    return new Certificate({ schema: asn1.result });
  } catch {
    throw new CertificateError('invalid', 'Not an X.509 certificate');
  }
}

/** Accepts DER or PEM (one or more CERTIFICATE blocks) and returns every certificate found. */
export function parseCertificates(bytes: Uint8Array): Certificate[] {
  const text = new TextDecoder('latin1').decode(bytes);
  if (text.includes('-----BEGIN')) {
    const out: Certificate[] = [];
    for (const m of text.matchAll(
      /-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END (?:X509 |TRUSTED )?CERTIFICATE-----/g,
    )) {
      out.push(parseCertificate(Uint8Array.from(atob(m[1]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0))));
    }
    if (!out.length) throw new CertificateError('no-certificate', 'No certificate found in the file');
    return out;
  }
  return [parseCertificate(bytes)];
}

export function certDer(cert: Certificate): Uint8Array {
  return new Uint8Array(cert.toSchema(true).toBER(false));
}

export async function certFingerprint(cert: Certificate): Promise<string> {
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', ab(certDer(cert))));
}

function keyAlgorithmOf(cert: Certificate): CertificateInfo['keyAlgorithm'] {
  const alg = cert.subjectPublicKeyInfo.algorithm.algorithmId;
  if (alg === '1.2.840.113549.1.1.1') return 'RSA';
  if (alg === '1.2.840.10045.2.1') {
    const curve = (
      cert.subjectPublicKeyInfo.algorithm.algorithmParams as asn1js.ObjectIdentifier | undefined
    )?.valueBlock.toString();
    if (curve === '1.2.840.10045.3.1.7') return 'ECDSA-P256';
    if (curve === '1.3.132.0.34') return 'ECDSA-P384';
  }
  return 'unsupported';
}

export async function describeCertificate(cert: Certificate): Promise<CertificateInfo> {
  const usage: string[] = [];
  let isCa = false;
  for (const ext of cert.extensions ?? []) {
    if (ext.extnID === '2.5.29.15') {
      const bits = (ext.parsedValue as asn1js.BitString | undefined)?.valueBlock.valueHexView;
      if (bits?.length)
        KEY_USAGE_BITS.forEach((name, i) =>
          (bits[Math.floor(i / 8)] ?? 0) & (0x80 >> (i % 8)) ? usage.push(name) : undefined,
        );
    }
    if (ext.extnID === '2.5.29.19') isCa = !!(ext.parsedValue as { cA?: boolean } | undefined)?.cA;
  }
  return {
    fingerprint: await certFingerprint(cert),
    subject: nameText(cert.subject),
    commonName: commonNameOf(cert.subject),
    issuer: nameText(cert.issuer),
    serialNumber: toHex(cert.serialNumber.valueBlock.valueHexView),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    selfSigned: cert.issuer.isEqual(cert.subject),
    isCa,
    keyUsage: usage,
    keyAlgorithm: keyAlgorithmOf(cert),
  };
}

/** A signing identity opened from a PKCS#12 file. The private key never leaves the process. */
export interface SigningIdentity {
  /** Signer certificate first, then the rest of the chain the file carried. */
  certificates: Certificate[];
  privateKey: CryptoKey;
  info: CertificateInfo;
}

const OID_KEY_BAG = '1.2.840.113549.1.12.10.1.1';
const OID_SHROUDED_KEY_BAG = '1.2.840.113549.1.12.10.1.2';
const OID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';

async function importPrivateKey(pkcs8: Uint8Array, cert: Certificate): Promise<CryptoKey> {
  const alg = keyAlgorithmOf(cert);
  const subtle = getCrypto(true).subtle;
  try {
    if (alg === 'RSA')
      return await subtle.importKey(
        'pkcs8',
        ab(pkcs8),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    if (alg === 'ECDSA-P256')
      return await subtle.importKey('pkcs8', ab(pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
      ]);
    if (alg === 'ECDSA-P384')
      return await subtle.importKey('pkcs8', ab(pkcs8), { name: 'ECDSA', namedCurve: 'P-384' }, false, [
        'sign',
      ]);
  } catch {
    throw new CertificateError('unsupported', 'The private key could not be imported');
  }
  throw new CertificateError('unsupported', 'Only RSA and ECDSA (P-256, P-384) keys are supported');
}

/** Opens a .p12/.pfx file. Throws CertificateError('bad-password') for a wrong password. */
export async function openPkcs12(bytes: Uint8Array, password: string): Promise<SigningIdentity> {
  ensureEngine();
  const asn1 = asn1js.fromBER(ab(bytes));
  if (asn1.offset === -1) throw new CertificateError('invalid', 'Not a PKCS#12 file');
  let pfx: PFX;
  try {
    pfx = new PFX({ schema: asn1.result });
  } catch {
    throw new CertificateError('invalid', 'Not a PKCS#12 file');
  }
  const pw = ab(new TextEncoder().encode(password));
  const bmp = new Uint8Array(password.length * 2 + 2);
  for (let i = 0; i < password.length; i++) {
    bmp[i * 2] = password.charCodeAt(i) >> 8;
    bmp[i * 2 + 1] = password.charCodeAt(i) & 255;
  }
  const certs: Certificate[] = [];
  let keyDer: Uint8Array | undefined;
  let lastError: unknown;
  for (const candidate of [pw, ab(bmp)]) {
    try {
      certs.length = 0;
      keyDer = undefined;
      await pfx.parseInternalValues({ password: candidate, checkIntegrity: true });
      const safe = pfx.parsedValue?.authenticatedSafe as AuthenticatedSafe;
      await safe.parseInternalValues({
        safeContents: safe.safeContents.map(() => ({ password: candidate })),
      });
      for (const sc of safe.parsedValue.safeContents as Array<{ value: SafeContents }>) {
        for (const bag of sc.value.safeBags) {
          if (bag.bagId === OID_CERT_BAG) certs.push((bag.bagValue as CertBag).parsedValue as Certificate);
          else if (bag.bagId === OID_SHROUDED_KEY_BAG) {
            const shrouded = bag.bagValue as PKCS8ShroudedKeyBag;
            await (shrouded as unknown as { parseInternalValues(p: { password: ArrayBuffer }): Promise<void> }).parseInternalValues({ password: candidate });
            keyDer = new Uint8Array((shrouded.parsedValue as PrivateKeyInfo).toSchema().toBER(false));
          } else if (bag.bagId === OID_KEY_BAG)
            keyDer = new Uint8Array((bag.bagValue as PrivateKeyInfo).toSchema().toBER(false));
        }
      }
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    if (/mac|integrity|password|decrypt|OperationError/i.test(msg) || lastError instanceof DOMException)
      throw new CertificateError('bad-password', 'Wrong password or damaged file');
    throw new CertificateError('unsupported', `Unsupported PKCS#12 encryption: ${msg}`);
  }
  if (!keyDer) throw new CertificateError('no-key', 'The file has no private key');
  if (!certs.length) throw new CertificateError('no-certificate', 'The file has no certificate');

  // The signer is the certificate whose public key matches the private key; the rest is the chain.
  const spki = async (c: Certificate) => toHex(c.subjectPublicKeyInfo.toSchema().toBER(false));
  let signerIndex = -1;
  const subtle = getCrypto(true).subtle;
  for (let i = 0; i < certs.length; i++) {
    const alg = keyAlgorithmOf(certs[i]!);
    if (alg === 'unsupported') continue;
    try {
      const key = await importPrivateKey(keyDer, certs[i]!);
      const probe = new Uint8Array([1, 2, 3]);
      const params = alg === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
      const sig = await subtle.sign(params, key, probe);
      const pub = await subtle.importKey(
        'spki',
        ab(new Uint8Array(certs[i]!.subjectPublicKeyInfo.toSchema().toBER(false))),
        alg === 'RSA'
          ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
          : { name: 'ECDSA', namedCurve: alg === 'ECDSA-P256' ? 'P-256' : 'P-384' },
        false,
        ['verify'],
      );
      if (await subtle.verify(params, pub, sig, probe)) {
        signerIndex = i;
        break;
      }
    } catch {
      /* not this one */
    }
  }
  void spki;
  if (signerIndex < 0)
    throw new CertificateError('unsupported', 'Only RSA and ECDSA (P-256, P-384) keys are supported');
  const signer = certs[signerIndex]!;
  const ordered = [signer, ...certs.filter((_, i) => i !== signerIndex)];
  return {
    certificates: ordered,
    privateKey: await importPrivateKey(keyDer, signer),
    info: await describeCertificate(signer),
  };
}
