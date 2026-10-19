// Certificate selection and path building shared by signature and timestamp validation (FR-SIG-04,
// FR-SIG-05, FR-SIG-07). Offline and deliberately small: RFC 5280 §6 basics, no policy processing.
import * as asn1js from 'asn1js';
import { BasicConstraints, Certificate, IssuerAndSerialNumber, type SignedData } from 'pkijs';
import { ab, certDer, certFingerprint } from './certs.ts';

const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_KEY_ID = '2.5.29.14';
export const OID_KP_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The certificates a SignedData carries (attribute certificates and others skipped). */
export function certificatesOf(signed: SignedData): Certificate[] {
  return (signed.certificates ?? []).filter((c): c is Certificate => c instanceof Certificate);
}

/**
 * The certificate the signer identifier of `signed.signerInfos[index]` names: by issuer and serial
 * number, or by subject key identifier (the extension value, or the SHA-1 of the public key as pkijs
 * computes it). Undefined when none or more than one certificate matches.
 */
export async function findSigner(signed: SignedData, index = 0): Promise<Certificate | undefined> {
  const sid = signed.signerInfos[index]?.sid;
  if (!sid) return undefined;
  const certs = certificatesOf(signed);
  let matches: Certificate[];
  if (sid instanceof IssuerAndSerialNumber) {
    matches = certs.filter((c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber));
  } else {
    const block = sid as asn1js.BaseBlock & { valueBlock: { value?: asn1js.BaseBlock[]; valueHexView?: Uint8Array } };
    const inner = block.idBlock.isConstructed
      ? (block.valueBlock.value?.[0] as { valueBlock?: { valueHexView?: Uint8Array } } | undefined)?.valueBlock
          ?.valueHexView
      : block.valueBlock.valueHexView;
    if (!inner?.length) return undefined;
    const keyId = new Uint8Array(inner);
    matches = [];
    for (const c of certs) {
      const ext = c.extensions?.find((e) => e.extnID === OID_SUBJECT_KEY_ID);
      const extId = ext ? asn1js.fromBER(ab(new Uint8Array(ext.extnValue.valueBlock.valueHexView))).result : undefined;
      const fromExt =
        extId instanceof asn1js.OctetString ? new Uint8Array(extId.valueBlock.valueHexView) : undefined;
      const fromKey = new Uint8Array(
        await globalThis.crypto.subtle.digest(
          'SHA-1',
          ab(new Uint8Array(c.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)),
        ),
      );
      if ((fromExt && equalBytes(fromExt, keyId)) || equalBytes(fromKey, keyId)) matches.push(c);
    }
  }
  // Two different certificates under one identifier: refuse rather than guess.
  const ders = matches.map(certDer);
  return ders.length && ders.every((d) => equalBytes(d, ders[0]!)) ? matches[0] : undefined;
}

/** Extended key usage OIDs of `cert`; undefined when the extension is absent. */
export function extendedKeyUsage(cert: Certificate): string[] | undefined {
  const ext = cert.extensions?.find((e) => e.extnID === OID_EXT_KEY_USAGE);
  if (!ext) return undefined;
  const seq = asn1js.fromBER(ab(new Uint8Array(ext.extnValue.valueBlock.valueHexView))).result;
  if (!(seq instanceof asn1js.Sequence)) return [];
  return seq.valueBlock.value
    .filter((v): v is asn1js.ObjectIdentifier => v instanceof asn1js.ObjectIdentifier)
    .map((v) => v.valueBlock.toString());
}

/**
 * Whether `cert` may issue certificates (RFC 5280 §4.2.1.3, §4.2.1.9): basicConstraints cA, and
 * keyCertSign when a key usage extension is present. Returns the pathLenConstraint, if any.
 */
function issuerConstraints(cert: Certificate): { ok: boolean; pathLen?: number } {
  const bcExt = cert.extensions?.find((e) => e.extnID === OID_BASIC_CONSTRAINTS);
  if (!bcExt) return { ok: false };
  let bc: BasicConstraints;
  try {
    bc = new BasicConstraints({
      schema: asn1js.fromBER(ab(new Uint8Array(bcExt.extnValue.valueBlock.valueHexView))).result,
    });
  } catch {
    return { ok: false };
  }
  if (!bc.cA) return { ok: false };
  const kuExt = cert.extensions?.find((e) => e.extnID === OID_KEY_USAGE);
  if (kuExt) {
    const ku = asn1js.fromBER(ab(new Uint8Array(kuExt.extnValue.valueBlock.valueHexView))).result;
    const bits = ku instanceof asn1js.BitString ? new Uint8Array(ku.valueBlock.valueHexView) : new Uint8Array();
    // keyCertSign is bit 5 of the first byte (MSB first).
    if (!((bits[0] ?? 0) & 0x04)) return { ok: false };
  }
  const pathLen = bc.pathLenConstraint;
  return {
    ok: true,
    pathLen: typeof pathLen === 'number' ? pathLen : pathLen instanceof asn1js.Integer ? pathLen.valueBlock.valueDec : undefined,
  };
}

/**
 * Builds a path from `leaf` up through `pool` until a certificate whose fingerprint is in `trustedFp`.
 * Every issuer on the way must be a CA allowed to sign certificates at that depth.
 */
export async function chainTo(
  leaf: Certificate,
  pool: Certificate[],
  trustedFp: Set<string>,
): Promise<{ path: Certificate[]; trusted: boolean }> {
  const path = [leaf];
  let cur = leaf;
  for (let depth = 0; depth < 10; depth++) {
    if (trustedFp.has(await certFingerprint(cur))) return { path, trusted: true };
    if (cur.issuer.isEqual(cur.subject)) return { path, trusted: false };
    // Intermediate CA certificates below the issuer we look for (the leaf does not count).
    const below = path.length - 1;
    let next: Certificate | undefined;
    for (const c of pool) {
      if (!c.subject.isEqual(cur.issuer) || path.includes(c)) continue;
      const { ok, pathLen } = issuerConstraints(c);
      if (!ok || (pathLen !== undefined && below > pathLen)) continue;
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
