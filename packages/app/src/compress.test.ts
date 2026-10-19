import { describe, expect, it } from 'vitest';
import { FIXTURE_PASSWORD, qpdfCheck, sharedEngine } from '@folio/testkit';
import { createTestApp } from './testing.ts';

describe('Reduce file size dialog model @FR-OPT-01', () => {
  it('shows an estimate per preset, writes a copy and leaves the open document alone @FR-OPT-01 @FR-OPT-11', async () => {
    const t = await createTestApp();
    const s = await t.open('photos');
    const before = s.byteSize!;
    const m = t.compress(s);
    await m.start();
    expect(m.stage).toBe('ready');
    for (const p of ['light', 'balanced', 'strong'] as const) expect(m.estimates[p]).toBeGreaterThan(0);
    expect(m.estimates.strong!).toBeLessThan(m.estimates.balanced!);
    expect(m.estimates.balanced!).toBeLessThan(m.estimates.light!);
    expect(m.canReplace).toBe(true);

    t.files.nextSave.push('/out/photos-compressed.pdf');
    await m.setPreset('balanced');
    const name = await m.run();
    expect(name).toBe('photos-compressed.pdf');
    const out = t.files.get('/out/photos-compressed.pdf')!;
    expect(out.length).toBeLessThan(before * 0.6);
    expect((await qpdfCheck(out)).ok).toBe(true);
    expect(m.result!.saved).toBeGreaterThan(0.4);
    expect(t.toastKeys()).toContain('compress.done');
    // No history entry, document not dirty, original file untouched.
    expect(s.dirty).toBe(false);
    expect(s.history.state.canUndo).toBe(false);
    expect(t.files.get('/docs/photos.pdf')!.length).toBe(before);
  });

  it('a signed file cannot be replaced; a result that is not smaller writes nothing @FR-OPT-11 @FR-OPT-01', async () => {
    const t = await createTestApp();
    const signed = await t.open('signed');
    const m = t.compress(signed);
    expect(m.signed).toBe(true);
    expect(m.canReplace).toBe(false);
    m.setTarget('replace');
    expect(m.target).toBe('copy');
    const s2 = await t.open('text', '/docs/text.pdf');
    const m2 = t.compress(s2);
    await m2.start();
    // Pretend the file was already as small as it can be.
    (s2 as { byteSize?: number }).byteSize = 1;
    t.files.nextSave.push('/out/never.pdf');
    expect(await m2.run()).toBeNull();
    expect(t.toastKeys()).toContain('compress.noGain');
    expect(t.files.get('/out/never.pdf')).toBeUndefined();
  });

  it('replace overwrites the open file, keeps a backup and reopens it @FR-OPT-01', async () => {
    const t = await createTestApp();
    const s = await t.open('photos');
    const original = t.files.get('/docs/photos.pdf')!.length;
    const m = t.compress(s);
    await m.start();
    m.setTarget('replace');
    await m.run();
    expect(t.files.get('/docs/photos.pdf')!.length).toBeLessThan(original * 0.6);
    expect(t.app.sessions.length).toBe(1);
    expect(t.app.active!.dirty).toBe(false);
    expect(t.app.active!.byteSize).toBeLessThan(original * 0.6);
  });

  it('an encrypted file asks for its password again and its copy stays protected @FR-OPT-11 @FR-APP-12', async () => {
    const t = await createTestApp();
    await t.put('/docs/secret.pdf', 'encrypted');
    t.prompts.passwords = [FIXTURE_PASSWORD];
    const s = (await t.app.openRef(t.files.ref('/docs/secret.pdf')))!;
    const m = t.compress(s);
    await m.start();
    // The session does not keep the password (FR-APP-12): the copy needs it once more.
    t.prompts.passwords = [FIXTURE_PASSWORD];
    t.files.nextSave.push('/out/secret-compressed.pdf');
    (s as { byteSize?: number }).byteSize = 10 ** 7;
    expect(await m.run()).toBe('secret-compressed.pdf');
    expect(m.result!.warnings).toContain('encrypted');
    await expect((await sharedEngine()).open(t.files.get('/out/secret-compressed.pdf')!)).rejects.toMatchObject({ code: 'passwordRequired' });
    // Cancelling the password writes nothing.
    t.prompts.passwords = [null];
    t.files.nextSave.push('/out/never.pdf');
    expect(await m.run()).toBeNull();
    expect(t.files.get('/out/never.pdf')).toBeUndefined();
  });
});
