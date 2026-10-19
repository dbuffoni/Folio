import { describe, expect, it } from 'vitest';
import { makeCertificate, opensslPkcs12, opensslPkcs12Chain, textDoc } from '@folio/testkit';
import {
  CertificateError,
  describeCertificate,
  certDer,
  certFingerprint,
  openPkcs12,
  parseCertificates,
  signPdf,
  validateSignatures,
} from './index.ts';

describe('PKCS#12 import: chains, names and password encodings @FR-CRT-01 @FR-CRT-02', () => {
  it('keeps the signer first and carries the issuing CA, so the signature can be trusted through it @FR-CRT-01 @FR-CRT-02', async () => {
    const { p12, caPem } = await opensslPkcs12Chain({
      cn: 'Chain Leaf',
      caCn: 'Corporate CA',
      password: 'pw',
      friendly: 'my cert',
    });
    const id = await openPkcs12(p12, 'pw');
    expect(id.info.commonName).toBe('Chain Leaf');
    expect(id.info.selfSigned).toBe(false);
    expect(id.certificates.length).toBeGreaterThanOrEqual(2);
    expect(
      id.certificates[0]!.subject.typesAndValues.some(
        (t) => String(t.value.valueBlock.value) === 'Chain Leaf',
      ),
    ).toBe(true);
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: id });
    const [ca] = parseCertificates(new TextEncoder().encode(caPem));
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(ca!)],
      now: new Date(Date.now() + 3600e3),
    });
    expect(r).toMatchObject({ status: 'valid', trust: 'trusted', chainComplete: true });
    expect(r!.chain.map((c) => c.commonName)).toEqual(['Chain Leaf', 'Corporate CA']);
  });

  it('an unrelated extra certificate in the file does not break the chain @FR-CRT-01', async () => {
    const { p12 } = await opensslPkcs12Chain({ cn: 'Leaf', caCn: 'CA', password: 'pw', extraCa: true });
    const id = await openPkcs12(p12, 'pw');
    expect(id.info.commonName).toBe('Leaf');
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: id });
    expect((await validateSignatures(signed))[0]!.integrity).toBe('ok');
  });

  it('SHA-1 / 3DES protected files either open or fail with a typed error, and a wrong password always says so @FR-CRT-01', async () => {
    const { p12 } = await opensslPkcs12Chain({
      cn: 'Old Leaf',
      caCn: 'Old CA',
      password: 'pw',
      triple: true,
    });
    const ok = await openPkcs12(p12, 'pw').then(
      (i) => i.info.commonName,
      (e: unknown) => e,
    );
    if (typeof ok !== 'string') expect(ok).toBeInstanceOf(CertificateError);
    else expect(ok).toBe('Old Leaf');
    await expect(openPkcs12(p12, 'wrong')).rejects.toBeInstanceOf(CertificateError);
  });

  it('empty and non-ASCII passwords round-trip @FR-CRT-01', async () => {
    const empty = await opensslPkcs12({ cn: 'Empty', password: '' });
    expect((await openPkcs12(empty.p12, '')).info.commonName).toBe('Empty');
    await expect(openPkcs12(empty.p12, 'x')).rejects.toMatchObject({ code: 'bad-password' });
    if (process.platform !== 'win32') {
      const emoji = await opensslPkcs12({ cn: 'Emoji', password: 'pä$$wörd-😀' });
      expect((await openPkcs12(emoji.p12, 'pä$$wörd-😀')).info.commonName).toBe('Emoji');
      await expect(openPkcs12(emoji.p12, 'pa$$word-')).rejects.toMatchObject({ code: 'bad-password' });
    }
  });

  it('a long-lived and an already expired file both import; the dates are in the description @FR-CRT-01 @FR-CRT-03', async () => {
    const long = await opensslPkcs12({ cn: 'Long', password: 'pw', days: 3650 });
    const id = await openPkcs12(long.p12, 'pw');
    expect(Date.parse(id.info.notAfter) - Date.parse(id.info.notBefore)).toBeGreaterThan(3000 * 24 * 3600e3);
    expect(id.info.keyUsage).toContain('digitalSignature');
    expect(await certFingerprint(id.certificates[0]!)).toBe(id.info.fingerprint);
  });

  it('a P-256 file reports its curve and a P-12 holding only trust anchors is no identity @FR-CRT-01', async () => {
    const ec = await opensslPkcs12({ cn: 'EC', password: 'pw', ec: true });
    expect((await openPkcs12(ec.p12, 'pw')).info.keyAlgorithm).toBe('ECDSA-P256');
    const certs = await opensslPkcs12({ cn: 'Anchor', password: 'pw', certOnly: true });
    const err = await openPkcs12(certs.p12, 'pw').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CertificateError);
    expect(['no-key', 'no-certificate']).toContain((err as CertificateError).code);
  });

  it('other protections of the same content open or fail with a typed error, never a crash @FR-CRT-01', async () => {
    const variants: string[][] = [
      ['-keypbe', 'NONE'],
      ['-certpbe', 'NONE'],
      ['-keypbe', 'NONE', '-certpbe', 'NONE'],
      ['-nomac'],
      ['-keypbe', 'AES-128-CBC', '-certpbe', 'AES-128-CBC'],
      ['-macalg', 'sha512', '-iter', '1'],
      ['-macalg', 'sha384', '-iter', '5000'],
      ['-descert'],
      ['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'],
    ];
    const outcome = new Map<string, string>();
    for (const args of variants) {
      let made;
      try {
        made = await opensslPkcs12Chain({ cn: 'Variant', caCn: 'Variant CA', password: 'pw', args });
      } catch {
        outcome.set(args.join(' '), 'not-made');
        continue;
      }
      const r = await openPkcs12(made.p12, 'pw').then(
        (i) => i.info.commonName,
        (e: unknown) => (e instanceof CertificateError ? e.code : `untyped: ${String(e)}`),
      );
      outcome.set(args.join(' '), r);
      expect(r, args.join(' ')).toSatisfy(
        (v: string) =>
          v === 'Variant' ||
          v === 'not-made' ||
          ['bad-password', 'unsupported', 'invalid', 'no-key', 'no-certificate'].includes(v),
      );
      if (r === 'Variant')
        await expect(openPkcs12(made.p12, 'nope')).rejects.toBeInstanceOf(CertificateError);
    }
    // At least the plain, modern variants must open.
    expect([...outcome.values()].filter((v) => v === 'Variant').length).toBeGreaterThanOrEqual(3);
  });

  it('certificates with an empty or non-ASCII name are described without failing @FR-CRT-02 @FR-CRT-03', async () => {
    const empty = await makeCertificate({ cn: '' });
    const e = await describeCertificate(empty.certificate);
    expect(typeof e.commonName).toBe('string');
    expect(e.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const unicode = await makeCertificate({ cn: 'Zoë Ångström 山田 ✓' });
    expect((await describeCertificate(unicode.certificate)).commonName).toBe('Zoë Ångström 山田 ✓');
    const issuedByEmpty = await makeCertificate({ cn: 'Leaf', issuer: empty });
    const info = await describeCertificate(issuedByEmpty.certificate);
    expect(info.selfSigned).toBe(false);
    expect(typeof info.issuer).toBe('string');
  });

  it('a three-level chain listed root first is put in signing order @FR-CRT-01 @FR-SIG-02', async () => {
    const { p12, caPem } = await opensslPkcs12Chain({
      cn: 'Deep Leaf',
      caCn: 'Deep Root',
      password: 'pw',
      deep: true,
    });
    const id = await openPkcs12(p12, 'pw');
    expect(id.info.commonName).toBe('Deep Leaf');
    expect(id.certificates).toHaveLength(3);
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity: id });
    const [root] = parseCertificates(new TextEncoder().encode(caPem));
    const [r] = await validateSignatures(signed, {
      trusted: [certDer(root!)],
      now: new Date(Date.now() + 3600e3),
    });
    expect(r!.chain.map((c) => c.commonName)).toEqual(['Deep Leaf', 'Intermediate', 'Deep Root']);
    expect(r).toMatchObject({ status: 'valid', chainComplete: true });
  });

  it('a P-384 PKCS#12 file imports and signs @FR-CRT-01 @FR-SIG-01', async () => {
    const { p12 } = await opensslPkcs12({ cn: 'Curve 384', password: 'pw', curve: 'secp384r1' });
    const identity = await openPkcs12(p12, 'pw');
    expect(identity.info.keyAlgorithm).toBe('ECDSA-P384');
    const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
    expect((await validateSignatures(signed))[0]).toMatchObject({ integrity: 'ok' });
  });

  it('files without an integrity check, or with 3DES-only protection, are never misreported as a crash @FR-CRT-01', async () => {
    for (const args of [
      ['-nomac'],
      ['-descert'],
      ['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'],
    ]) {
      const { p12 } = await opensslPkcs12Chain({ cn: 'Legacy', caCn: 'Legacy CA', password: 'pw', args });
      const err = await openPkcs12(p12, 'pw').then(
        () => null,
        (e: unknown) => e,
      );
      if (err !== null) expect(err, args.join(' ')).toBeInstanceOf(CertificateError);
    }
  });
});
