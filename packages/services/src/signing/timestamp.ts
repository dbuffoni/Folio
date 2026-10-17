// RFC 3161 trusted timestamps for signatures (FR-SIG-07). The request is the only network traffic of
// the signing feature: it is built here and sent through a `TimestampTransport` only when the user turned
// timestamping on and entered an authority URL.
import * as asn1js from 'asn1js';
import {
  AlgorithmIdentifier,
  Attribute,
  Certificate,
  ContentInfo,
  MessageImprint,
  SignedAndUnsignedAttributes,
  SignedData,
  TimeStampReq,
  TimeStampResp,
  TSTInfo,
} from 'pkijs';
import { ab, commonNameOf, ensureEngine } from './certs.ts';
import { OID_TIMESTAMP_TOKEN, parseCms, sha256 } from './cms.ts';

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';

/**
 * Binary HTTP for the optional network steps of signing (timestamps, revocation checks). Platform adapters
 * implement it; nothing in Folio calls it unless the user turned the matching option on.
 */
export interface BinaryTransport {
  request(req: { url: string; method: 'GET' | 'POST'; body?: Uint8Array; contentType?: string }): Promise<Uint8Array>;
}
/** Kept for readability at call sites that only timestamp. */
export type TimestampTransport = BinaryTransport;

export interface TimestampInfo {
  /** Time the authority vouches for, ISO-8601. */
  time: string;
  /** The token's own signature verifies and its imprint matches the signature value. */
  verified: boolean;
  /** Common name of the timestamp authority certificate, when the token carries it. */
  authority?: string;
  /** The authority certificate chains to a trusted certificate. */
  trusted: boolean;
}

export class TimestampError extends Error {
  constructor(
    readonly code: 'network' | 'rejected' | 'invalid' | 'url',
    message: string,
  ) {
    super(message);
    this.name = 'TimestampError';
  }
}

export function checkAuthorityUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TimestampError('url', 'The timestamp authority address is not a valid URL');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password)
    throw new TimestampError(
      'url',
      'The timestamp authority must be an http or https address without credentials',
    );
  return u;
}

/** The value a timestamp covers is the SignatureValue of the signer (RFC 3161 §…, ETSI EN 319 142). */
export function signatureValueOf(cmsDer: Uint8Array): Uint8Array {
  const signed = parseCms(cmsDer);
  return new Uint8Array(signed.signerInfos[0]!.signature.valueBlock.valueHexView);
}

export async function requestTimestamp(
  transport: TimestampTransport,
  url: string,
  cmsDer: Uint8Array,
): Promise<Uint8Array> {
  ensureEngine();
  checkAuthorityUrl(url);
  const imprint = await sha256(signatureValueOf(cmsDer));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(8));
  nonce[0]! &= 0x7f;
  const req = new TimeStampReq({
    version: 1,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithmId: OID_SHA256, algorithmParams: new asn1js.Null() }),
      hashedMessage: new asn1js.OctetString({ valueHex: ab(imprint) }),
    }),
    nonce: new asn1js.Integer({ valueHex: ab(nonce) }),
    certReq: true,
  });
  let raw: Uint8Array;
  try {
    raw = await transport.request({ url, method: 'POST', body: new Uint8Array(req.toSchema().toBER(false)), contentType: 'application/timestamp-query' });
  } catch (e) {
    throw new TimestampError(
      'network',
      e instanceof Error ? e.message : 'The timestamp authority could not be reached',
    );
  }
  const asn1 = asn1js.fromBER(ab(raw));
  if (asn1.offset === -1)
    throw new TimestampError('invalid', 'The authority did not answer with a timestamp response');
  let resp: TimeStampResp;
  try {
    resp = new TimeStampResp({ schema: asn1.result });
  } catch {
    throw new TimestampError('invalid', 'The authority did not answer with a timestamp response');
  }
  if (resp.status.status > 1 || !resp.timeStampToken)
    throw new TimestampError('rejected', 'The timestamp authority refused the request');
  const token = new Uint8Array(resp.timeStampToken.toSchema().toBER(false));
  const info = await verifyToken(parseToken(token), signatureValueOf(cmsDer), []);
  if (!info.verified) throw new TimestampError('invalid', 'The timestamp token does not match the signature');
  return token;
}

/** Adds the token to the signer's unsigned attributes; the signed bytes, and so the signature, are untouched. */
export function addTimestamp(cmsDer: Uint8Array, token: Uint8Array): Uint8Array {
  const signed = parseCms(cmsDer);
  const tokenAsn1 = asn1js.fromBER(ab(token));
  const attr = new Attribute({ type: OID_TIMESTAMP_TOKEN, values: [tokenAsn1.result] });
  const si = signed.signerInfos[0]!;
  si.unsignedAttrs = new SignedAndUnsignedAttributes({ type: 1, attributes: [attr] });
  const info = new ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signed.toSchema(true) });
  return new Uint8Array(info.toSchema().toBER(false));
}

function parseToken(der: Uint8Array): SignedData {
  const asn1 = asn1js.fromBER(ab(der));
  const info = new ContentInfo({ schema: asn1.result });
  return new SignedData({ schema: info.content });
}

/** Bytes of an OCTET STRING, which BER may split into constructed chunks. */
function octets(os: asn1js.OctetString): Uint8Array {
  if (!os.idBlock.isConstructed) return new Uint8Array(os.valueBlock.valueHexView);
  const parts = (os.valueBlock.value as asn1js.OctetString[]).map(octets);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function verifyToken(
  token: SignedData,
  signatureValue: Uint8Array,
  trusted: Certificate[],
): Promise<TimestampInfo & { ok: boolean }> {
  const expectedImprint = await sha256(signatureValue);
  const content = token.encapContentInfo.eContent;
  if (!content) return { ok: false, time: '', verified: false, trusted: false };
  // pkijs reads eContent as one primitive chunk; some authorities (and BER encoders) split it.
  token.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: ab(octets(content)) });
  const tstAsn1 = asn1js.fromBER(octets(content).slice().buffer as ArrayBuffer);
  const tst = new TSTInfo({ schema: tstAsn1.result });
  const imprint = new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView);
  const matches =
    imprint.length === expectedImprint.length && imprint.every((b, i) => b === expectedImprint[i]);
  let signatureOk = false;
  let authority: Certificate | undefined;
  try {
    const certs = (token.certificates ?? []).filter((c): c is Certificate => c instanceof Certificate);
    authority = certs[0];
    const res = await token.verify({ signer: 0, data: ab(signatureValue), trustedCerts: certs, checkChain: false, extendedMode: true });
    signatureOk = !!res.signatureVerified;
  } catch {
    signatureOk = false;
  }
  let isTrusted = false;
  if (authority) {
    for (const t of trusted) {
      try {
        if (
          t.subject.isEqual(authority.subject)
            ? t.serialNumber.isEqual(authority.serialNumber)
            : await authority.verify(t)
        )
          isTrusted = true;
      } catch {
        /* not this one */
      }
    }
  }
  return {
    ok: matches && signatureOk,
    time: tst.genTime.toISOString(),
    verified: matches && signatureOk,
    authority: authority ? commonNameOf(authority.subject) : undefined,
    trusted: isTrusted,
  };
}

/** Reads and checks the timestamp token attached to the first signer of `signed`, if any. */
export async function verifyTimestampToken(
  signed: SignedData,
  trusted: Certificate[],
): Promise<TimestampInfo | undefined> {
  const si = signed.signerInfos[0];
  const attr = si?.unsignedAttrs?.attributes.find((a) => a.type === OID_TIMESTAMP_TOKEN);
  if (!si || !attr) return undefined;
  const tokenInfo = new ContentInfo({ schema: attr.values[0]! });
  const token = new SignedData({ schema: tokenInfo.content });
  const { ok, ...info } = await verifyToken(token, new Uint8Array(si.signature.valueBlock.valueHexView), trusted);
  void ok;
  return info;
}
