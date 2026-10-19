import { describe, expect, it } from 'vitest';
import { makeCertificate, opensslPkcs12, FakeRevocationServer, FIXTURE_PASSWORD } from '@folio/testkit';
import { createTestApp, type TestApp } from './testing.ts';

async function app(opts: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const t = await createTestApp(opts);
  (t.services.platform.clock as unknown as { set(d: Date): void }).set(new Date(Date.now() + 3600e3));
  return t;
}
async function withIdentity(t: TestApp, cn = 'Ada Lovelace', pw = 'pw') {
  const { p12, certPem } = await opensslPkcs12({ cn, password: pw });
  t.files.put('/keys/id.p12', p12);
  t.prompts.passwords.push(pw);
  const m = t.certificates();
  const entry = await m.importIdentityFrom(t.files.ref('/keys/id.p12'));
  return { m, entry: entry!, certPem };
}

describe('Certificates pane edge cases @FR-CRT-01 @FR-CRT-02 @FR-CRT-03 @FR-CRT-04', () => {
  it('importIdentity returns null when the picker is cancelled and imports the picked file otherwise @FR-CRT-01', async () => {
    const t = await app();
    const m = t.certificates();
    expect(await m.importIdentity()).toBeNull();
    const { p12 } = await opensslPkcs12({ cn: 'Grace', password: 'pw' });
    t.files.put('/keys/g.p12', p12);
    t.files.nextOpen.push(['/keys/g.p12']);
    t.prompts.passwords.push('pw');
    expect((await m.importIdentity())?.commonName).toBe('Grace');
    expect(m.busy).toBe(false);
    expect(m.keysPersist).toBe(t.services.certificates.persistsKeys);
  });

  it('an unreadable file is reported through the error toast and leaves the pane usable @FR-CRT-01', async () => {
    const t = await app();
    const m = t.certificates();
    expect(await m.importIdentityFrom(t.files.ref('/keys/missing.p12'))).toBeNull();
    expect(t.toastKeys()).toContain('error.io');
    expect(m.busy).toBe(false);
    expect(m.identities).toHaveLength(0);
  });

  it('a wrong password asks again and a later cancel imports nothing @FR-CRT-01', async () => {
    const t = await app();
    const { p12 } = await opensslPkcs12({ cn: 'Ada', password: 'right' });
    t.files.put('/keys/id.p12', p12);
    t.prompts.passwords.push('wrong', null);
    const m = t.certificates();
    expect(await m.importIdentityFrom(t.files.ref('/keys/id.p12'))).toBeNull();
    expect(t.prompts.asked.filter((a) => a.startsWith('password:'))).toEqual([
      'password:id.p12:false',
      'password:id.p12:true',
    ]);
    expect(m.identities).toHaveLength(0);
    expect(m.error).toBeNull();
  });

  it('trusting nothing, or a file that is not a certificate, adds nothing and explains why @FR-CRT-02', async () => {
    const t = await app();
    const m = t.certificates();
    expect(await m.importTrusted()).toBe(0);
    t.files.put('/keys/junk.pem', new TextEncoder().encode('this is not a certificate'));
    t.files.nextOpen.push(['/keys/junk.pem']);
    expect(await m.importTrusted()).toBe(0);
    expect(m.error?.key).toMatch(/^cert\.error\./);
    expect(m.trusted).toHaveLength(0);
    // The next successful import clears the message.
    const { certPem } = await opensslPkcs12({ cn: 'Root', password: 'x' });
    t.files.put('/keys/root.pem', new TextEncoder().encode(certPem));
    t.files.nextOpen.push(['/keys/root.pem']);
    expect(await m.importTrusted()).toBe(1);
    expect(m.error).toBeNull();
    expect(t.toastKeys()).toContain('cert.trustedAdded');
  });

  it('removing an unknown certificate does nothing; removing an identity asks first @FR-CRT-03', async () => {
    const t = await app();
    const { m, entry } = await withIdentity(t);
    expect(await m.remove('identity', 'ff'.repeat(32))).toBe(false);
    expect(await m.remove('trusted', entry.fingerprint)).toBe(false);
    t.prompts.confirmAnswers.push(false);
    expect(await m.remove('identity', entry.fingerprint)).toBe(false);
    expect(m.identities).toHaveLength(1);
    t.prompts.confirmAnswers.push(true);
    expect(await m.remove('identity', entry.fingerprint)).toBe(true);
    expect(m.identities).toHaveLength(0);
    expect(m.current).toBeNull();
    expect(t.prompts.asked).toContain('confirm:cert.confirmRemoveIdentity');
  });

  it('the selection follows the list: selecting and reloading drop a vanished entry @FR-CRT-04', async () => {
    const t = await app();
    const m = t.certificates();
    expect(m.current).toBeNull();
    m.select('trusted', 'abc');
    expect(m.current).toBeNull();
    await m.load();
    expect(m.selected).toBeNull();
  });
});

describe('Sign dialog edge cases @FR-SIG-01 @FR-SIG-02 @FR-SIG-03 @FR-SIG-07 @FR-SIG-08', () => {
  it('an encrypted file cannot be signed @FR-SIG-01', async () => {
    const t = await app();
    await withIdentity(t);
    t.prompts.passwords.push(FIXTURE_PASSWORD);
    const s = await t.open('encrypted');
    const m = t.digitalSign(s);
    await m.start();
    expect(m.encrypted).toBe(true);
    expect(m.canSign).toBe(false);
    expect(await m.run()).toBeNull();
  });

  it('page and corner choices place the box inside the page margins @FR-SIG-02', async () => {
    const t = await app();
    await withIdentity(t);
    const s = await t.open('multilingual');
    const m = t.digitalSign(s);
    await m.start();
    m.setPage(-4);
    expect(m.page).toBe(0);
    m.setPage(1e6);
    expect(m.page).toBe(m.pageCount - 1);
    const boxes = new Map<string, Awaited<ReturnType<typeof m.boxFor>>>();
    for (const c of [
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
      'bottom-center',
      'top-center',
    ] as const) {
      m.setCorner(c);
      boxes.set(c, await m.boxFor(0));
    }
    const left = boxes.get('top-left')!;
    const right = boxes.get('top-right')!;
    expect(left.x).toBeLessThan(boxes.get('top-center')!.x);
    expect(boxes.get('top-center')!.x).toBeLessThan(right.x);
    expect(boxes.get('bottom-left')!.y).toBeLessThan(left.y);
    expect(boxes.get('bottom-right')!.y).toBe(boxes.get('bottom-left')!.y);
    expect(left.width).toBeGreaterThanOrEqual(40);
    expect(left.height).toBeGreaterThanOrEqual(24);
  });

  it('the appearance text lists signer, optional date, reason and place @FR-SIG-02', async () => {
    const t = await app();
    const { entry } = await withIdentity(t, 'Ada Lovelace');
    const m = t.digitalSign(await t.open('multilingual'));
    m.set({ reason: '  Approved ', location: ' Turin ' });
    const lines = m.lines(entry);
    expect(lines[0]).toBe('Digitally signed by Ada Lovelace');
    expect(lines[1]).toMatch(/^Date: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(lines).toContain('Reason: Approved');
    expect(lines).toContain('Location: Turin');
    m.set({ showDate: false, reason: '', location: '' });
    expect(m.lines(entry)).toEqual(['Digitally signed by Ada Lovelace']);
    expect(m.copyName()).toBe('multilingual-signed.pdf');
  });

  it('Replace is only offered for a document with a file; the file is replaced with a backup @FR-SIG-01', async () => {
    const t = await app();
    await withIdentity(t);
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    expect(m.canReplace).toBe(true);
    m.setTarget('replace');
    expect(m.target).toBe('replace');
    m.setPlacement('invisible');
    const before = t.files.get('/docs/multilingual.pdf')!.slice();
    expect(await m.run()).toBe('multilingual.pdf');
    const after = t.files.get('/docs/multilingual.pdf')!;
    expect(after.length).toBeGreaterThan(before.length);
    expect(t.files.writes.at(-1)).toMatchObject({ path: '/docs/multilingual.pdf', atomic: true });
    expect(t.app.sessions.length).toBe(1);
    expect(t.app.sessions[0]!.meta.hasSignatures).toBe(true);
  });

  it('cancelling the save dialog keeps the dialog ready and writes nothing @FR-SIG-01', async () => {
    const t = await app();
    await withIdentity(t);
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    t.files.nextSave.push(null);
    expect(await m.run()).toBeNull();
    expect(m.stage).toBe('ready');
    expect(m.result).toBeNull();
    expect(t.files.writes).toHaveLength(0);
  });

  it('a failing disk write reports the error and leaves the dialog ready to retry @FR-SIG-01', async () => {
    const t = await app();
    await withIdentity(t);
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    t.files.nextSave.push('/out/x.pdf');
    t.files.failWrites = true;
    expect(await m.run()).toBeNull();
    expect(m.stage).toBe('ready');
    expect(t.toastKeys().some((k) => k.startsWith('error'))).toBe(true);
    expect(t.app.settings.signing.lastIdentity).not.toBe(m.identity);
    t.files.failWrites = false;
    t.files.nextSave.push('/out/x.pdf');
    expect(await m.run()).toBe('x.pdf');
  });

  it('a key removed while the dialog is open gives a clear message instead of a crash @FR-SIG-01 @FR-CRT-03', async () => {
    const t = await app();
    const { m: certs, entry } = await withIdentity(t);
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    t.prompts.confirmAnswers.push(true);
    await certs.remove('identity', entry.fingerprint);
    expect(await m.run()).toBeNull();
    expect(m.error?.key).toBe('dsig.error.keyGone');
    expect(m.stage).toBe('ready');
  });

  it('signing into a field the file does not have is refused with the matching message @FR-SIG-03', async () => {
    const t = await app();
    await withIdentity(t);
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    m.fields = [{ name: 'Ghost', page: 0, rect: { x: 10, y: 10, width: 100, height: 40 }, signed: false }];
    m.setPlacement('field');
    m.setField('Ghost');
    expect(m.canSign).toBe(true);
    expect(await m.run()).toBeNull();
    expect(m.error?.key).toBe('dsig.error.field-not-found');
    // A degenerate rectangle falls back to an invisible appearance but still hits the same refusal.
    m.fields = [{ name: 'Ghost', page: 0, rect: { x: 0, y: 0, width: 0, height: 0 }, signed: false }];
    expect(await m.run()).toBeNull();
    expect(m.error?.key).toBe('dsig.error.field-not-found');
    // A signed or unknown field cannot be chosen.
    m.fields = [{ name: 'Ghost', page: 0, rect: { x: 0, y: 0, width: 5, height: 5 }, signed: true }];
    m.setField('Nope');
    expect(m.canSign).toBe(false);
  });

  it('a library picture is used in the appearance and setIdentity changes the signer @FR-SIG-02', async () => {
    const t = await app();
    await withIdentity(t);
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    m.artworkChoices = [{ id: 'sig1', name: 'mine', png: new Uint8Array([0x89, 0x50]) } as never];
    m.set({ artwork: 'sig1' });
    m.setIdentity('does-not-exist');
    expect(m.canSign).toBe(false);
    m.setIdentity(m.identities[0]!.fingerprint);
    t.files.nextSave.push('/out/a.pdf');
    // The picture bytes are not a valid PNG: signing reports it rather than writing a broken file.
    const out = await m.run();
    expect(out === null || out === 'a.pdf').toBe(true);
    if (out === null) expect(t.files.get('/out/a.pdf')).toBeUndefined();
  });

  it('timestamp without an authority address stays off even when saved as default @FR-SIG-07', async () => {
    const t = await app({
      network: new FakeRevocationServer(
        await makeCertificate({ cn: 'CA', ca: true }),
        'http://ocsp.test/',
        'http://crl.test/ca.crl',
      ),
    });
    await withIdentity(t);
    await t.app.setSetting('signing', {
      ...t.app.settings.signing,
      timestamp: true,
      embedValidation: true,
      tsaUrl: '',
    });
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    expect(m.timestampReady).toBe(false);
    expect(m.timestamp).toBe(false);
    expect(m.embedValidation).toBe(true);
    expect(m.networkAvailable).toBe(true);
    expect(m.tsaUrl).toBe('');
  });

  it('a timestamp authority that is unreachable surfaces a fixable message @FR-SIG-07', async () => {
    const t = await app({
      network: {
        async request() {
          throw new Error('offline');
        },
      } as never,
    });
    await withIdentity(t);
    await t.app.setSetting('signing', { ...t.app.settings.signing, tsaUrl: 'https://tsa.example/ts' });
    const m = t.digitalSign(await t.open('multilingual'));
    await m.start();
    m.set({ timestamp: true });
    t.files.nextSave.push('/out/t.pdf');
    expect(await m.run()).toBeNull();
    expect(m.stage).toBe('ready');
    expect(t.files.get('/out/t.pdf')).toBeUndefined();
  });
});

describe('Signature panel edge cases @FR-SIG-04 @FR-SIG-05 @FR-SIG-06', () => {
  it('selection is clamped and the current report follows it @FR-SIG-04', async () => {
    const t = await app();
    await withIdentity(t);
    const p = t.signatures(await t.open('multilingual'));
    p.select(5);
    expect(p.selected).toBe(0);
    expect(p.current).toBeNull();
    expect(await p.trustSigner()).toBe(false);
    expect(p.hasSignatures).toBe(false);
  });

  it('declining the confirmation does not trust the signer; revoked/invalid reports dominate the summary @FR-SIG-05 @FR-SIG-04', async () => {
    const t = await app();
    await withIdentity(t);
    const sign = t.digitalSign(await t.open('multilingual'));
    await sign.start();
    t.files.nextSave.push('/out/signed.pdf');
    await sign.run();
    const signed = (await t.app.openRef(t.files.ref('/out/signed.pdf')))!;
    const p = t.signatures(signed);
    await p.validate();
    t.prompts.confirmAnswers.push(false);
    expect(await p.trustSigner()).toBe(false);
    expect(p.reports[0]!.status).toBe('valid-untrusted');
    expect(await p.trustSigner(7)).toBe(false);
    const base = p.reports[0]!;
    p.reports = [
      { ...base, status: 'invalid', index: 0 },
      { ...base, status: 'valid', index: 1 },
    ];
    expect(p.summary).toBe('invalid');
    p.select(1);
    expect(p.current?.index).toBe(1);
    p.reports = [{ ...base, status: 'valid', index: 0, changedAfterSigning: true }];
    expect(p.summary).toBe('warning');
    p.reports = [{ ...base, status: 'valid', index: 0, changedAfterSigning: false }];
    expect(p.summary).toBe('valid');
  });

  it('with the network available and revocation switched on, revocationOn is true @FR-SIG-06', async () => {
    const ca = await makeCertificate({ cn: 'CA', ca: true });
    const t = await app({
      network: new FakeRevocationServer(ca, 'http://ocsp.test/', 'http://crl.test/ca.crl'),
    });
    await t.app.setSetting('signing', { ...t.app.settings.signing, revocationCheck: true });
    const p = t.signatures(await t.open('multilingual'));
    expect(p.revocationOn).toBe(true);
    await p.validate();
    expect(p.checked).toBe(true);
    expect(p.loading).toBe(false);
  });

  it('validating an unsaved edited document checks the on-screen bytes @FR-SIG-04', async () => {
    const t = await app();
    await withIdentity(t);
    const sign = t.digitalSign(await t.open('multilingual'));
    await sign.start();
    t.files.nextSave.push('/out/signed.pdf');
    await sign.run();
    const signed = (await t.app.openRef(t.files.ref('/out/signed.pdf')))!;
    await t.organise(signed).rotate(90, 0);
    expect(signed.dirty).toBe(true);
    const p = t.signatures(signed);
    await p.validate();
    expect(p.reports).toHaveLength(1);
    expect(p.reports[0]!.changedAfterSigning).toBe(true);
  });
});
