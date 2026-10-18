// Revocation checks (OCSP, CRL) for the certificates of a signature chain (FR-SIG-06). Opt-in: nothing
// here runs unless the caller passes a transport, because every request tells a server which
// certificate is being checked.
import * as asn1js from 'asn1js';
import {
  BasicOCSPResponse,
  type Certificate,
  CertificateRevocationList,
  OCSPRequest,
  OCSPResponse,
  type Extension,
} from 'pkijs';
import { ab, certDer, ensureEngine, parseCertificate } from './certs.ts';
import type { BinaryTransport } from './timestamp.ts';

export type RevocationResult = {
  state: 'good' | 'revoked' | 'unknown';
  ocsp?: Uint8Array;
  crl?: Uint8Array;
  reason?: string;
};

const OID_AIA = '1.3.6.1.5.5.7.1.1';
const OID_OCSP = '1.3.6.1.5.5.7.48.1';
const OID_CA_ISSUERS = '1.3.6.1.5.5.7.48.2';
const OID_CRL_DP = '2.5.29.31';

function urlsOf(ext: Extension | undefined, kind: 'ocsp' | 'issuers' | 'crl'): string[] {
  if (!ext) return [];
  const out: string[] = [];
  const value = ext.parsedValue as
    | {
        accessDescriptions?: Array<{ accessMethod: string; accessLocation: { type: number; value: string } }>;
        distributionPoints?: Array<{ distributionPoint?: Array<{ type: number; value: string }> }>;
      }
    | undefined;
  if (kind === 'crl') {
    for (const dp of value?.distributionPoints ?? [])
      for (const name of Array.isArray(dp.distributionPoint) ? dp.distributionPoint : [])
        if (name.type === 6 && /^https?:/i.test(name.value)) out.push(name.value);
  } else {
    const wanted = kind === 'ocsp' ? OID_OCSP : OID_CA_ISSUERS;
    for (const d of value?.accessDescriptions ?? [])
      if (
        d.accessMethod === wanted &&
        d.accessLocation.type === 6 &&
        /^https?:/i.test(d.accessLocation.value)
      )
        out.push(d.accessLocation.value);
  }
  return out;
}

export function ocspUrls(cert: Certificate): string[] {
  return urlsOf(
    cert.extensions?.find((e) => e.extnID === OID_AIA),
    'ocsp',
  );
}
export function crlUrls(cert: Certificate): string[] {
  return urlsOf(
    cert.extensions?.find((e) => e.extnID === OID_CRL_DP),
    'crl',
  );
}
export function issuerUrls(cert: Certificate): string[] {
  return urlsOf(
    cert.extensions?.find((e) => e.extnID === OID_AIA),
    'issuers',
  );
}

async function viaOcsp(
  cert: Certificate,
  issuer: Certificate,
  transport: BinaryTransport,
): Promise<RevocationResult | undefined> {
  for (const url of ocspUrls(cert)) {
    try {
      const req = new OCSPRequest();
      await req.createForCertificate(cert, { hashAlgorithm: 'SHA-256', issuerCertificate: issuer });
      const raw = await transport.request({
        url,
        method: 'POST',
        body: new Uint8Array(req.toSchema(true).toBER(false)),
        contentType: 'application/ocsp-request',
      });
      const resp = new OCSPResponse({ schema: asn1js.fromBER(ab(raw)).result });
      if (resp.responseStatus.valueBlock.valueDec !== 0 || !resp.responseBytes) continue;
      const basic = new BasicOCSPResponse({
        schema: asn1js.fromBER(
          resp.responseBytes.response.valueBlock.valueHexView.slice().buffer as ArrayBuffer,
        ).result,
      });
      if (!(await basic.verify({ trustedCerts: [issuer, ...(basic.certs ?? [])] }))) continue;
      const status = await basic.getCertificateStatus(cert, issuer);
      if (!status.isForCertificate) continue;
      return { state: status.status === 0 ? 'good' : status.status === 1 ? 'revoked' : 'unknown', ocsp: raw };
    } catch {
      /* try the next responder */
    }
  }
  return undefined;
}

async function viaCrl(
  cert: Certificate,
  issuer: Certificate,
  transport: BinaryTransport,
): Promise<RevocationResult | undefined> {
  for (const url of crlUrls(cert)) {
    try {
      const raw = await transport.request({ url, method: 'GET' });
      const crl = new CertificateRevocationList({ schema: asn1js.fromBER(ab(raw)).result });
      if (!(await crl.verify({ issuerCertificate: issuer }))) continue;
      const revoked = (crl.revokedCertificates ?? []).some((r) =>
        r.userCertificate.isEqual(cert.serialNumber),
      );
      return { state: revoked ? 'revoked' : 'good', crl: raw };
    } catch {
      /* try the next distribution point */
    }
  }
  return undefined;
}

export interface ChainRevocation {
  /** Worst state over the chain: revoked, else unknown when something could not be checked, else good. */
  state: 'good' | 'revoked' | 'unknown';
  perCertificate: Array<{ commonName: string; state: 'good' | 'revoked' | 'unknown' | 'not-needed' }>;
  /** Raw responses, for embedding as validation data (FR-SIG-08). */
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

/** Checks every certificate of `chain` (signer first) except the last one, which is the trust anchor. */
export async function checkChainRevocation(
  chain: Certificate[],
  transport: BinaryTransport,
): Promise<ChainRevocation> {
  ensureEngine();
  const per: ChainRevocation['perCertificate'] = [];
  const ocsps: Uint8Array[] = [];
  const crls: Uint8Array[] = [];
  let worst: ChainRevocation['state'] = 'good';
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    const name = String(
      cert.subject.typesAndValues.find((t) => t.type === '2.5.4.3')?.value.valueBlock.value ?? '',
    );
    const issuer = chain[i + 1];
    if (!issuer) {
      per.push({ commonName: name, state: 'not-needed' });
      continue;
    }
    const result = (await viaOcsp(cert, issuer, transport)) ??
      (await viaCrl(cert, issuer, transport)) ?? { state: 'unknown' as const };
    per.push({ commonName: name, state: result.state });
    if (result.ocsp) ocsps.push(result.ocsp);
    if (result.crl) crls.push(result.crl);
    if (result.state === 'revoked') worst = 'revoked';
    else if (result.state === 'unknown' && worst !== 'revoked') worst = 'unknown';
  }
  return { state: worst, perCertificate: per, ocsps, crls };
}

export { certDer, parseCertificate };
