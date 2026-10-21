import { describe, expect, it } from 'vitest';
import { qpdfCheck } from '@folio/testkit';
import { createTestApp } from './testing.ts';

// FR-SEC-13: a signed document is guarded where commands run, not in each feature.
describe('signed documents: edit-time guard and state', () => {
  it('the first invalidating change asks once, remembers the answer for the session and Cancel changes nothing @FR-SEC-13', async () => {
    const t = await createTestApp();
    const s = await t.open('signed-form');
    const pages = t.organise(s);
    expect(s.signatureStatus).toBe('valid');
    t.prompts.confirmAnswers = [false];
    await pages.rotate(90, 0);
    expect(t.prompts.asked.filter((a) => a === 'confirm:signed.editConfirm')).toHaveLength(1);
    expect(s.dirty).toBe(false);
    expect(s.signatureStatus).toBe('valid');
    t.prompts.confirmAnswers = [true];
    await pages.rotate(90, 0);
    expect(s.dirty).toBe(true);
    expect(s.signatureStatus).toBe('will-break');
    // Remembered: the second change does not ask again.
    await pages.rotate(90, 0);
    expect(t.prompts.asked.filter((a) => a === 'confirm:signed.editConfirm')).toHaveLength(2);
    expect(s.signedEditAccepted).toBe(true);
  });

  it('filling in a field does not warn about invalidation; one note says the signatures stay valid @FR-SEC-13 @FR-FRM-01', async () => {
    const t = await createTestApp();
    const s = await t.open('signed-form');
    s.setMode('fill');
    const form = t.form(s);
    await form.load();
    const name = form.fields.find((f) => f.name === 'person.name')!;
    await form.set(name, 'Marta');
    await form.set(form.fields.find((f) => f.name === 'code')!, 'ab12');
    expect(t.prompts.asked.filter((a) => a.startsWith('confirm:'))).toEqual([]);
    expect(t.toastKeys().filter((k) => k === 'signed.keepsHint')).toHaveLength(1);
    expect(s.signatureStatus).toBe('keeps');
    // Undo brings the document back to its signed state.
    await s.undo();
    await s.undo();
    expect(s.signatureStatus).toBe('valid');
  });

  it('every kind of non-form change is classified as invalidating @FR-SEC-13', async () => {
    const t = await createTestApp();
    const s = await t.open('signed-form');
    t.prompts.confirmAnswers = [true];
    const svc = t.services;
    const cases = [
      svc.pages.rotate(s.doc, [0], 90),
      svc.pages.insertBlank(s.doc, 0, { width: 595, height: 842 }),
      svc.annotations.add(0, { type: 'note', rect: { x: 100, y: 100, width: 20, height: 20 }, contents: 'x' } as never),
      svc.documents.removeAllMetadata(),
    ];
    for (const c of cases) expect(c.keepsSignatures === true).toBe(false);
    const fields = await s.fields();
    expect(svc.forms.fill(fields.find((f) => f.name === 'code')!, 'x').keepsSignatures).toBe(true);
    // A composite keeps the signatures only if every member does.
    expect(svc.forms.reset(fields)!.keepsSignatures).toBe(true);
  });

  it('a saved invalidating change leaves the document broken; removing the signatures lets it be saved freely @FR-SEC-13 @FR-APP-11', async () => {
    const t = await createTestApp();
    const s = await t.open('signed-form');
    expect(s.meta.hasSignatures).toBe(true);
    t.prompts.confirmAnswers = [true, true];
    t.prompts.signedAnswers = ['incremental'];
    await t.organise(s).rotate(90, 0);
    expect(s.signatureStatus).toBe('will-break');
    await t.app.save(s);
    expect(s.signatureStatus).toBe('broken');

    const fresh = await t.open('signed-form', '/docs/second.pdf');
    t.prompts.confirmAnswers = [true];
    expect(await t.app.removeSignatures(fresh)).toBe(true);
    expect(fresh.meta.hasSignatures).toBe(false);
    expect(fresh.signatureStatus).toBe('none');
    await t.app.save(fresh);
    const bytes = t.files.get('/docs/second.pdf')!;
    await expect(bytes).toBeValidPdf();
    expect((await qpdfCheck(bytes)).ok).toBe(true);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('/ByteRange');
    // The same file opened again has no signatures and the form is still there.
    const reopened = await t.app.openRef(t.files.ref('/docs/second.pdf'));
    expect(reopened!.meta.hasSignatures).toBe(false);
    expect((await reopened!.fields()).some((f) => f.name === 'person.name')).toBe(true);
  });

  it('Remove signatures can be declined and undone @FR-SEC-13', async () => {
    const t = await createTestApp();
    const s = await t.open('signed-form');
    t.prompts.confirmAnswers = [false];
    expect(await t.app.removeSignatures(s)).toBe(false);
    expect(s.meta.hasSignatures).toBe(true);
    t.prompts.confirmAnswers = [true];
    expect(await t.app.removeSignatures(s)).toBe(true);
    await s.undo();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.meta.hasSignatures).toBe(true);
  });
});
