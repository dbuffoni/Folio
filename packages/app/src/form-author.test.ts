import { describe, expect, it } from 'vitest';
import { applyToRect, pageToViewMatrix, rotatedSize } from '@folio/core';
import { FakeAiProvider } from '@folio/ai';
import { FakeOcrEngine, flatFormDoc, ocrLinesForScannedForm, scannedFormDoc } from '@folio/testkit';
import { createTestApp } from './testing.ts';

describe('Edit form mode @FR-FRM-08 @FR-FRM-11 @FR-FRM-16 @FR-FRM-17', () => {
  it('draw a field, name it from its label, set properties, move with the keyboard, delete, undo @FR-FRM-08 @FR-FRM-11 @FR-FRM-16', async () => {
    const t = await createTestApp();
    const s = await t.open('invoice');
    const m = t.author(s);
    expect(await m.toggle()).toBe(true);
    expect(m.active).toBe(true);
    // "Total due: …" is printed just above: a field drawn under it takes its name.
    m.setTool('text');
    expect(await m.createAt(0, { x: 380, y: 450 }, { x: 540, y: 472 })).toBe(true);
    const created = m.field!;
    expect(created.type).toBe('text');
    expect(created.name).toMatch(/^Total/);
    expect(m.tool).toBe('select');
    // Nothing else changed; the field is empty and fillable at once after leaving the mode.
    expect(await m.update({ required: true, tooltip: 'Amount', maxLength: 12 })).toBe(true);
    expect(m.field).toMatchObject({ required: true, label: 'Amount', maxLength: 12 });
    const before = m.field!.widgets[0]!.rect;
    expect(await m.nudge(1, 0, false)).toBe(true);
    expect(await m.nudge(0, -1, true)).toBe(true);
    const after = m.field!.widgets[0]!.rect;
    expect(after.x).toBeCloseTo(before.x + 1, 0);
    expect(after.y).toBeCloseTo(before.y - 10, 0);
    // Second field: a click makes a default-size check box named Checkbox1.
    m.setTool('checkbox');
    await m.createAt(0, { x: 100, y: 300 }, null);
    expect(m.field).toMatchObject({ type: 'checkbox', name: 'Checkbox1' });
    expect(await m.rename('Agree')).toBe(true);
    expect(m.field!.name).toBe('Agree');
    expect(await m.rename(created.name)).toBe(false);
    expect(t.toastKeys()).toContain('error.invalidArgument.fieldNameTaken');
    expect(await m.remove()).toBe(true);
    expect(m.selected).toBeNull();
    // One undo per step; the document returns to its first state.
    for (let i = 0; i < 7; i++) expect(await s.undo()).toBe(true);
    await m.refresh();
    expect(m.fields).toEqual([]);
    expect(await m.toggle()).toBe(true);
    expect(m.active).toBe(false);
  });

  it('XFA and encrypted forms are not authored; a signed one asks first @FR-FRM-09 @FR-FRM-17', async () => {
    const t = await createTestApp();
    const xfa = await t.open('xfa');
    expect(await t.author(xfa).toggle()).toBe(false);
    expect(t.toastKeys()).toContain('form.author.blocked.xfa');
    const signed = await t.open('signed');
    // Entering the authoring mode changes nothing; the first change asks (the gate of the command bus, FR-SEC-13).
    expect(await t.author(signed).toggle()).toBe(true);
    t.prompts.confirmAnswers = [false];
    const authoring = t.author(signed);
    authoring.setTool('text');
    expect(await authoring.createAt(0, { x: 380, y: 450 }, { x: 540, y: 472 })).toBe(false);
    expect(t.prompts.asked).toContain('confirm:signed.editConfirm');
  });

  it('Detect fields on a vector form: no network, ghosts become fields in one step @FR-FRM-15 @FR-FRM-07', async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    t.files.put('/flat.pdf', (await flatFormDoc()).pdf);
    const s = (await t.app.openRef(t.files.ref('/flat.pdf')))!;
    const m = t.author(s);
    await m.toggle();
    expect(await m.detect([0])).toBeGreaterThanOrEqual(5);
    expect(ai.requests.length).toBe(0);
    expect(m.proposals.every((p) => p.source === 'local')).toBe(true);
    m.toggleProposal(m.proposals[0]!.id, false);
    const accepted = m.proposals.filter((p) => p.accepted).length;
    expect(await m.createProposals()).toBe(accepted);
    expect(m.proposals).toEqual([]);
    const names = (await s.doc.listFormFields()).map((f) => f.name);
    expect(names.length).toBe(accepted);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('LastName');
    await s.undo();
    await m.refresh();
    expect(m.fields).toEqual([]);
  });

  it('Detect fields on a scan needs AI with images; with a recorded answer the accepted boxes become fields @FR-FRM-15', async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    const { pdf, areas } = await scannedFormDoc({ rotate: 90 });
    t.files.put('/scan.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/scan.pdf')))!;
    const m = t.author(s);
    await m.toggle();
    // AI not switched on: the notice, hand drawing stays available.
    expect(await m.detect([0])).toBe(7);
    expect(m.notice).toBe('scanLocal');
    m.cancelProposals();
    m.setTool('text');
    expect(await m.createAt(0, { x: 200, y: 200 }, null)).toBe(true);
    await s.undo();

    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true });
    const info = s.pageInfos[0]!;
    const shown = rotatedSize(info.size, info.rotation);
    const mx = pageToViewMatrix(info.size, info.rotation, 1);
    ai.enqueue(() => ({
      fields: [],
      newAreas: areas.map((a) => {
        const v = applyToRect(mx, a.rect);
        return { page: 0, bbox: [v.x / shown.width, v.y / shown.height, (v.x + v.width) / shown.width, (v.y + v.height) / shown.height], label: a.label, fieldType: a.kind, profileKey: null, confidence: 0.9 };
      }),
    }));
    expect(await m.detect([0])).toBe(7);
    expect(m.notice).toBeNull();
    expect(await m.createProposals()).toBe(7);
    const fields = await s.doc.listFormFields();
    expect(fields.map((f) => f.type).sort()).toEqual(['checkbox', 'checkbox', 'text', 'text', 'text', 'text', 'text']);
    expect(await s.undo()).toBe(true);
    await m.refresh();
    expect(m.fields).toEqual([]);
  });

  it('Detect fields on a picture-only page reads it with OCR on this device: labelled fields, progress, no AI, undoable @FR-FRM-15', async () => {
    const { pdf, areas } = await scannedFormDoc();
    const ocr = new FakeOcrEngine(ocrLinesForScannedForm(areas));
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai, ocr });
    t.files.put('/scan.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/scan.pdf')))!;
    const m = t.author(s);
    await m.toggle();
    const seen: Array<{ done: number; total: number } | null> = [];
    m.changed.on(() => seen.push(m.reading));
    // AI is off and nothing leaves the device.
    expect(await m.detect([0])).toBe(7);
    expect(m.notice).toBe('scanOcr');
    expect(ai.requests).toHaveLength(0);
    expect(seen.some((r) => r?.total === 1)).toBe(true);
    expect(m.reading).toBeNull();
    expect(m.proposals.map((p) => p.label).sort()).toEqual(['Date of birth', 'Email', 'First name', 'Last name', 'Newsletter', 'Privacy', 'Tax code']);
    // The read languages are the user's: English by default.
    expect(ocr.calls.map((c) => c.languages)).toEqual([['eng']]);
    // Fields are named after their labels, as on a native page.
    expect(await m.createProposals()).toBe(7);
    expect((await s.doc.listFormFields()).map((f) => f.name).sort()).toEqual(['DateOfBirth', 'Email', 'FirstName', 'LastName', 'Newsletter', 'Privacy', 'TaxCode']);
    expect(await s.undo()).toBe(true);
    // The page is not read again in this session.
    await m.refresh();
    expect(await m.detect([0])).toBe(7);
    expect(ocr.calls).toHaveLength(1);
  });

  it('reading a scan can be cancelled and leaves nothing proposed @FR-FRM-15', async () => {
    const { pdf, areas } = await scannedFormDoc();
    const ocr = new FakeOcrEngine(ocrLinesForScannedForm(areas));
    const t = await createTestApp({ ocr });
    t.files.put('/scan.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/scan.pdf')))!;
    const m = t.author(s);
    await m.toggle();
    ocr.onPage = () => m.cancelReading();
    expect(await m.detect([0])).toBe(0);
    expect(m.proposals).toEqual([]);
    expect(m.detecting).toBe(false);
    expect(t.toastKeys()).not.toContain('error.unexpected');
  });
});
