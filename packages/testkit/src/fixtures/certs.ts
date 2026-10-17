// Deterministic-enough X.509 builders for signing tests: roots, intermediates, leaves, RSA or ECDSA.
import * as asn1js from 'asn1js';
import { AccessDescription, AttributeTypeAndValue, BasicConstraints, BasicOCSPResponse, CertID, CertificateRevocationList, CRLDistributionPoints, DistributionPoint, GeneralName, InfoAccess, OCSPRequest, OCSPResponse, ResponseBytes, ResponseData, RevokedCertificate, SingleResponse, Certificate, ContentInfo, EncapsulatedContentInfo, Extension, IssuerAndSerialNumber, MessageImprint, PKIStatusInfo, SignedData, SignerInfo, TimeStampReq, TimeStampResp, TSTInfo, Time, getCrypto } from 'pkijs';
import { describeCertificate, ensureEngine, type SigningIdentity, type TimestampTransport } from '@folio/services';

export interface TestCert {
  certificate: Certificate;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  ec?: 'P-256' | 'P-384';
}

export interface CertSpec {
  cn: string;
  /** Signs the certificate; absent = self-signed. */
  issuer?: TestCert;
  ca?: boolean;
  ec?: 'P-256' | 'P-384';
  notBefore?: Date;
  notAfter?: Date;
  /** Key usage bit names to assert; default digitalSignature + nonRepudiation for leaves, keyCertSign for CAs. */
  keyUsage?: Array<'digitalSignature' | 'nonRepudiation' | 'keyCertSign' | 'cRLSign'>;
  /** Extended key usage OIDs, e.g. '1.3.6.1.5.5.7.3.8' (timeStamping). */
  extKeyUsage?: string[];
  /** AIA OCSP responder and CRL distribution point written into the certificate. */
  ocspUrl?: string;
  crlUrl?: string;
}

const KU_BITS = { digitalSignature: 0, nonRepudiation: 1, keyCertSign: 5, cRLSign: 6 } as const;
let serial = 1000;

export async function makeCertificate(spec: CertSpec): Promise<TestCert> {
  ensureEngine();
  const subtle = getCrypto(true).subtle;
  const keys = (await (spec.ec
    ? subtle.generateKey({ name: 'ECDSA', namedCurve: spec.ec }, true, ['sign', 'verify'])
    : subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']))) as CryptoKeyPair;
  const cert = new Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: ++serial });
  const name = (target: Certificate['subject'], cn: string) => target.typesAndValues.push(new AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) }));
  name(cert.subject, spec.cn);
  if (spec.issuer) cert.issuer = spec.issuer.certificate.subject;
  else name(cert.issuer, spec.cn);
  const now = Date.now();
  cert.notBefore.value = spec.notBefore ?? new Date(now - 24 * 3600e3);
  cert.notAfter.value = spec.notAfter ?? new Date(now + 365 * 24 * 3600e3);
  const usage = spec.keyUsage ?? (spec.ca ? ['keyCertSign', 'cRLSign'] : ['digitalSignature', 'nonRepudiation']);
  let bits = 0;
  for (const u of usage) bits |= 0x80 >> KU_BITS[u];
  const kuValue = new asn1js.BitString({ valueHex: new Uint8Array([bits]).buffer as ArrayBuffer, unusedBits: 1 });
  cert.extensions = [
    new Extension({ extnID: '2.5.29.19', critical: true, extnValue: new BasicConstraints({ cA: !!spec.ca }).toSchema().toBER(false) }),
    new Extension({ extnID: '2.5.29.15', critical: true, extnValue: kuValue.toBER(false) }),
  ];
  if (spec.extKeyUsage?.length) {
    cert.extensions.push(new Extension({ extnID: '2.5.29.37', critical: true, extnValue: new asn1js.Sequence({ value: spec.extKeyUsage.map((v) => new asn1js.ObjectIdentifier({ value: v })) }).toBER(false) }));
  }
  if (spec.ocspUrl) {
    cert.extensions.push(new Extension({ extnID: '1.3.6.1.5.5.7.1.1', critical: false, extnValue: new InfoAccess({ accessDescriptions: [new AccessDescription({ accessMethod: '1.3.6.1.5.5.7.48.1', accessLocation: new GeneralName({ type: 6, value: spec.ocspUrl }) })] }).toSchema().toBER(false) }));
  }
  if (spec.crlUrl) {
    cert.extensions.push(new Extension({ extnID: '2.5.29.31', critical: false, extnValue: new CRLDistributionPoints({ distributionPoints: [new DistributionPoint({ distributionPoint: [new GeneralName({ type: 6, value: spec.crlUrl })] })] }).toSchema().toBER(false) }));
  }
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign((spec.issuer ?? { privateKey: keys.privateKey }).privateKey, 'SHA-256');
  return { certificate: cert, privateKey: keys.privateKey, publicKey: keys.publicKey, ec: spec.ec };
}

/** A signing identity for `leaf`, carrying `chain` (intermediates, root) after it. */
export async function identityOf(leaf: TestCert, ...chain: TestCert[]): Promise<SigningIdentity> {
  return { certificates: [leaf.certificate, ...chain.map((c) => c.certificate)], privateKey: leaf.privateKey, info: await describeCertificate(leaf.certificate) };
}

/** Root → leaf, ready to sign with; returns the pieces so tests can trust the root. */
export async function pki(opts: { cn?: string; ec?: 'P-256' | 'P-384'; notBefore?: Date; notAfter?: Date } = {}): Promise<{ root: TestCert; leaf: TestCert; identity: SigningIdentity }> {
  const root = await makeCertificate({ cn: 'Folio Test Root CA', ca: true });
  const leaf = await makeCertificate({ cn: opts.cn ?? 'Ada Lovelace', issuer: root, ec: opts.ec, notBefore: opts.notBefore, notAfter: opts.notAfter });
  return { root, leaf, identity: await identityOf(leaf, root) };
}

/** An in-process RFC 3161 authority for tests; counts requests so tests can prove nothing was sent. */
export class FakeTimestampAuthority implements TimestampTransport {
  requests = 0;
  readonly urls: string[] = [];
  /** Set to make the next request fail or be refused. */
  mode: 'ok' | 'network' | 'refuse' | 'garbage' | 'wrong-imprint' = 'ok';
  constructor(
    readonly authority: TestCert,
    readonly chain: TestCert[] = [],
    readonly time: Date = new Date(),
  ) {}

  async request({ url, body }: { url: string; method: 'GET' | 'POST'; body?: Uint8Array }): Promise<Uint8Array> {
    this.requests++;
    this.urls.push(url);
    if (this.mode === 'network') throw new Error('connection refused');
    if (this.mode === 'garbage') return new TextEncoder().encode('not asn1');
    const req = new TimeStampReq({ schema: asn1js.fromBER(body!.slice().buffer as ArrayBuffer).result });
    if (this.mode === 'refuse') return new Uint8Array(new TimeStampResp({ status: new PKIStatusInfo({ status: 2 }) }).toSchema().toBER(false));
    const imprint = req.messageImprint;
    const tst = new TSTInfo({
      version: 1,
      policy: '1.2.3.4.1',
      messageImprint: this.mode === 'wrong-imprint' ? new MessageImprint({ hashAlgorithm: imprint.hashAlgorithm, hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(32).buffer as ArrayBuffer }) }) : imprint,
      serialNumber: new asn1js.Integer({ value: ++serial }),
      genTime: this.time,
      nonce: req.nonce,
    });
    const signed = new SignedData({
      version: 3,
      encapContentInfo: new EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.9.16.1.4', eContent: new asn1js.OctetString({ valueHex: tst.toSchema().toBER(false) }) }),
      signerInfos: [new SignerInfo({ version: 1, sid: new IssuerAndSerialNumber({ issuer: this.authority.certificate.issuer, serialNumber: this.authority.certificate.serialNumber }) })],
      certificates: [this.authority.certificate, ...this.chain.map((c) => c.certificate)],
    });
    await signed.sign(this.authority.privateKey, 0, 'SHA-256');
    const token = new ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signed.toSchema(true) });
    return new Uint8Array(new TimeStampResp({ status: new PKIStatusInfo({ status: 0 }), timeStampToken: token }).toSchema().toBER(false));
  }
}

/** An in-process OCSP responder and CRL publisher for one issuing certificate. */
export class FakeRevocationServer implements TimestampTransport {
  readonly requests: string[] = [];
  /** Serial numbers (hex) reported as revoked. */
  readonly revoked = new Set<string>();
  /** 'down' answers every request with an error; 'good-only-crl' makes the OCSP URL fail so the CRL is used. */
  mode: 'ok' | 'down' | 'ocsp-fails' = 'ok';
  constructor(
    readonly issuer: TestCert,
    readonly ocspUrl: string,
    readonly crlUrl: string,
  ) {}

  async request({ url, method, body }: { url: string; method: 'GET' | 'POST'; body?: Uint8Array }): Promise<Uint8Array> {
    this.requests.push(`${method} ${url}`);
    if (this.mode === 'down') throw new Error('server down');
    if (url === this.ocspUrl) {
      if (this.mode === 'ocsp-fails') throw new Error('responder down');
      const req = new OCSPRequest({ schema: asn1js.fromBER(body!.slice().buffer as ArrayBuffer).result });
      const id = req.tbsRequest.requestList[0]!.reqCert;
      const hex = Array.from(new Uint8Array(id.serialNumber.valueBlock.valueHexView), (b) => b.toString(16).padStart(2, '0')).join('');
      const revoked = this.revoked.has(hex);
      const single = new SingleResponse({
        certID: id,
        certStatus: revoked ? new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: [new asn1js.GeneralizedTime({ valueDate: new Date() })] }) : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: new ArrayBuffer(0) }),
        thisUpdate: new Date(),
      });
      const basic = new BasicOCSPResponse({
        tbsResponseData: new ResponseData({ responderID: this.issuer.certificate.subject, producedAt: new Date(), responses: [single] }),
        certs: [this.issuer.certificate],
      });
      await basic.sign(this.issuer.privateKey, 'SHA-256');
      const resp = new OCSPResponse({ responseStatus: new asn1js.Enumerated({ value: 0 }), responseBytes: new ResponseBytes({ responseType: '1.3.6.1.5.5.7.48.1.1', response: new asn1js.OctetString({ valueHex: basic.toSchema().toBER(false) }) }) });
      return new Uint8Array(resp.toSchema().toBER(false));
    }
    if (url === this.crlUrl) {
      const crl = new CertificateRevocationList({ issuer: this.issuer.certificate.subject, thisUpdate: new Time({ value: new Date(Date.now() - 3600e3) }), nextUpdate: new Time({ value: new Date(Date.now() + 86400e3) }), revokedCertificates: [] });
      for (const hex of this.revoked) crl.revokedCertificates!.push(new RevokedCertificate({ userCertificate: new asn1js.Integer({ valueHex: Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16)).buffer }), revocationDate: new Time({ value: new Date() }) }));
      await crl.sign(this.issuer.privateKey, 'SHA-256');
      return new Uint8Array(crl.toSchema(true).toBER(false));
    }
    throw new Error(`unexpected URL ${url}`);
  }
}
