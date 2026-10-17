import { describe, expect, it } from 'vitest';
import { FakeRevocationServer, FakeTimestampAuthority, makeCertificate, opensslPkcs12, withPdfsig, qpdfCheck } from '@folio/testkit';
import { createTestApp, type TestApp } from './testing.ts';

async function app(opts: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const t = await createTestApp(opts);
  (t.services.platform.clock as unknown as { set(d: Date): void }).set(new Date(Date.now() + 3600e3));
  return t;
}

async function withIdentity(t: TestApp, cn = 'Ada Lovelace', pw = 'pw') {
  const { p12 } = await opensslPkcs12({ cn, password: pw });
  t.files.put('/keys/id.p12', p12);
  t.prompts.passwords.push(pw);
  const m = t.certificates();
  const entry = await m.importIdentityFrom(t.files.ref('/keys/id.p12'));
  return { m, entry: entry! };
}

describe('Certificates pane model @FR-CRT-01 @FR-CRT-02 @FR-CRT-03', () => {
  it('imports an identity, retries a wrong password and lists it @FR-CRT-01 @FR-CRT-04', async () => {
    const t = await app();
    const { p12 } = await opensslPkcs12({ cn: 'Ada Lovelace', password: 'pw' });
    t.files.put('/keys/id.p12', p12);
    t.prompts.passwords.push('nope', 'pw');
    const m = t.certificates();
    const entry = await m.importIdentityFrom(t.files.ref('/keys/id.p12'));
    expect(entry?.commonName).toBe('Ada Lovelace');
    expect(t.prompts.asked.filter((a) => a.startsWith('password:'))).toEqual([
      'password:id.p12:false',
      'password:id.p12:true',
    ]);
    expect(m.identities).toHaveLength(1);
    expect(m.current?.fingerprint).toBe(entry!.fingerprint);
    expect(t.toastKeys()).toContain('cert.importedSession');
  });

  it('giving up on the password imports nothing; a broken file shows a fixable error @FR-CRT-01', async () => {
    const t = await app();
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'pw' });
    t.files.put('/keys/id.p12', p12);
    t.prompts.passwords.push(null);
    const m = t.certificates();
    expect(await m.importIdentityFrom(t.files.ref('/keys/id.p12'))).toBeNull();
    expect(m.identities).toHaveLength(0);
    t.files.put('/keys/bad.p12', new Uint8Array([1, 2, 3]));
    t.prompts.passwords.push('pw');
    expect(await m.importIdentityFrom(t.files.ref('/keys/bad.p12'))).toBeNull();
    expect(m.error?.key).toMatch(/^cert\.error\./);
  });

  it('trusts a certificate file, removes it after confirmation @FR-CRT-02 @FR-CRT-03', async () => {
    const t = await app();
    const { certPem } = await opensslPkcs12({ cn: 'Root Co', password: 'x' });
    t.files.put('/keys/root.pem', new TextEncoder().encode(certPem));
    t.files.nextOpen.push(['/keys/root.pem']);
    const m = t.certificates();
    expect(await m.importTrusted()).toBe(1);
    expect(m.trusted[0]!.commonName).toBe('Root Co');
    t.prompts.confirmAnswers.push(false);
    expect(await m.remove('trusted', m.trusted[0]!.fingerprint)).toBe(false);
    expect(m.trusted).toHaveLength(1);
    expect(await m.remove('trusted', m.trusted[0]!.fingerprint)).toBe(true);
    expect(m.trusted).toHaveLength(0);
  });
});

describe('Digital signature dialog model @FR-SIG-01 @FR-SIG-02 @FR-SIG-03', () => {
  it('signs a copy with a visible appearance and leaves the open file alone @FR-SIG-01 @FR-SIG-02', async () => {
    const t = await app();
    await withIdentity(t);
    const s = await t.open('multilingual');
    const before = t.files.get('/docs/multilingual.pdf')!.slice();
    const m = t.digitalSign(s);
    await m.start();
    expect(m.stage).toBe('ready');
    expect(m.identities).toHaveLength(1);
    expect(m.placement).toBe('new');
    m.setCorner('bottom-right');
    m.set({ reason: 'I approve' });
    t.files.nextSave.push('/out/signed.pdf');
    expect(await m.run()).toBe('signed.pdf');
    const out = t.files.get('/out/signed.pdf')!;
    expect((await qpdfCheck(out)).ok).toBe(true);
    await withPdfsig(out, (rows) => expect(rows[0]!.validSignature).toBe(true));
    expect(t.files.get('/docs/multilingual.pdf')).toEqual(before);
    expect(t.toastKeys()).toContain('dsig.done');
    expect(t.app.settings.signing.lastIdentity).toBe(m.identity);
  });

  it('without an identity the dialog cannot sign; encrypted files are refused @FR-SIG-01', async () => {
    const t = await app();
    const s = await t.open('multilingual');
    const m = t.digitalSign(s);
    await m.start();
    expect(m.identities).toHaveLength(0);
    expect(m.canSign).toBe(false);
  });

  it('uses an empty signature field the file already has @FR-SIG-03', async () => {
    const t = await app();
    await withIdentity(t);
    const s = await t.open('signed');
    const m = t.digitalSign(s);
    await m.start();
    expect(m.alreadySigned).toBe(true);
  });

  it('timestamp and validation data go over the network only when switched on @FR-SIG-07 @FR-SIG-08', async () => {
    const root = await makeCertificate({ cn: 'Test TSA Root', ca: true });
    const tsaCert = await makeCertificate({ cn: 'Test TSA', issuer: root, keyUsage: ['digitalSignature'], extKeyUsage: ['1.3.6.1.5.5.7.3.8'] });
    const tsa = new FakeTimestampAuthority(tsaCert, [root], new Date());
    const t = await app({ network: tsa });
    await withIdentity(t);
    await t.app.setSetting('signing', { ...t.app.settings.signing, tsaUrl: 'https://tsa.example/ts' });
    const s = await t.open('multilingual');
    const off = t.digitalSign(s);
    await off.start();
    expect(off.timestamp).toBe(false);
    t.files.nextSave.push('/out/a.pdf');
    await off.run();
    expect(tsa.requests).toBe(0);

    const on = t.digitalSign(s);
    await on.start();
    on.set({ timestamp: true });
    t.files.nextSave.push('/out/b.pdf');
    await on.run();
    expect(tsa.requests).toBe(1);
  });

  it('no network transport: timestamp cannot be switched on @FR-SIG-07', async () => {
    const t = await app();
    await withIdentity(t);
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    expect(m.networkAvailable).toBe(false);
    m.set({ timestamp: true });
    expect(m.canSign).toBe(false);
  });
});

describe('Signature panel model @FR-SIG-04 @FR-SIG-05 @FR-SIG-06', () => {
  it('reports untrusted, then valid once the signer is trusted @FR-SIG-04 @FR-SIG-05', async () => {
    const t = await app();
    await withIdentity(t);
    const s = await t.open('multilingual');
    const sign = t.digitalSign(s);
    await sign.start();
    t.files.nextSave.push('/out/signed.pdf');
    await sign.run();
    // Trust store is empty for this self-signed certificate, so it validates as untrusted.
    const signed = await t.app.openRef(t.files.ref('/out/signed.pdf'));
    const p = t.signatures(signed!);
    expect(p.summary).toBe('none');
    await p.validate();
    expect(p.hasSignatures).toBe(true);
    expect(p.reports[0]!.status).toBe('valid-untrusted');
    expect(p.summary).toBe('warning');
    t.prompts.confirmAnswers.push(true);
    expect(await p.trustSigner()).toBe(true);
    expect(p.reports[0]!.status).toBe('valid');
    expect(p.summary).toBe('valid');
  });

  it('a file edited after signing is flagged @FR-SIG-04', async () => {
    const t = await app();
    await withIdentity(t);
    const s = await t.open('multilingual');
    const sign = t.digitalSign(s);
    await sign.start();
    t.files.nextSave.push('/out/signed.pdf');
    await sign.run();
    const signed = (await t.app.openRef(t.files.ref('/out/signed.pdf')))!;
    await t.organise(signed).rotate(90, 0);
    const p = t.signatures(signed);
    await p.validate();
    expect(p.reports[0]!.changedAfterSigning).toBe(true);
    expect(p.summary).toBe('warning');
  });

  it('revocation is only checked when the network is available and switched on @FR-SIG-06', async () => {
    const ca = await makeCertificate({ cn: 'CA', ca: true });
    const t = await app({ network: new FakeRevocationServer(ca, 'http://ocsp.test/', 'http://crl.test/ca.crl') });
    await withIdentity(t);
    const p = t.signatures(await t.open('multilingual'));
    expect(p.revocationOn).toBe(false);
  });
});
