// FR-SEC-07 (respect protected files) and FR-SEC-12 (remove hidden data) through the application layer.
import { describe, expect, it } from 'vitest';
import { FIXTURE_OWNER_PASSWORD, HIDDEN_MARKERS, pdfinfo, qpdfQdf } from '@folio/testkit';
import { createTestApp, settle } from './testing.ts';

describe('respect protected files @FR-SEC-07', () => {
  it('disables the commands a restricted file forbids, with the reason, and keeps viewing alive', async () => {
    const t = await createTestApp();
    const s = await t.open('restricted');
    await settle();
    expect(s.meta.isEncrypted).toBe(true);
    const ctx = t.ctx();
    for (const id of ['file.print', 'tool.edit-text', 'tool.highlight', 'pages.rotateCw', 'edit.copy', 'export.images', 'file.metadata', 'file.hiddenData'])
      expect([id, t.registry.isEnabled(id, ctx)]).toEqual([id, false]);
    expect(t.registry.denial('file.print', ctx)).toBe('perm.denied.print');
    expect(t.registry.denial('tool.edit-text', ctx)).toBe('perm.denied.modify');
    expect(t.registry.denial('tool.highlight', ctx)).toBe('perm.denied.annotate');
    expect(t.registry.denial('task.split', ctx)).toBe('perm.denied.assemble');
    // Viewing, searching and zoom are never disabled.
    for (const id of ['view.zoomIn', 'edit.find', 'view.fitWidth', 'file.properties', 'tool.select', 'file.saveAs'])
      expect([id, t.registry.isEnabled(id, ctx)]).toEqual([id, true]);
    expect(await t.registry.run('file.print', ctx)).toBe(false);
    expect(t.ui.dialog).toBeNull();
  });
  it('lists denied commands in the palette with their reason', async () => {
    const t = await createTestApp();
    await t.open('restricted');
    await settle();
    const hit = t.registry.search('print', t.ctx(), (k) => k).find((i) => i.command.id === 'file.print');
    expect(hit?.denied).toBe('perm.denied.print');
  });
  it('only denies what the flags forbid @FR-SEC-07', async () => {
    const t = await createTestApp();
    await t.open('copy-restricted');
    await settle();
    const ctx = t.ctx();
    expect(t.registry.isEnabled('file.print', ctx)).toBe(true);
    expect(t.registry.isEnabled('tool.edit-text', ctx)).toBe(true);
    expect(t.registry.isEnabled('export.images', ctx)).toBe(false);
  });
  it('allows everything on unprotected files', async () => {
    const t = await createTestApp();
    await t.open('text');
    await settle();
    const ctx = t.ctx();
    expect(['file.print', 'tool.edit-text', 'tool.highlight', 'export.images'].map((id) => t.registry.isEnabled(id, ctx))).toEqual([true, true, true, true]);
    expect(t.registry.isEnabled('file.unlock', ctx)).toBe(false);
  });
  it('lifts the restrictions for the session with the owner password and says so', async () => {
    const t = await createTestApp();
    const s = await t.open('restricted');
    await settle();
    t.prompts.passwords = [FIXTURE_OWNER_PASSWORD];
    expect(await t.app.unlockRestrictions(s)).toBe(true);
    await settle();
    const now = t.app.active!;
    expect(now.meta.ownerUnlocked).toBe(true);
    expect(now.meta.permissions).toBeUndefined();
    expect(t.app.sessions).toHaveLength(1);
    expect(t.registry.isEnabled('file.print', t.ctx())).toBe(true);
    expect(t.toastKeys()).toContain('perm.liftedToast');
  });
  it('rejects a wrong owner password and keeps the restrictions', async () => {
    const t = await createTestApp();
    const s = await t.open('restricted');
    await settle();
    t.prompts.passwords = ['wrong', null];
    expect(await t.app.unlockRestrictions(s)).toBe(false);
    expect(t.app.active!.meta.permissions).toBeDefined();
    expect(t.prompts.asked.filter((a) => a.startsWith('password:')).map((a) => a.split(':')[2])).toEqual(['false', 'true']);
  });
  it('keeps the protection when saving a copy and the copy stays valid', async () => {
    const t = await createTestApp();
    const s = await t.open('restricted');
    await settle();
    t.files.nextSave = ['/out/copy.pdf'];
    expect(await t.app.exportCopy(s)).toBe(true);
    const bytes = t.files.get('/out/copy.pdf')!;
    await expect(bytes).toBeValidPdf();
    expect((await pdfinfo(bytes)).encrypted).toBe(true);
  });
});

describe('remove hidden data @FR-SEC-12', () => {
  const all = { info: true, xmp: true, thumbnails: true, scripts: true, annotationAuthors: true, attachments: true };
  it('is one undoable step; the next save writes a full file with no trace @FR-SEC-12 @FR-SEC-04', async () => {
    const t = await createTestApp();
    const s = await t.open('hidden-data');
    await settle();
    const report = await t.app.removeHiddenData(s, all);
    expect(report?.removed).toMatchObject({ info: true, xmp: true, thumbnails: 1, annotationAuthors: 1, attachments: 1 });
    expect(s.historyState.done.map((d) => d.label.key)).toEqual(['cmd.removeHiddenData']);
    expect(s.fullRewrite).toBe(true);
    await settle();
    expect(s.meta.author).toBe('');
    expect(await t.app.save(s)).toBe(true);
    const bytes = t.files.get('/docs/hidden-data.pdf')!;
    const text = Buffer.from(bytes).toString('latin1') + (await qpdfQdf(bytes));
    for (const needle of Object.values(HIDDEN_MARKERS)) expect(text).not.toContain(needle);
    await expect(bytes).toBeValidPdf();
    expect(s.fullRewrite).toBe(false);
    // Undo brings it back (until saved).
    expect(await s.undo()).toBe(true);
    await settle();
    expect(s.meta.author).toBe(HIDDEN_MARKERS.author);
  });
  it('a signed file never gets an incremental save after hidden data was removed, and a cleaned copy leaves the original alone', async () => {
    const t = await createTestApp();
    const s = await t.open('signed');
    await settle();
    t.files.nextSave = ['/out/clean.pdf'];
    const report = await t.app.saveCleanedCopy(s, all);
    expect(report).toBeDefined();
    expect(s.dirty).toBe(false);
    expect(s.meta.hasSignatures).toBe(true);
    await expect(t.files.get('/out/clean.pdf')!).toBeValidPdf();
  });
});
