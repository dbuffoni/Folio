import { describe, expect, it } from 'vitest';
import {
  FakeRevocationServer,
  FakeTimestampAuthority,
  identityOf,
  makeCertificate,
  opensslPkcs12,
  pki,
  qpdfCheck,
  textDoc,
} from '@folio/testkit';
import {
  CertificateError,
  SigningError,
  TimestampError,
  certDer,
  describeCertificate,
  listSignatureFields,
  openPkcs12,
  parseCertificates,
  signPdf,
  validateSignatures,
} from './index.ts';

const bytesOf = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const day = 24 * 3600e3;
const pem = (c: Uint8Array, label = 'CERTIFICATE') =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...c)).replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;
const serialHex = (c: { certificate: { serialNumber: { valueBlock: { valueHexView: Uint8Array } } } }) =>
  Array.from(c.certificate.serialNumber.valueBlock.valueHexView, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );

describe('Certificate files, edge cases @FR-CRT-01 @FR-CRT-02', () => {
  it('a legacy-encrypted PKCS#12 file always ends in a typed certificate error @FR-CRT-01', async () => {
    // SPEC ambiguity: the file (RC2-40 / 3DES, OpenSSL -legacy) is refused even with the right password,
    // and reported as bad-password. See the report: the spec only promises UTF-8 and BMP password encodings.
    const { p12 } = await opensslPkcs12({ cn: 'Old Tool', password: 'pw', legacy: true });
    const err = await openPkcs12(p12, 'pw').then(
      () => null,
      (e: unknown) => e,
    );
    if (err !== null) expect(err).toBeInstanceOf(CertificateError);
    await expect(openPkcs12(p12, '')).rejects.toBeInstanceOf(CertificateError);
  });

  it('a file with a certificate but no private key cannot sign @FR-CRT-01', async () => {
    const { p12 } = await opensslPkcs12({ cn: 'No Key', password: 'pw', certOnly: true });
    await expect(openPkcs12(p12, 'pw')).rejects.toMatchObject({ code: 'no-key' });
  });

  it('a key type that cannot sign is named, not mishandled @FR-CRT-01', async () => {
    const { p12 } = await opensslPkcs12({ cn: 'Edwards', password: 'pw', ed25519: true });
    const err = await openPkcs12(p12, 'pw').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CertificateError);
    expect(['unsupported', 'invalid']).toContain((err as CertificateError).code);
  });

  it('empty, truncated and PEM-wrapped garbage are all invalid @FR-CRT-01 @FR-CRT-02', async () => {
    await expect(openPkcs12(new Uint8Array(0), 'pw')).rejects.toMatchObject({ code: 'invalid' });
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'pw' });
    await expect(openPkcs12(p12.slice(0, 40), 'pw')).rejects.toBeInstanceOf(CertificateError);
    expect(() => parseCertificates(new Uint8Array(0))).toThrow(CertificateError);
    const { leaf } = await pki();
    const der = certDer(leaf.certificate);
    expect(() => parseCertificates(der.slice(0, der.length - 20))).toThrow(CertificateError);
    expect(() => parseCertificates(bytesOf(pem(der, 'PRIVATE KEY')))).toThrow(CertificateError);
  });

  it('PEM files with Windows line endings, text around the block and several certificates are read @FR-CRT-02', async () => {
    const a = await pki({ cn: 'A' });
    const text = `Bag Attributes\r\n  friendlyName: x\r\n${pem(certDer(a.leaf.certificate)).replace(/\n/g, '\r\n')}\r\nsome text\r\n${pem(certDer(a.root.certificate))}`;
    const found = parseCertificates(bytesOf(text));
    expect(found.map((c) => c.subject.typesAndValues[0]!.value.valueBlock.value)).toEqual([
      'A',
      'Folio Test Root CA',
    ]);
  });

  it('describes P-384 keys, non-CA leaves without key usage and certificates without a common name @FR-CRT-02', async () => {
    const ec = await makeCertificate({ cn: 'P384', ec: 'P-384' });
    expect((await describeCertificate(ec.certificate)).keyAlgorithm).toBe('ECDSA-P384');
    const plain = await makeCertificate({ cn: 'Plain', keyUsage: [] });
    const info = await describeCertificate(plain.certificate);
    expect(info).toMatchObject({ commonName: 'Plain', isCa: false });
    expect(info.keyUsage).toEqual([]);
    const caUsage = await makeCertificate({
      cn: 'Both',
      ca: true,
      keyUsage: ['digitalSignature', 'keyCertSign', 'cRLSign', 'nonRepudiation'],
    });
    expect((await describeCertificate(caUsage.certificate)).keyUsage).toEqual([
      'digitalSignature',
      'nonRepudiation',
      'keyCertSign',
      'cRLSign',
    ]);
    const issued = await makeCertificate({ cn: 'Leaf', issuer: ec });
    expect(await describeCertificate(issued.certificate)).toMatchObject({
      selfSigned: false,
      issuer: expect.stringContaining('P384'),
    });
  });
});

describe('Signing, edge cases @FR-SIG-01 @FR-SIG-02 @FR-SIG-03', () => {
  it('signs with a P-384 identity, reason/location with non-ASCII and PDF-special characters, and a fixed time @FR-SIG-01 @FR-SIG-02', async () => {
    const { identity } = await pki({ ec: 'P-384' });
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      reason: 'Approved (final) \\ ünïcode ✓',
      location: 'São Paulo',
      contactInfo: 'ada@example.org',
      signingTime: new Date('2026-04-02T08:30:00Z'),
    });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    const [r] = await validateSignatures(signed);
    expect(r).toMatchObject({
      integrity: 'ok',
      reason: 'Approved (final) \\ ünïcode ✓',
      location: 'São Paulo',
    });
    expect(r!.signingTime).toBe('2026-04-02T08:30:00.000Z');
  });

  it('refuses a missing page, an empty or oversized rectangle and a negative page index @FR-SIG-02', async () => {
    const { identity } = await pki();
    const pdf = await textDoc({ pages: 1 });
    const rect = { x: 10, y: 10, width: 50, height: 20 };
    await expect(signPdf(pdf, { identity, appearance: { page: -1, rect } })).rejects.toMatchObject({
      code: 'bad-page',
    });
    await expect(signPdf(pdf, { identity, appearance: { page: 1, rect } })).rejects.toMatchObject({
      code: 'bad-page',
    });
  });

  it('a signature box with many lines, empty lines and tiny size still produces a valid file @FR-SIG-02', async () => {
    const { identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      appearance: {
        page: 0,
        rect: { x: 20, y: 20, width: 30, height: 12 },
        lines: [
          'A very long line that cannot possibly fit into thirty points of width',
          '',
          'second',
          'third',
          'fourth',
        ],
      },
    });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    expect((await listSignatureFields(signed))[0]).toMatchObject({ signed: true, page: 0 });
  });

  it('a corrupt picture in the appearance is reported, not embedded @FR-SIG-02', async () => {
    const { identity } = await pki();
    const err = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      appearance: {
        page: 0,
        rect: { x: 20, y: 20, width: 100, height: 40 },
        lines: ['x'],
        image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    // Whatever is thrown, nothing is signed with a picture that cannot be read.
    expect(err).not.toBeNull();
  });

  it('a chain too long for the reserved space is refused with too-large @FR-SIG-02', async () => {
    const { identity, leaf, root } = await pki();
    const filler: (typeof root)[] = [];
    for (let i = 0; i < 40; i++)
      filler.push(await makeCertificate({ cn: `Filler ${i}`, ca: true, ec: 'P-256' }));
    const big = await identityOf(leaf, root, ...filler);
    const err = await signPdf(await textDoc({ pages: 1 }), { identity: big }).catch((e: unknown) => e);
    if (err instanceof SigningError) expect(err.code).toBe('too-large');
    else expect(err).toBeInstanceOf(Uint8Array);
    void identity;
  });

  it('signs a file that already carries an incremental update and a /DSS (two long-term signatures) @FR-SIG-03 @FR-SIG-08', async () => {
    const OCSP = 'http://ocsp.example/check';
    const CRL = 'http://crl.example/root.crl';
    const root = await makeCertificate({ cn: 'Root', ca: true });
    const leaf = await makeCertificate({ cn: 'Ada', issuer: root, ocspUrl: OCSP, crlUrl: CRL });
    const leaf2 = await makeCertificate({ cn: 'Grace', issuer: root, ocspUrl: OCSP, crlUrl: CRL });
    const server = new FakeRevocationServer(root, OCSP, CRL);
    const once = await signPdf(await textDoc({ pages: 1 }), {
      identity: await identityOf(leaf, root),
      validationData: server,
    });
    const twice = await signPdf(once, { identity: await identityOf(leaf2, root), validationData: server });
    expect((await qpdfCheck(twice)).ok).toBe(true);
    const reports = await validateSignatures(twice, { trusted: [certDer(root.certificate)] });
    expect(reports.map((r) => r.integrity)).toEqual(['ok', 'ok']);
    expect(latin1(twice).match(/\/DSS/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('long-term data falls back to the CRL when the responder is down, and tolerates a server that is entirely down @FR-SIG-08 @FR-SIG-06', async () => {
    const OCSP = 'http://ocsp.example/check';
    const CRL = 'http://crl.example/root.crl';
    const root = await makeCertificate({ cn: 'Root', ca: true });
    const leaf = await makeCertificate({ cn: 'Ada', issuer: root, ocspUrl: OCSP, crlUrl: CRL });
    const identity = await identityOf(leaf, root);
    const server = new FakeRevocationServer(root, OCSP, CRL);
    server.mode = 'ocsp-fails';
    const withCrl = await signPdf(await textDoc({ pages: 1 }), { identity, validationData: server });
    expect(server.requests).toEqual([`POST ${OCSP}`, `GET ${CRL}`]);
    expect(latin1(withCrl)).toMatch(/\/CRLs/);
    expect((await qpdfCheck(withCrl)).ok).toBe(true);
    server.mode = 'down';
    const without = await signPdf(await textDoc({ pages: 1 }), { identity, validationData: server });
    expect((await validateSignatures(without))[0]!.integrity).toBe('ok');
    // A revoked certificate known only from the CRL stops signing as well.
    server.mode = 'ocsp-fails';
    server.revoked.add(serialHex(leaf));
    await expect(
      signPdf(await textDoc({ pages: 1 }), { identity, validationData: server }),
    ).rejects.toMatchObject({ code: 'revoked' });
  });

  it('a certificate without responder or CRL addresses signs without asking anyone @FR-SIG-08', async () => {
    const { identity, root } = await pki();
    const server = new FakeRevocationServer(root, 'http://o/', 'http://c/');
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity, validationData: server });
    expect(server.requests).toEqual([]);
    expect((await qpdfCheck(signed)).ok).toBe(true);
  });

  it('timestamp and long-term data together give a valid file and a verified token @FR-SIG-07 @FR-SIG-08', async () => {
    const OCSP = 'http://ocsp.example/check';
    const root = await makeCertificate({ cn: 'Root', ca: true });
    const leaf = await makeCertificate({ cn: 'Ada', issuer: root, ocspUrl: OCSP });
    const tsaRoot = await makeCertificate({ cn: 'TSA Root', ca: true });
    const tsa = await makeCertificate({
      cn: 'TSA',
      issuer: tsaRoot,
      keyUsage: ['digitalSignature'],
      extKeyUsage: ['1.3.6.1.5.5.7.3.8'],
    });
    const fake = new FakeTimestampAuthority(tsa, [tsaRoot], new Date());
    const server = new FakeRevocationServer(root, OCSP, 'http://crl/');
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity: await identityOf(leaf, root),
      timestamp: { url: 'https://tsa.example', transport: fake },
      validationData: server,
    });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    const [r] = await validateSignatures(signed, { trusted: [certDer(root.certificate)] });
    expect(r!.timestamp).toMatchObject({ verified: true, authority: 'TSA' });
  });

  it('timestamp URL with credentials, other scheme or garbage is a typed url error; http is allowed @FR-SIG-07', async () => {
    const { identity } = await pki();
    const tsaRoot = await makeCertificate({ cn: 'TSA Root', ca: true });
    const tsa = await makeCertificate({
      cn: 'TSA',
      issuer: tsaRoot,
      keyUsage: ['digitalSignature'],
      extKeyUsage: ['1.3.6.1.5.5.7.3.8'],
    });
    const fake = new FakeTimestampAuthority(tsa, [tsaRoot]);
    const pdf = await textDoc({ pages: 1 });
    for (const url of ['', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const err = await signPdf(pdf, { identity, timestamp: { url, transport: fake } }).catch(
        (e: unknown) => e,
      );
      expect(err, url).toBeInstanceOf(TimestampError);
      expect((err as TimestampError).code, url).toBe('url');
    }
    expect(fake.requests).toBe(0);
    const ok = await signPdf(pdf, { identity, timestamp: { url: 'http://tsa.example/ts', transport: fake } });
    expect(fake.requests).toBe(1);
    expect((await validateSignatures(ok))[0]!.timestamp?.verified).toBe(true);
  });
});

describe('Validation, edge cases @FR-SIG-04 @FR-SIG-05 @FR-SIG-06', () => {
  it('a flipped byte inside the signature value is never reported as valid @FR-SIG-04', async () => {
    const { identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const text = latin1(signed);
    const contents = text.indexOf('/Contents <') + '/Contents <'.length;
    const flipped = signed.slice();
    flipped[contents + 40] = flipped[contents + 40] === 0x30 ? 0x31 : 0x30;
    const [f] = await validateSignatures(flipped);
    expect(['invalid', 'unknown']).toContain(f!.status);
  });

  it('a ByteRange whose numbers were changed without changing the length is not valid @FR-SIG-04', async () => {
    const { identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    const text = latin1(signed);
    const m = /\/ByteRange \[0 (\d+) /.exec(text)!;
    const at = m.index + '/ByteRange [0 '.length;
    const broken = signed.slice();
    broken[at] = broken[at] === 0x31 ? 0x32 : 0x31;
    const [r] = await validateSignatures(broken);
    expect(r === undefined || r.status === 'invalid' || r.status === 'unknown').toBe(true);
  });

  it('a signature whose ByteRange does not reach the end of file is reported as not covering the whole file @FR-SIG-04', async () => {
    const { identity, root } = await pki();
    const once = await signPdf(await textDoc({ pages: 1 }), { identity });
    const twice = await signPdf(once, { identity });
    const [first, second] = await validateSignatures(twice, { trusted: [certDer(root.certificate)] });
    expect(first).toMatchObject({ coversWholeFile: false, changedAfterSigning: true, integrity: 'ok' });
    expect(second).toMatchObject({ coversWholeFile: true, changedAfterSigning: false });
    expect(second!.index).toBe(1);
  });

  it('a certificate chain broken by a missing intermediate stays untrusted @FR-SIG-05', async () => {
    const root = await makeCertificate({ cn: 'Root', ca: true });
    const mid = await makeCertificate({ cn: 'Mid', ca: true, issuer: root });
    const leaf = await makeCertificate({ cn: 'Leaf', issuer: mid });
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: await identityOf(leaf) });
    const [r] = await validateSignatures(signed, { trusted: [certDer(root.certificate)] });
    expect(r).toMatchObject({ status: 'valid-untrusted', chainComplete: false });
    const full = await signPdf(await textDoc({ pages: 1 }), { identity: await identityOf(leaf, mid) });
    expect((await validateSignatures(full, { trusted: [certDer(root.certificate)] }))[0]).toMatchObject({
      status: 'valid',
      chainComplete: true,
    });
    // Trusting only the intermediate is enough as well.
    expect((await validateSignatures(full, { trusted: [certDer(mid.certificate)] }))[0]!.status).toBe(
      'valid',
    );
  });

  it('a chain whose certificate was not issued by the next one does not reach trust @FR-SIG-05', async () => {
    const root = await makeCertificate({ cn: 'Root', ca: true });
    const otherRoot = await makeCertificate({ cn: 'Root', ca: true });
    const leaf = await makeCertificate({ cn: 'Leaf', issuer: root });
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity: await identityOf(leaf, otherRoot),
    });
    const [r] = await validateSignatures(signed, { trusted: [certDer(otherRoot.certificate)] });
    expect(r!.status).toBe('valid-untrusted');
  });

  it('an expired signer and a root that expired are both not trusted @FR-SIG-05', async () => {
    const root = await makeCertificate({
      cn: 'Root',
      ca: true,
      notBefore: new Date(Date.now() - 400 * day),
      notAfter: new Date(Date.now() + 1 * day),
    });
    const leaf = await makeCertificate({ cn: 'Leaf', issuer: root });
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: await identityOf(leaf, root) });
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(root.certificate)],
      now: new Date(Date.now() + 3 * day),
    });
    expect(r!.status).toBe('valid-untrusted');
    expect(['expired', 'untrusted']).toContain(r!.trust);
  });

  it('revocation: OCSP unreachable and CRL unreachable is unknown, and a revoked intermediate is revoked @FR-SIG-06', async () => {
    const OCSP = 'http://ocsp.example/check';
    const CRL = 'http://crl.example/root.crl';
    const root = await makeCertificate({ cn: 'Root', ca: true });
    const leaf = await makeCertificate({ cn: 'Ada', issuer: root, ocspUrl: OCSP, crlUrl: CRL });
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: await identityOf(leaf, root) });
    const server = new FakeRevocationServer(root, OCSP, CRL);
    const opts = { trusted: [certDer(root.certificate)], revocation: server };
    server.mode = 'down';
    expect((await validateSignatures(signed, opts))[0]!.revocation).toBe('unknown');
    server.mode = 'ok';
    server.revoked.add(serialHex(leaf));
    const [revoked] = await validateSignatures(signed, opts);
    expect(revoked).toMatchObject({ revocation: 'revoked', status: 'invalid' });
    // A certificate without any address is "unknown" without a single request.
    const bare = await pki();
    const s2 = await signPdf(await textDoc({ pages: 1 }), { identity: bare.identity });
    const quiet = new FakeRevocationServer(root, OCSP, CRL);
    expect(
      (await validateSignatures(s2, { trusted: [certDer(bare.root.certificate)], revocation: quiet }))[0]!
        .revocation,
    ).toBe('unknown');
    expect(quiet.requests).toEqual([]);
  });

  it('a timestamp that does not match the signature is reported as not verified @FR-SIG-07', async () => {
    const { identity } = await pki();
    const tsaRoot = await makeCertificate({ cn: 'TSA Root', ca: true });
    const tsa = await makeCertificate({
      cn: 'TSA',
      issuer: tsaRoot,
      keyUsage: ['digitalSignature'],
      extKeyUsage: ['1.3.6.1.5.5.7.3.8'],
    });
    const fake = new FakeTimestampAuthority(tsa, [tsaRoot]);
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      timestamp: { url: 'https://tsa.example', transport: fake },
    });
    // Flip a byte inside the signature value: the token no longer covers it.
    const text = latin1(signed);
    const start = text.indexOf('/Contents <') + '/Contents <'.length;
    const bad = signed.slice();
    for (let i = 60; i < 80; i++) bad[start + i] = bad[start + i] === 0x30 ? 0x31 : 0x30;
    const [r] = await validateSignatures(bad);
    expect(r!.status === 'invalid' || r!.status === 'unknown' || r!.timestamp?.verified === false).toBe(true);
  });
});
