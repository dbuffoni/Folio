import { describe, expect, it } from 'vitest';
import {
  FakeRevocationServer,
  FakeTimestampAuthority,
  makeCertificate,
  identityOf,
  opensslPkcs12,
  withPdfsig,
  pdftoppm,
  pki,
  qpdfCheck,
  sharedEngine,
  textDoc,
  signedDoc,
} from '@folio/testkit';
import {
  CertificateError,
  SigningError,
  certDer,
  describeCertificate,
  listSignatureFields,
  openPkcs12,
  parseCertificates,
  requestTimestamp,
  signDetached,
  signPdf,
  validateSignatures,
  verifyDetached,
  TimestampError,
} from './index.ts';

const bytesOf = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const startsWith = (big: Uint8Array, prefix: Uint8Array) => prefix.every((v, i) => big[i] === v);

describe('Certificates @FR-CRT-01 @FR-CRT-02 @FR-CRT-03', () => {
  it('opens RSA and ECDSA PKCS#12 files made by OpenSSL and describes the signer @FR-CRT-01', async () => {
    // openssl.exe reads command-line arguments in the ANSI code page, so a non-ASCII password cannot be passed on Windows.
    const password = process.platform === 'win32' ? 'password-1' : 'pässword-1';
    for (const ec of [false, true]) {
      const { p12 } = await opensslPkcs12({
        cn: ec ? 'Grace Hopper' : 'Ada Lovelace',
        password,
        ec,
      });
      const id = await openPkcs12(p12, password);
      expect(id.info.commonName).toBe(ec ? 'Grace Hopper' : 'Ada Lovelace');
      expect(id.info.keyAlgorithm).toBe(ec ? 'ECDSA-P256' : 'RSA');
      expect(id.info.keyUsage).toEqual(['digitalSignature', 'nonRepudiation']);
      expect(id.info.selfSigned).toBe(true);
      expect(id.info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(id.privateKey.extractable).toBe(false);
      // The imported key really signs: a CMS over some bytes verifies.
      const data = bytesOf('hello');
      expect((await verifyDetached(await signDetached(data, id), data)).ok).toBe(true);
    }
  });

  it('reports a wrong password, garbage and a missing key distinctly @FR-CRT-01', async () => {
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'right' });
    await expect(openPkcs12(p12, 'wrong')).rejects.toMatchObject({ code: 'bad-password' });
    await expect(openPkcs12(bytesOf('not a pfx'), 'x')).rejects.toBeInstanceOf(CertificateError);
    await expect(openPkcs12(bytesOf('not a pfx'), 'x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reads DER and PEM certificates, one or several @FR-CRT-02', async () => {
    const { root, leaf } = await pki();
    const der = certDer(leaf.certificate);
    expect(parseCertificates(der)).toHaveLength(1);
    const pem = (c: Uint8Array) =>
      `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...c)).replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
    expect(parseCertificates(bytesOf(pem(der) + pem(certDer(root.certificate))))).toHaveLength(2);
    expect(() =>
      parseCertificates(bytesOf('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----')),
    ).toThrow(CertificateError);
    expect(() => parseCertificates(bytesOf('garbage'))).toThrow(CertificateError);
    const info = await describeCertificate(root.certificate);
    expect(info).toMatchObject({ commonName: 'Folio Test Root CA', isCa: true, selfSigned: true });
    expect(info.keyUsage).toEqual(['keyCertSign', 'cRLSign']);
  });
});

describe('Signing @FR-SIG-01 @FR-SIG-02 @FR-SIG-03', () => {
  it('signs as a PAdES incremental update that independent tools accept @FR-SIG-01', async () => {
    const { identity } = await pki({ cn: 'Ada Lovelace' });
    const pdf = await textDoc({ pages: 2, title: 'Contract' });
    const signed = await signPdf(pdf, { identity, reason: 'I approve', location: 'Rome' });
    expect(startsWith(signed, pdf)).toBe(true); // earlier revision untouched
    expect((await qpdfCheck(signed)).ok).toBe(true);
    await withPdfsig(signed, (rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        signer: 'Ada Lovelace',
        validSignature: true,
        totalDocumentSigned: true,
      });
    });
    const text = latin1(signed);
    const m = /\/ByteRange \[0 (\d+) (\d+) (\d+)\]/.exec(text)!;
    expect(Number(m[2]) + Number(m[3])).toBe(signed.length);
    expect(text).toMatch(/\/SubFilter \/adbe\.pkcs7\.detached/);
    expect((await (await (await sharedEngine()).open(signed)).getMeta()).hasSignatures).toBe(true);
  });

  it('signs with an ECDSA identity @FR-SIG-01', async () => {
    const { identity } = await pki({ ec: 'P-256' });
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    await withPdfsig(signed, (rows) =>
      expect(rows[0]).toMatchObject({ validSignature: true, totalDocumentSigned: true }),
    );
  });

  it('keeps earlier signatures valid when signing again @FR-SIG-01', async () => {
    const a = await pki({ cn: 'Ada' });
    const b = await pki({ cn: 'Grace' });
    const once = await signPdf(await textDoc({ pages: 1 }), { identity: a.identity });
    const twice = await signPdf(once, { identity: b.identity });
    expect(startsWith(twice, once)).toBe(true);
    await withPdfsig(twice, (rows) => {
      expect(rows.map((r) => [r.signer, r.validSignature])).toEqual([
        ['Ada', true],
        ['Grace', true],
      ]);
    });
    expect((await listSignatureFields(twice)).map((f) => f.name)).toEqual(['Signature1', 'Signature2']);
    const report = await validateSignatures(twice, {
      trusted: [certDer(a.root.certificate), certDer(b.root.certificate)],
    });
    expect(report.map((r) => [r.status, r.changedAfterSigning])).toEqual([
      ['valid', true],
      ['valid', false],
    ]);
  });

  it('works on files with a compressed cross-reference stream @FR-SIG-01', async () => {
    const { identity } = await pki();
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(await textDoc({ pages: 3 }));
    const packed = await doc.save({ useObjectStreams: true });
    expect(latin1(packed)).toMatch(/\/Type\s*\/XRef/);
    const signed = await signPdf(packed, { identity });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    await withPdfsig(signed, (rows) => expect(rows[0]).toMatchObject({ validSignature: true }));
    expect(latin1(signed.subarray(packed.length))).toMatch(/\/Type \/XRef/);
  });

  it('refuses encrypted and damaged files with a clear error @FR-SIG-01', async () => {
    const { identity } = await pki();
    const { encryptedDoc } = await import('@folio/testkit');
    await expect(signPdf(await encryptedDoc(), { identity })).rejects.toMatchObject({ code: 'encrypted' });
    await expect(signPdf(bytesOf('%PDF-1.4 nonsense'), { identity })).rejects.toBeInstanceOf(SigningError);
  });

  it('fills an existing empty signature field and refuses a missing or used one @FR-SIG-02', async () => {
    const { identity } = await pki();
    const { PDFDocument, PDFName, PDFString } = await import('pdf-lib');
    // An empty signature field, as another editor writes it.
    const doc = await PDFDocument.load(await textDoc({ pages: 1 }));
    const ctx = doc.context;
    const page = doc.getPages()[0]!;
    const widget = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of('Approval'),
        Rect: [72, 100, 272, 150],
        F: 4,
        P: page.ref,
      }),
    );
    page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widget] }));
    const empty = await doc.save({ useObjectStreams: false });
    expect(await listSignatureFields(empty)).toEqual([
      { name: 'Approval', page: 0, rect: { x: 72, y: 100, width: 200, height: 50 }, signed: false },
    ]);
    const signed = await signPdf(empty, {
      identity,
      fieldName: 'Approval',
      appearance: { page: 0, rect: { x: 72, y: 100, width: 200, height: 50 }, lines: ['Signed by Ada'] },
    });
    expect(await listSignatureFields(signed)).toMatchObject([{ name: 'Approval', signed: true }]);
    await withPdfsig(signed, (rows) => expect(rows[0]).toMatchObject({ validSignature: true }));
    expect((await qpdfCheck(signed)).ok).toBe(true);
    await expect(signPdf(signed, { identity, fieldName: 'Approval' })).rejects.toMatchObject({
      code: 'field-signed',
    });
    await expect(signPdf(empty, { identity, fieldName: 'Nope' })).rejects.toMatchObject({
      code: 'field-not-found',
    });
  });

  it('creates numbered fields and an invisible signature has an empty rectangle @FR-SIG-02', async () => {
    const { identity } = await pki();
    const once = await signPdf(await textDoc({ pages: 2 }), { identity });
    const twice = await signPdf(once, {
      identity,
      appearance: { page: 1, rect: { x: 50, y: 50, width: 120, height: 40 } },
    });
    const fields = await listSignatureFields(twice);
    expect(fields.map((f) => [f.name, f.page, f.signed])).toEqual([
      ['Signature1', 0, true],
      ['Signature2', 1, true],
    ]);
    expect(fields[0]!.rect.width).toBe(0);
    await expect(
      signPdf(once, { identity, appearance: { page: 9, rect: { x: 0, y: 0, width: 10, height: 10 } } }),
    ).rejects.toMatchObject({ code: 'bad-page' });
  });

  it('draws the visible appearance, covered by the signature @FR-SIG-03', async () => {
    const { identity } = await pki({ cn: 'Ada Lovelace' });
    const pdf = await textDoc({ pages: 1 });
    const rect = { x: 72, y: 500, width: 240, height: 80 };
    const signed = await signPdf(pdf, {
      identity,
      reason: 'Approved',
      appearance: { page: 0, rect, lines: ['Digitally signed by Ada Lovelace', 'Reason: Approved'] },
    });
    const before = await pdftoppm(pdf, 1, 72);
    const after = await pdftoppm(signed, 1, 72);
    const y0 = Math.round(792 - rect.y - rect.height);
    let changed = 0;
    for (let y = y0; y < y0 + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++)
        if (before.data[(y * before.width + x) * 4] !== after.data[(y * after.width + x) * 4]) changed++;
    expect(changed).toBeGreaterThan(rect.width * rect.height * 0.5);
    // Outside the rectangle nothing moved.
    expect(after.data[(10 * after.width + 10) * 4]).toBe(before.data[(10 * before.width + 10) * 4]);
    await withPdfsig(signed, (rows) => expect(rows[0]).toMatchObject({ validSignature: true }));
  });

  it('embeds PNG artwork in the appearance @FR-SIG-03', async () => {
    const { identity } = await pki();
    const { PNG } = await import('pngjs');
    const png = new PNG({ width: 40, height: 20 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 0, 0, 255], i);
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      appearance: {
        page: 0,
        rect: { x: 72, y: 500, width: 240, height: 80 },
        lines: ['Ada'],
        image: { bytes: new Uint8Array(PNG.sync.write(png)), mime: 'image/png' },
      },
    });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    const img = await pdftoppm(signed, 1, 72);
    const y = Math.round(792 - 540);
    const i = (y * img.width + 90) * 4;
    expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([200, 0, 0]);
  });
});

describe('Validation @FR-SIG-04', () => {
  it('trusts a signer whose chain reaches a trusted certificate @FR-SIG-04', async () => {
    const { root, identity, leaf } = await pki({ cn: 'Ada Lovelace' });
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      reason: 'Approved',
      location: 'Rome',
    });
    const [r] = await validateSignatures(signed, { trusted: [certDer(root.certificate)] });
    expect(r).toMatchObject({
      status: 'valid',
      integrity: 'ok',
      trust: 'trusted',
      chainComplete: true,
      coversWholeFile: true,
      changedAfterSigning: false,
      reason: 'Approved',
      location: 'Rome',
      fieldName: 'Signature1',
      revocation: 'not-checked',
    });
    expect(r!.signer!.commonName).toBe('Ada Lovelace');
    expect(r!.chain.map((c) => c.commonName)).toEqual(['Ada Lovelace', 'Folio Test Root CA']);
    // Trusting the signer certificate itself is enough.
    const [again] = await validateSignatures(signed, { trusted: [certDer(leaf.certificate)] });
    expect(again!.status).toBe('valid');
  });

  it('marks an unknown signer valid but untrusted @FR-SIG-04', async () => {
    const { identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const [r] = await validateSignatures(signed);
    expect(r).toMatchObject({
      status: 'valid-untrusted',
      integrity: 'ok',
      trust: 'untrusted',
      chainComplete: false,
    });
    const other = await pki({ cn: 'Someone else' });
    expect(
      (await validateSignatures(signed, { trusted: [certDer(other.root.certificate)] }))[0]!.status,
    ).toBe('valid-untrusted');
  });

  it('detects tampering inside the signed bytes @FR-SIG-04', async () => {
    const { root, identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1, title: 'Original' }), { identity });
    const tampered = signed.slice();
    tampered[7] = '4'.charCodeAt(0); // the header's version digit lies inside the signed range
    const [r] = await validateSignatures(tampered, { trusted: [certDer(root.certificate)] });
    expect(r).toMatchObject({ status: 'invalid', integrity: 'tampered' });
    await withPdfsig(tampered, (rows) => expect(rows[0]!.validSignature).toBe(false));
  });

  it('reports bytes appended after the last signature as a change after signing @FR-SIG-04', async () => {
    const { root, identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const extended = new Uint8Array(signed.length + 20);
    extended.set(signed);
    extended.set(bytesOf('\n% later edit .......\n').subarray(0, 20), signed.length);
    const [r] = await validateSignatures(extended, { trusted: [certDer(root.certificate)] });
    expect(r).toMatchObject({
      status: 'valid',
      integrity: 'ok',
      changedAfterSigning: true,
      coversWholeFile: false,
    });
  });

  it('flags expired and not yet valid certificates @FR-SIG-04', async () => {
    const day = 24 * 3600e3;
    const expired = await pki({
      notBefore: new Date(Date.now() - 30 * day),
      notAfter: new Date(Date.now() + 1 * day),
    });
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: expired.identity });
    const trusted = [certDer(expired.root.certificate)];
    expect(
      (await validateSignatures(signed, { trusted, now: new Date(Date.now() + 5 * day) }))[0],
    ).toMatchObject({ status: 'valid-untrusted', trust: 'expired' });
    expect(
      (await validateSignatures(signed, { trusted, now: new Date(Date.now() - 20 * day) }))[0],
    ).toMatchObject({ trust: 'not-yet-valid' });
  });

  it('treats unreadable signatures as unknown and never throws @FR-SIG-04', async () => {
    const [r] = await validateSignatures(await signedDoc());
    expect(r!.status).toBe('unknown');
    expect(await validateSignatures(await textDoc({ pages: 1 }))).toEqual([]);
    expect(await validateSignatures(bytesOf('garbage'))).toEqual([]);
  });
});

describe('Timestamps @FR-SIG-07', () => {
  const authorityFor = async () => {
    const root = await makeCertificate({ cn: 'Test TSA Root', ca: true });
    const tsa = await makeCertificate({
      cn: 'Test TSA',
      issuer: root,
      keyUsage: ['digitalSignature'],
      extKeyUsage: ['1.3.6.1.5.5.7.3.8'],
    });
    return { root, tsa, fake: new FakeTimestampAuthority(tsa, [root], new Date('2026-03-01T10:00:00Z')) };
  };

  it('adds a verifiable RFC 3161 token and stays valid for pdfsig @FR-SIG-07', async () => {
    const { root, identity } = await pki();
    const { root: tsaRoot, fake } = await authorityFor();
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      timestamp: { url: 'https://tsa.example/tsr', transport: fake },
    });
    expect(fake.requests).toBe(1);
    expect(fake.urls).toEqual(['https://tsa.example/tsr']);
    await withPdfsig(signed, (rows) => expect(rows[0]).toMatchObject({ validSignature: true }));
    expect((await qpdfCheck(signed)).ok).toBe(true);
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(root.certificate), certDer(tsaRoot.certificate)],
    });
    expect(r!.timestamp).toEqual({
      time: '2026-03-01T10:00:00.000Z',
      verified: true,
      authority: 'Test TSA',
      trusted: true,
    });
    const [untrusted] = await validateSignatures(signed, { trusted: [certDer(root.certificate)] });
    expect(untrusted!.timestamp).toMatchObject({ verified: true, trusted: false });
  });

  it('judges certificate validity at the time the authority vouches for @FR-SIG-07', async () => {
    const day = 24 * 3600e3;
    const { root, identity } = await pki({
      notBefore: new Date(Date.now() - 30 * day),
      notAfter: new Date(Date.now() + 2 * day),
    });
    const { fake } = await authorityFor();
    const stamped = new FakeTimestampAuthority(
      (fake as unknown as { authority: never }).authority,
      [],
      new Date(Date.now()),
    );
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      timestamp: { url: 'https://tsa.example', transport: stamped },
    });
    const later = new Date(Date.now() + 10 * day);
    expect(
      (await validateSignatures(signed, { trusted: [certDer(root.certificate)], now: later }))[0]!.trust,
    ).toBe('trusted');
  });

  it('stops with a typed error when the authority fails, and never signs half-way @FR-SIG-07', async () => {
    const { identity } = await pki();
    const { fake } = await authorityFor();
    const pdf = await textDoc({ pages: 1 });
    for (const [mode, code] of [
      ['network', 'network'],
      ['refuse', 'rejected'],
      ['garbage', 'invalid'],
      ['wrong-imprint', 'invalid'],
    ] as const) {
      fake.mode = mode;
      await expect(
        signPdf(pdf, { identity, timestamp: { url: 'https://tsa.example', transport: fake } }),
      ).rejects.toMatchObject({ code });
    }
    await expect(
      signPdf(pdf, { identity, timestamp: { url: 'ftp://tsa.example', transport: fake } }),
    ).rejects.toMatchObject({ code: 'url' });
    await expect(
      signPdf(pdf, { identity, timestamp: { url: 'https://user:pw@tsa.example', transport: fake } }),
    ).rejects.toBeInstanceOf(TimestampError);
  });

  it('sends nothing unless a timestamp is requested @FR-SIG-07', async () => {
    const { identity } = await pki();
    const { fake } = await authorityFor();
    await signPdf(await textDoc({ pages: 1 }), { identity });
    expect(fake.requests).toBe(0);
    void requestTimestamp;
    void identityOf;
  });
});

describe('Revocation and long-term validation @FR-SIG-06 @FR-SIG-08', () => {
  const OCSP = 'http://ocsp.example/check';
  const CRL = 'http://crl.example/root.crl';
  const setup = async () => {
    const root = await makeCertificate({ cn: 'Folio Test Root CA', ca: true });
    const leaf = await makeCertificate({ cn: 'Ada Lovelace', issuer: root, ocspUrl: OCSP, crlUrl: CRL });
    return {
      root,
      leaf,
      identity: await identityOf(leaf, root),
      server: new FakeRevocationServer(root, OCSP, CRL),
    };
  };
  const serialHex = (c: { certificate: { serialNumber: { valueBlock: { valueHexView: Uint8Array } } } }) =>
    Array.from(c.certificate.serialNumber.valueBlock.valueHexView, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');

  it('checks nothing and sends nothing unless asked @FR-SIG-06', async () => {
    const { root, identity, server } = await setup();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const [r] = await validateSignatures(signed, { trusted: [certDer(root.certificate)] });
    expect(r!.revocation).toBe('not-checked');
    expect(server.requests).toEqual([]);
  });

  it('asks the OCSP responder and reports good or revoked @FR-SIG-06', async () => {
    const { root, leaf, identity, server } = await setup();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const opts = { trusted: [certDer(root.certificate)], revocation: server };
    expect((await validateSignatures(signed, opts))[0]).toMatchObject({
      revocation: 'good',
      status: 'valid',
    });
    expect(server.requests).toEqual([`POST ${OCSP}`]);
    server.revoked.add(serialHex(leaf));
    expect((await validateSignatures(signed, opts))[0]).toMatchObject({
      revocation: 'revoked',
      status: 'invalid',
    });
  });

  it('falls back to the CRL, and says unknown when nothing answers @FR-SIG-06', async () => {
    const { root, leaf, identity, server } = await setup();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const opts = { trusted: [certDer(root.certificate)], revocation: server };
    server.mode = 'ocsp-fails';
    expect((await validateSignatures(signed, opts))[0]!.revocation).toBe('good');
    expect(server.requests.at(-1)).toBe(`GET ${CRL}`);
    server.revoked.add(serialHex(leaf));
    expect((await validateSignatures(signed, opts))[0]!.revocation).toBe('revoked');
    server.mode = 'down';
    expect((await validateSignatures(signed, opts))[0]).toMatchObject({
      revocation: 'unknown',
      status: 'valid',
    });
  });

  it('stores certificates and answers in /DSS after the signature @FR-SIG-08', async () => {
    const { root, identity, server } = await setup();
    const pdf = await textDoc({ pages: 1 });
    const signed = await signPdf(pdf, { identity, validationData: server });
    expect(server.requests).toEqual([`POST ${OCSP}`]);
    const text = latin1(signed);
    expect(text).toMatch(/\/DSS/);
    expect(text).toMatch(/\/VRI/);
    expect((await qpdfCheck(signed)).ok).toBe(true);
    await withPdfsig(signed, (rows) => expect(rows[0]).toMatchObject({ validSignature: true }));
    const [r] = await validateSignatures(signed, { trusted: [certDer(root.certificate)] });
    expect(r).toMatchObject({ status: 'valid', integrity: 'ok', changedAfterSigning: true });
    const { PDFDocument, PDFName, PDFArray, PDFDict } = await import('pdf-lib');
    const dss = (await PDFDocument.load(signed)).catalog.lookup(PDFName.of('DSS'), PDFDict);
    expect(dss.lookup(PDFName.of('Certs'), PDFArray).size()).toBe(2);
    expect(dss.lookup(PDFName.of('OCSPs'), PDFArray).size()).toBe(1);
  });

  it('refuses to sign with a revoked certificate and leaves no file @FR-SIG-08', async () => {
    const { leaf, identity, server } = await setup();
    server.revoked.add(serialHex(leaf));
    await expect(
      signPdf(await textDoc({ pages: 1 }), { identity, validationData: server }),
    ).rejects.toMatchObject({ code: 'revoked' });
  });
});
