// CMS (RFC 5652) detached signatures for PDF: PAdES-B-B profile, and the checks that go with it.
import * as asn1js from 'asn1js';
import {
  Attribute,
  ContentInfo,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
  Certificate,
  getCrypto,
} from 'pkijs';
import { ab, certDer, ensureEngine, type SigningIdentity } from './certs.ts';

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_DATA = '1.2.840.113549.1.7.1';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_CERT_V2 = '1.2.840.113549.1.9.16.2.47';
export const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';

/** signing-certificate-v2 attribute (RFC 5035) binding the signature to the signer certificate. */
async function signingCertificateV2(cert: Certificate): Promise<Attribute> {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', ab(certDer(cert))));
  // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm DEFAULT sha256 (omitted), certHash OCTET STRING }
  const essCertId = new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: ab(hash) })] });
  const value = new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertId] })] });
  return new Attribute({ type: OID_SIGNING_CERT_V2, values: [value] });
}

export interface CmsOptions {
  /** Embed the whole chain the identity carries (default) or only the signer certificate. */
  includeChain?: boolean;
  /** Unsigned attribute: an RFC 3161 token (DER ContentInfo), added later by `addTimestamp`. */
  signingTime?: Date;
}

/** Digest of `data` with SHA-256. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', ab(data)));
}

/** Detached CMS SignedData over `data` (the PDF byte ranges), DER encoded. */
export async function signDetached(
  data: Uint8Array,
  identity: SigningIdentity,
  opts: CmsOptions = {},
): Promise<Uint8Array> {
  ensureEngine();
  const signer = identity.certificates[0]!;
  const digest = await sha256(data);
  const signedAttrs = new SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new Attribute({ type: OID_CONTENT_TYPE, values: [new asn1js.ObjectIdentifier({ value: OID_DATA })] }),
      new Attribute({
        type: '1.2.840.113549.1.9.5',
        values: [new asn1js.UTCTime({ valueDate: opts.signingTime ?? new Date() })],
      }),
      new Attribute({ type: OID_MESSAGE_DIGEST, values: [new asn1js.OctetString({ valueHex: ab(digest) })] }),
      await signingCertificateV2(signer),
    ],
  });
  const signed = new SignedData({
    version: 1,
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: OID_DATA }),
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({ issuer: signer.issuer, serialNumber: signer.serialNumber }),
        signedAttrs,
      }),
    ],
    certificates: opts.includeChain === false ? [signer] : identity.certificates,
  });
  await signed.sign(identity.privateKey, 0, 'SHA-256', ab(data));
  const info = new ContentInfo({ contentType: OID_SIGNED_DATA, content: signed.toSchema(true) });
  return new Uint8Array(info.toSchema().toBER(false));
}

export type CmsStatus =
  | { ok: true; signer: Certificate; certificates: Certificate[]; signingTime?: Date; digestOk: true }
  | { ok: false; reason: 'malformed' | 'digest-mismatch' | 'bad-signature' | 'unsupported'; message: string };

/** Parses a detached CMS blob. Trailing zero padding (the unused part of the PDF placeholder) is ignored. */
export function parseCms(der: Uint8Array): SignedData {
  ensureEngine();
  const asn1 = asn1js.fromBER(ab(der));
  if (asn1.offset === -1) throw new Error('not DER');
  const info = new ContentInfo({ schema: asn1.result });
  if (info.contentType !== OID_SIGNED_DATA) throw new Error('not SignedData');
  return new SignedData({ schema: info.content });
}

/** Verifies digest and signature of the first signer; trust is decided elsewhere. */
export async function verifyDetached(cmsDer: Uint8Array, data: Uint8Array): Promise<CmsStatus> {
  let signed: SignedData;
  try {
    signed = parseCms(cmsDer);
  } catch (e) {
    return { ok: false, reason: 'malformed', message: e instanceof Error ? e.message : 'malformed' };
  }
  const certificates = (signed.certificates ?? []).filter((c): c is Certificate => c instanceof Certificate);
  if (!signed.signerInfos.length || !certificates.length)
    return { ok: false, reason: 'malformed', message: 'no signer certificate' };
  const sid = signed.signerInfos[0]!.sid;
  const signer =
    certificates.find(
      (c) =>
        sid instanceof IssuerAndSerialNumber &&
        c.issuer.isEqual(sid.issuer) &&
        c.serialNumber.isEqual(sid.serialNumber),
    ) ?? certificates[0]!;
  try {
    const res = await signed.verify({
      signer: 0,
      data: ab(data),
      trustedCerts: [signer],
      checkChain: false,
      extendedMode: true,
    });
    if (res.signatureVerified) {
      const when = signed.signerInfos[0]!.signedAttrs?.attributes.find(
        (a) => a.type === '1.2.840.113549.1.9.5',
      )?.values[0] as asn1js.UTCTime | asn1js.GeneralizedTime | undefined;
      return { ok: true, signer, certificates, signingTime: when?.toDate(), digestOk: true };
    }
    const msg = res.message ?? '';
    return {
      ok: false,
      reason: /message digest/i.test(msg) ? 'digest-mismatch' : 'bad-signature',
      message: msg,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: /message digest|messageDigest/i.test(msg)
        ? 'digest-mismatch'
        : /unsupported|algorithm/i.test(msg)
          ? 'unsupported'
          : 'bad-signature',
      message: msg,
    };
  }
}

export { getCrypto };
