// Attacks on signature validation found in the 0.1.3 review (R11-R14) and the revocation check on signing.
import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import {
  Attribute,
  BasicConstraints,
  ContentInfo,
  EncapsulatedContentInfo,
  Extension,
  IssuerAndSerialNumber,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
  TimeStampResp,
  type Certificate,
} from 'pkijs';
import {
  FakeRevocationServer,
  FakeTimestampAuthority,
  identityOf,
  makeCertificate,
  opensslPkcs12,
  pki,
  textDoc,
  type TestCert,
} from '@folio/testkit';
import {
  CertificateError,
  SigningError,
  certDer,
  openPkcs12,
  signPdf,
  validateSignatures,
  verifyDetached,
  type BinaryTransport,
} from './index.ts';

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const buf = (u: Uint8Array) => u.slice().buffer as ArrayBuffer;
const day = 24 * 3600e3;
const TS_EKU = '1.3.6.1.5.5.7.3.8';

/** Byte range of the only signature of `pdf` and the bytes it covers. */
function signedPart(pdf: Uint8Array): { b: number; c: number; data: Uint8Array } {
  const m = /\/ByteRange\s*\[\s*0 (\d+) (\d+) (\d+)\s*\]/.exec(latin1(pdf))!;
  const [b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const data = new Uint8Array(b + d);
  data.set(pdf.subarray(0, b), 0);
  data.set(pdf.subarray(c, c + d), b);
  return { b, c, data };
}

/** Writes `text` over the signature gap (between the ByteRange parts), keeping its length. */
function writeGap(pdf: Uint8Array, text: string): Uint8Array {
  const { b, c } = signedPart(pdf);
  expect(text.length).toBe(c - b);
  const out = pdf.slice();
  out.set(new TextEncoder().encode(text), b);
  return out;
}

/** Puts `cms` in the /Contents placeholder of an already signed file, zero padded. */
function replaceContents(pdf: Uint8Array, cms: Uint8Array): Uint8Array {
  const { b, c } = signedPart(pdf);
  return writeGap(pdf, `<${hex(cms).padEnd(c - b - 2, '0')}>`);
}

/** CMS signed with `key`, naming the signer by `sid`, carrying `certificates` in the given order. */
async function forgedCms(
  data: Uint8Array,
  key: CryptoKey,
  sid: SignerInfo['sid'],
  certificates: Certificate[],
): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(data)));
  const signedAttrs = new SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })] }),
      new Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: buf(digest) })] }),
    ],
  });
  const signed = new SignedData({
    version: 1,
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }),
    signerInfos: [new SignerInfo({ version: 3, sid, signedAttrs })],
    certificates,
  });
  await signed.sign(key, 0, 'SHA-256', buf(data));
  const info = new ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signed.toSchema(true) });
  return new Uint8Array(info.toSchema().toBER(false));
}

/** [0] subjectKeyIdentifier the way RFC 5652 encodes it (SHA-1 of the public key, RFC 5280 method 1). */
async function keyIdSid(cert: Certificate): Promise<asn1js.Primitive> {
  const keyId = await crypto.subtle.digest(
    'SHA-1',
    buf(new Uint8Array(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)),
  );
  return new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: keyId });
}

/** Re-signs `cert` after changing it (extensions, serial). */
async function resign(cert: TestCert, signer: TestCert, edit: (c: Certificate) => void): Promise<TestCert> {
  edit(cert.certificate);
  await cert.certificate.sign(signer.privateKey, 'SHA-256');
  return cert;
}
const basicConstraints = (cA: boolean, pathLenConstraint?: number) =>
  new Extension({
    extnID: '2.5.29.19',
    critical: true,
    extnValue: new BasicConstraints(pathLenConstraint === undefined ? { cA } : { cA, pathLenConstraint })
      .toSchema()
      .toBER(false),
  });

describe('Signer certificate substitution (R11) @FR-SIG-04 @FR-SIG-05', () => {
  it('reports the certificate the signature was verified with, not the first one embedded @FR-SIG-04 @FR-SIG-05', async () => {
    const alice = await pki({ cn: 'Alice' });
    const mallory = await makeCertificate({ cn: 'Mallory' });
    const placeholder = await signPdf(await textDoc({ pages: 1 }), { identity: await identityOf(mallory) });
    const { data } = signedPart(placeholder);
    // Mallory signs with her own key, names herself by key identifier and puts Alice's certificate first.
    const cms = await forgedCms(data, mallory.privateKey, await keyIdSid(mallory.certificate), [
      alice.leaf.certificate,
      mallory.certificate,
    ]);
    const forged = replaceContents(placeholder, cms);
    const [r] = await validateSignatures(forged, { trusted: [certDer(alice.root.certificate)] });
    expect(r!.integrity).toBe('ok');
    expect(r!.signer?.commonName).toBe('Mallory');
    expect(r).toMatchObject({ status: 'valid-untrusted', trust: 'untrusted', chainComplete: false });
    expect(r!.signerDer).toEqual(certDer(mallory.certificate));
  });

  it('a signer identifier that names no embedded certificate is malformed @FR-SIG-04', async () => {
    const alice = await pki({ cn: 'Alice' });
    const mallory = await makeCertificate({ cn: 'Mallory' });
    const data = new TextEncoder().encode('the signed bytes');
    for (const sid of [
      await keyIdSid(mallory.certificate),
      new IssuerAndSerialNumber({ issuer: mallory.certificate.issuer, serialNumber: mallory.certificate.serialNumber }),
    ]) {
      const cms = await forgedCms(data, mallory.privateKey, sid, [alice.leaf.certificate]);
      expect(await verifyDetached(cms, data)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });
});

describe('Timestamp authority certificate (R12) @FR-SIG-07', () => {
  /** A certificate that expires in two days, signed with a token stamped now, judged ten days later. */
  async function expiredButStamped(
    authority: TestCert,
    rewrite: (raw: Uint8Array) => Uint8Array = (raw) => raw,
  ) {
    const signer = await pki({ notBefore: new Date(Date.now() - 30 * day), notAfter: new Date(Date.now() + 2 * day) });
    const fake = new FakeTimestampAuthority(authority, [], new Date());
    const transport: BinaryTransport = { request: async (r) => rewrite(await fake.request(r)) };
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity: signer.identity,
      timestamp: { url: 'https://tsa.example', transport },
    });
    return { signed, root: signer.root, later: new Date(Date.now() + 10 * day) };
  }

  it('takes the authority from the certificate that signed the token, not the first one embedded @FR-SIG-07 @FR-SIG-05', async () => {
    const tsaRoot = await makeCertificate({ cn: 'Real TSA Root', ca: true });
    const realTsa = await makeCertificate({ cn: 'Real TSA', issuer: tsaRoot, keyUsage: ['digitalSignature'], extKeyUsage: [TS_EKU] });
    const evil = await makeCertificate({ cn: 'Evil TSA', keyUsage: ['digitalSignature'], extKeyUsage: [TS_EKU] });
    // The certificate list of the token is not signed: put the real authority first.
    const { signed, root, later } = await expiredButStamped(evil, (raw) => {
      const resp = new TimeStampResp({ schema: asn1js.fromBER(buf(raw)).result });
      const token = new SignedData({ schema: resp.timeStampToken!.content });
      token.certificates = [realTsa.certificate, evil.certificate];
      resp.timeStampToken = new ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: token.toSchema(true) });
      return new Uint8Array(resp.toSchema().toBER(false));
    });
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(root.certificate), certDer(tsaRoot.certificate)],
      now: later,
    });
    expect(r!.timestamp).toMatchObject({ verified: true, trusted: false, authority: 'Evil TSA' });
    expect(r!.trust).toBe('expired');
  });

  it('an authority that only copies the subject and serial of a trusted one is not trusted @FR-SIG-07 @FR-SIG-05', async () => {
    const real = await makeCertificate({ cn: 'Test TSA', keyUsage: ['digitalSignature'], extKeyUsage: [TS_EKU] });
    const clone = await makeCertificate({ cn: 'Test TSA', keyUsage: ['digitalSignature'], extKeyUsage: [TS_EKU] });
    await resign(clone, clone, (c) => (c.serialNumber = real.certificate.serialNumber));
    const { signed, root, later } = await expiredButStamped(clone);
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(root.certificate), certDer(real.certificate)],
      now: later,
    });
    expect(r!.timestamp).toMatchObject({ verified: true, trusted: false });
    expect(r!.trust).toBe('expired');
  });

  it('an authority trusted by fingerprint is trusted @FR-SIG-07', async () => {
    const tsa = await makeCertificate({ cn: 'Test TSA', keyUsage: ['digitalSignature'], extKeyUsage: [TS_EKU] });
    const { signed, root, later } = await expiredButStamped(tsa);
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(root.certificate), certDer(tsa.certificate)],
      now: later,
    });
    expect(r!.timestamp).toMatchObject({ verified: true, trusted: true, authority: 'Test TSA' });
    expect(r!.trust).toBe('trusted');
  });

  it('an authority certificate without the timeStamping usage is not trusted @FR-SIG-07', async () => {
    const tsaRoot = await makeCertificate({ cn: 'TSA Root', ca: true });
    const tsa = await makeCertificate({ cn: 'Not a TSA', issuer: tsaRoot, keyUsage: ['digitalSignature'] });
    const { signed, root, later } = await expiredButStamped(tsa);
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(root.certificate), certDer(tsaRoot.certificate)],
      now: later,
    });
    expect(r!.timestamp).toMatchObject({ trusted: false });
    expect(r!.trust).toBe('expired');
  });
});

describe('Signature value in the ByteRange gap (R13) @FR-SIG-04', () => {
  it('unsigned bytes hidden in the padding of the placeholder make the signature malformed @FR-SIG-04', async () => {
    const { root, identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const gap = latin1(signed).slice(signedPart(signed).b, signedPart(signed).c);
    const hidden = gap.slice(0, -9) + 'deadbeef>';
    const [r] = await validateSignatures(writeGap(signed, hidden), { trusted: [certDer(root.certificate)] });
    expect(r).toMatchObject({ integrity: 'malformed', status: 'unknown' });
  });

  it('a gap that is not exactly one hex string is malformed @FR-SIG-04', async () => {
    const { root, identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const gap = latin1(signed).slice(signedPart(signed).b, signedPart(signed).c);
    for (const bad of [
      gap.slice(0, -3) + ' 0>', // whitespace hides nothing but is not the plain hex value
      gap.slice(0, -3) + 'zz>', // not hex
    ]) {
      const [r] = await validateSignatures(writeGap(signed, bad), { trusted: [certDer(root.certificate)] });
      expect(r).toMatchObject({ integrity: 'malformed', status: 'unknown' });
    }
  });

  it('a well-formed signature still validates @FR-SIG-04', async () => {
    const { root, identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    expect((await validateSignatures(signed, { trusted: [certDer(root.certificate)] }))[0]).toMatchObject({
      integrity: 'ok',
      status: 'valid',
    });
  });
});

describe('Certificate path constraints (R14) @FR-SIG-04 @FR-SIG-05', () => {
  const signWith = async (leaf: TestCert, ...chain: TestCert[]) =>
    signPdf(await textDoc({ pages: 1 }), { identity: await identityOf(leaf, ...chain) });

  it('a trusted end-entity certificate cannot vouch for certificates it issued @FR-SIG-05', async () => {
    const bob = await makeCertificate({ cn: 'Bob' });
    const mallory = await makeCertificate({ cn: 'Alice (forged)', issuer: bob });
    const [r] = await validateSignatures(await signWith(mallory, bob), { trusted: [certDer(bob.certificate)] });
    expect(r).toMatchObject({ status: 'valid-untrusted', trust: 'untrusted', chainComplete: false });
  });

  it('an issuer without the keyCertSign usage breaks the chain @FR-SIG-05', async () => {
    const ca = await makeCertificate({ cn: 'Odd CA', ca: true, keyUsage: ['digitalSignature', 'cRLSign'] });
    const leaf = await makeCertificate({ cn: 'Ada', issuer: ca });
    const [r] = await validateSignatures(await signWith(leaf, ca), { trusted: [certDer(ca.certificate)] });
    expect(r).toMatchObject({ status: 'valid-untrusted', chainComplete: false });
  });

  it('respects pathLenConstraint, and accepts intermediates within it @FR-SIG-04 @FR-SIG-05', async () => {
    for (const [pathLen, expected] of [
      [0, 'valid-untrusted'],
      [1, 'valid'],
    ] as const) {
      const root = await makeCertificate({ cn: 'Root', ca: true });
      const sub = await makeCertificate({ cn: 'Intermediate', ca: true, issuer: root });
      const leaf = await makeCertificate({ cn: 'Ada', issuer: sub });
      await resign(root, root, (c) => {
        c.extensions = [basicConstraints(true, pathLen), ...c.extensions!.filter((e) => e.extnID !== '2.5.29.19')];
      });
      const [r] = await validateSignatures(await signWith(leaf, sub, root), { trusted: [certDer(root.certificate)] });
      expect(r!.status).toBe(expected);
    }
  });
});

describe('Revocation check when signing @FR-SIG-06', () => {
  const OCSP = 'http://ocsp.example/check';
  const CRL = 'http://crl.example/root.crl';

  it('refuses a revoked certificate, and otherwise signs without embedding validation data @FR-SIG-06', async () => {
    const root = await makeCertificate({ cn: 'Folio Test Root CA', ca: true });
    const leaf = await makeCertificate({ cn: 'Ada Lovelace', issuer: root, ocspUrl: OCSP, crlUrl: CRL });
    const identity = await identityOf(leaf, root);
    const server = new FakeRevocationServer(root, OCSP, CRL);
    const pdf = await textDoc({ pages: 1 });
    const signed = await signPdf(pdf, { identity, revocationCheck: server });
    expect(server.requests).toEqual([`POST ${OCSP}`]);
    expect(latin1(signed)).not.toMatch(/\/DSS/);
    expect((await validateSignatures(signed, { trusted: [certDer(root.certificate)] }))[0]).toMatchObject({
      status: 'valid',
      changedAfterSigning: false,
    });
    server.revoked.add(hex(new Uint8Array(leaf.certificate.serialNumber.valueBlock.valueHexView)));
    await expect(signPdf(pdf, { identity, revocationCheck: server })).rejects.toMatchObject({ code: 'revoked' });
  });
});

describe('Damaged input is reported, never thrown raw (coverage findings) @FR-SIG-01 @FR-SIG-03 @FR-SIG-04 @FR-CRT-01', () => {
  it('artwork that is not a PNG is a typed signing error @FR-SIG-03', async () => {
    const { identity } = await pki();
    const err = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      appearance: {
        page: 0,
        rect: { x: 20, y: 20, width: 100, height: 40 },
        lines: ['x'],
        image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SigningError);
    expect(err).toMatchObject({ code: 'bad-image' });
  });

  it('an out-of-range /M date gives no signing time instead of an invalid one @FR-SIG-04', async () => {
    const { identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity, signingTime: new Date('2026-04-02T08:30:00Z') });
    const start = latin1(signed).search(/\/M \(D:/) + 4;
    for (const bad of ['D:20261340083000Z', 'D:20260231083000Z', 'D:20260402256100Z']) {
      const copy = signed.slice();
      copy.set(new TextEncoder().encode(bad), start);
      const [r] = await validateSignatures(copy);
      expect(r!.integrity, bad).toBe('tampered');
      expect(r!.signingTime, bad).toBeUndefined();
    }
  });

  it('a /ByteRange that is not four numbers reports the signature as malformed @FR-SIG-04', async () => {
    const { identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const at = latin1(signed).indexOf('/ByteRange [0 ') + '/ByteRange ['.length;
    const copy = signed.slice();
    copy.set(new TextEncoder().encode('/a'), at);
    const reports = await validateSignatures(copy);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ integrity: 'malformed', status: 'unknown' });
  });

  it('a secp256k1 key is unsupported, not a wrong password @FR-CRT-01', async () => {
    const { p12 } = await opensslPkcs12({ cn: 'k', password: 'pw', curve: 'secp256k1' });
    const err = await openPkcs12(p12, 'pw').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CertificateError);
    expect(err).toMatchObject({ code: 'unsupported' });
  });
});
