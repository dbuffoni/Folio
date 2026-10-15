// Epics E1–E7 accepted at service level (SPEC §16.9): complete user flows driven through the UI-less
// application layer, with the produced files checked by independent tools.
import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@folio/ai';
import type { StampAnnotation } from '@folio/ports';
import {
  FIXTURE_PASSWORD,
  PERSON,
  flatFormDoc,
  inkRatio,
  mutoolDraw,
  pdfcpuFormFields,
  pdffonts,
  pdfinfo,
  pdftoppm,
  pdftotext,
  sampleJpeg,
  samplePng,
  signaturePng,
} from '@folio/testkit';
import { createTestApp, markers, settle } from './testing.ts';

describe('E1 Merge two PDFs', () => {
  it('reorders, merges and opens a new tab with bookmarks per file; originals untouched @FR-MRG-01 @FR-MRG-02 @FR-MRG-06', async () => {
    const t = await createTestApp();
    await t.put('/docs/report.pdf', 'text');
    await t.put('/docs/annex.pdf', 'bookmarks');
    const before = [t.files.get('/docs/report.pdf')!, t.files.get('/docs/annex.pdf')!].map((b) =>
      Buffer.from(b).toString('base64'),
    );
    const w = t.merge();
    await w.addFiles([t.files.ref('/docs/report.pdf'), t.files.ref('/docs/annex.pdf')]);
    expect(w.items.map((i) => [i.name, i.info.pageCount])).toEqual([
      ['report.pdf', 3],
      ['annex.pdf', 5],
    ]);
    expect([w.totalPages, w.canMerge]).toEqual([8, true]);
    w.move(w.items[1]!.id, 0);
    await w.setRange(w.items[0]!.id, '1-2');
    expect(w.totalPages).toBe(5);
    const session = await w.mergeAndOpen();
    expect(session).toMatchObject({ name: 'annex (merged).pdf', pageCount: 5, dirty: true });
    expect(t.app.active).toBe(session);
    expect(
      (await session!.doc.getOutline()).map((n) => [n.title, (n.target as { page: number }).page]),
    ).toEqual([
      ['annex', 0],
      ['report', 2],
    ]);
    expect((await markers(session!)).slice(2)).toEqual([1, 2, 3]);
    expect(
      [t.files.get('/docs/report.pdf')!, t.files.get('/docs/annex.pdf')!].map((b) =>
        Buffer.from(b).toString('base64'),
      ),
    ).toEqual(before);
    t.files.nextSave = ['/docs/merged.pdf'];
    expect(await t.app.save(session!)).toBe(true);
    await expect(t.files.get('/docs/merged.pdf')!).toBeValidPdf();
    await expect(t.files.get('/docs/merged.pdf')!).toHavePageCount(5);
  });

  it('merging open tabs uses their current (unsaved) content, including tabs that were never saved @FR-MRG-01 @FR-APP-05', async () => {
    const t = await createTestApp();
    const a = await t.open('text', '/docs/a.pdf');
    await t.organise(a).delete(0);
    expect(a.dirty).toBe(true);
    const b = await t.open('invoice', '/docs/b.pdf');
    const w = t.merge();
    await w.addOpenDocuments();
    expect(w.items.map((i) => [i.name, i.info.pageCount])).toEqual([
      ['a.pdf', 2],
      ['b.pdf', b.pageCount],
    ]);
    const merged = await w.mergeAndOpen();
    expect((await markers(merged!)).slice(0, 2)).toEqual([2, 3]);
    // a tab that has no file on disk (the merge result itself) is offered too
    const w2 = t.merge();
    await w2.addOpenDocuments();
    expect(w2.items.map((i) => i.name)).toEqual(['a.pdf', 'b.pdf', 'a (merged).pdf']);
  });

  it('prompts for the password of encrypted inputs and excludes corrupt or empty ones with an inline warning @FR-MRG-01', async () => {
    const t = await createTestApp();
    await t.put('/a.pdf', 'text');
    await t.put('/locked.pdf', 'encrypted');
    await t.put('/broken.pdf', 'garbage');
    t.files.put('/photo.jpg', sampleJpeg(200, 100));
    const w = t.merge();
    await w.addFiles([
      t.files.ref('/a.pdf'),
      t.files.ref('/locked.pdf'),
      t.files.ref('/broken.pdf'),
      t.files.ref('/photo.jpg'),
    ]);
    expect(w.items.map((i) => i.info.problem)).toEqual([undefined, 'passwordRequired', 'invalid', undefined]);
    expect(w.totalPages).toBe(4);
    await w.setPassword(w.items[1]!.id, 'wrong');
    expect(w.items[1]!.info.problem).toBe('wrongPassword');
    await w.setPassword(w.items[1]!.id, FIXTURE_PASSWORD);
    expect([w.items[1]!.info.problem, w.items[1]!.info.pageCount]).toEqual([undefined, 1]);
    await w.setRange(w.items[0]!.id, '7');
    expect(w.items[0]!.info.problem).toBe('badRange');
    // A range typo must not silently drop the file: merging waits until it is fixed or the file removed.
    expect(w.canMerge).toBe(false);
    await w.setRange(w.items[0]!.id, '');
    w.sort('name');
    expect(w.items.map((i) => i.name)).toEqual(['a.pdf', 'broken.pdf', 'locked.pdf', 'photo.jpg']);
    w.setOptions({ bookmarks: false });
    t.files.nextSave = ['/out.pdf'];
    expect(await w.mergeAndSave()).toBe(true);
    await expect(t.files.get('/out.pdf')!).toHavePageCount(5);
    expect(await pdftotext(t.files.get('/out.pdf')!)).toContain('Invoce');
    w.remove(w.items[0]!.id);
    w.remove(w.items[1]!.id);
    w.remove(w.items[1]!.id);
    expect(w.items.map((i) => i.name)).toEqual(['broken.pdf']);
    expect(w.canMerge).toBe(false);
    expect(await w.mergeAndOpen()).toBeNull();
  });
});

describe('E2 Sign a document', () => {
  it('first use opens the creation dialog; the drawn signature is placed as a Stamp other viewers show; next time it is offered at once @FR-STM-01 @FR-STM-02 @FR-STM-03 @FR-STM-09 @FR-STM-12', async () => {
    const t = await createTestApp();
    const s = await t.open('invoice', '/docs/contract.pdf');
    const tools = t.tools(s);
    // G / the Sign button with an empty library: zero-friction onboarding.
    await t.registry.run('sign.sign', t.ctx());
    expect([t.sign.creating, t.ui.dialog, s.mode]).toEqual(['signature', 'signature', 'fill']);
    const strokes = [Array.from({ length: 30 }, (_, i) => ({ x: 10 + i * 6, y: 40 + Math.sin(i / 3) * 20 }))];
    const draft = t.sign.draftFromStrokes(strokes, t.sign.inkColors.blue!);
    const stored = await t.sign.save(draft, 'My signature', tools);
    expect(stored).toMatchObject({
      name: 'My signature',
      kind: 'signature',
      source: 'drawn',
      isDefault: true,
    });
    expect(t.sign.creating).toBeNull();
    // The one-time note that this is not a certificate-based signature.
    expect(t.sign.showNote).toBe(true);
    expect(t.app.settings.signatureNoteShown).toBe(true);
    t.sign.dismissNote();
    // A ghost follows the cursor, a click places it.
    expect(tools.tool).toBe('place');
    await tools.pointerMove(0, { x: 420, y: 150 });
    expect(tools.ghost!.rect!.x + tools.ghost!.rect!.width / 2).toBeCloseTo(420, 5);
    await tools.pointerMove(0, { x: 5000, y: -50 });
    expect(tools.ghost!.rect!.x + tools.ghost!.rect!.width).toBeCloseTo(612, 5);
    await tools.pointerMove(0, { x: 420, y: 150 });
    await tools.pointerDown(0, { x: 420, y: 150 });
    expect([tools.ghost, tools.tool]).toEqual([null, 'select']);
    const placed = (await s.doc.listAnnotations(0))[0] as StampAnnotation;
    expect(placed).toMatchObject({ type: 'stamp', name: 'Signature' });
    expect(s.selection).toMatchObject({ kind: 'annotations', ids: [placed.id] });
    // Drag, nudge with the arrow keys, Esc deselects.
    await tools.pointerDown(0, { x: 420, y: 150 });
    await tools.pointerMove(0, { x: 400, y: 120 }, { alt: true });
    await tools.pointerUp(0, { x: 400, y: 120 });
    await tools.nudgeSelection('ArrowRight', true);
    const moved = (await s.doc.listAnnotations(0))[0]!;
    expect(moved.rect.x).toBeCloseTo(placed.rect.x - 20 + 10, 1);
    expect(moved.rect.y).toBeCloseTo(placed.rect.y - 30, 1);
    tools.cancel();
    expect(s.selection.kind).toBe('none');
    await t.app.save();
    const bytes = t.files.get('/docs/contract.pdf')!;
    await expect(bytes).toBeValidPdf();
    await expect(bytes).toHaveAnnotation('stamp');
    const region = {
      x: moved.rect.x,
      y: 792 - moved.rect.y - moved.rect.height,
      width: moved.rect.width,
      height: moved.rect.height,
    };
    for (const img of [await pdftoppm(bytes, 1), await mutoolDraw(bytes, 1)])
      expect(inkRatio(img, region)).toBeGreaterThan(0.01);

    // A second document offers the stored signature immediately, without the note.
    const second = await t.open('text', '/docs/other.pdf');
    await t.registry.run('sign.sign', t.ctx());
    expect([t.sign.creating, t.sign.showNote, t.tools(second).tool]).toEqual([null, false, 'place']);
    await t.tools(second).pointerMove(1, { x: 300, y: 300 });
    await t.tools(second).pointerDown(1, { x: 300, y: 300 });
    expect((await second.doc.listAnnotations(1)).map((a) => a.type)).toEqual(['stamp']);
    // Esc cancels a placement without changing the document.
    await t.registry.run('sign.sign', t.ctx());
    t.tools(second).cancel();
    expect([(await second.doc.listAnnotations(1)).length, t.tools(second).ghost]).toEqual([1, null]);
  });

  it('manages the library: typed and imported signatures, initials, default, rename, delete; date and stamps @FR-STM-01 @FR-STM-02 @FR-STM-05 @FR-STM-06 @FR-STM-07', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    const tools = t.tools(s);
    t.sign.openCreate('signature');
    const typed = await t.sign.save(
      await t.sign.draftFromText('Marta Esempio', 'DancingScript', t.sign.inkColors.black!),
      'Typed',
    );
    const image = await t.sign.save(await t.sign.draftFromImage(signaturePng(), 180), 'Scanned');
    t.sign.openCreate('initials');
    await t.sign.save(await t.sign.draftFromText('ME', 'Caveat', t.sign.inkColors.blue!), 'Initials');
    expect(t.sign.of('signature').map((x) => [x.name, x.source, x.isDefault])).toEqual([
      ['Typed', 'typed', true],
      ['Scanned', 'image', false],
    ]);
    expect(t.sign.of('initials').length).toBe(1);
    await t.sign.setDefault(image!.id);
    await t.sign.rename(image!.id, 'Paper scan');
    await t.sign.remove(typed!.id);
    expect(t.sign.signatures.map((x) => [x.name, x.isDefault])).toEqual([
      ['Paper scan', true],
      ['Initials', true],
    ]);
    await t.registry.run('sign.initials', t.ctx());
    await tools.pointerMove(0, { x: 500, y: 60 });
    await tools.pointerDown(0, { x: 500, y: 60 });
    // Insert date (Ctrl+Shift+D) in the configured format.
    await t.app.setSetting('dateFormat', 'dmy');
    await t.registry.run('sign.date', t.ctx());
    await tools.pointerMove(0, { x: 200, y: 60 });
    await tools.pointerDown(0, { x: 200, y: 60 });
    // Built-in and custom stamps.
    t.sign.placeStamp(
      tools,
      t.sign.builtinStamps.find((b) => b.style?.text === 'PAID')!,
    );
    await tools.pointerMove(0, { x: 300, y: 400 });
    await tools.pointerDown(0, { x: 300, y: 400 });
    await t.sign.addTextStamp('Received', {
      text: 'RECEIVED',
      color: { r: 29, g: 78, b: 216 },
      fontFamily: 'sans',
      bold: true,
      border: true,
      rotation: 0,
    });
    await t.sign.addImageStamp('Logo', samplePng(60, 40));
    await t.sign.addSelectionStamp(s, 0, { x: 60, y: 700, width: 200, height: 40 }, 'Heading');
    expect(t.sign.customStamps.map((c) => [c.name, c.kind])).toEqual([
      ['Received', 'text'],
      ['Logo', 'image'],
      ['Heading', 'selection'],
    ]);
    await t.sign.renameStamp(t.sign.customStamps[1]!.id, 'Company logo');
    await t.sign.reorderStamps([
      t.sign.customStamps[2]!.id,
      t.sign.customStamps[0]!.id,
      t.sign.customStamps[1]!.id,
    ]);
    expect(t.sign.customStamps.map((c) => c.name)).toEqual(['Heading', 'Received', 'Company logo']);
    for (const def of t.sign.customStamps) {
      t.sign.placeStamp(tools, def);
      await tools.pointerMove(1, { x: 300, y: 100 + 150 * t.sign.customStamps.indexOf(def) });
      await tools.pointerDown(1, { x: 300, y: 100 + 150 * t.sign.customStamps.indexOf(def) });
    }
    await t.sign.removeStamp(t.sign.customStamps[0]!.id);
    expect(t.sign.customStamps.length).toBe(2);
    const p0 = (await s.doc.listAnnotations(0)) as StampAnnotation[];
    expect(p0.map((a) => a.name)).toEqual(['Initials', 'Date', 'PAID']);
    expect(p0[1]!.contents).toBe('11/10/2026');
    expect((await s.doc.listAnnotations(1)).length).toBe(3);
    await t.app.save();
    await expect(t.files.get('/a.pdf')!).toBeValidPdf();
  });

  it('can keep stored signatures encrypted at rest @FR-STM-10', async () => {
    const t = await createTestApp();
    await t.app.setSetting('encryptSignatures', true);
    t.sign.openCreate('signature');
    await t.sign.save(await t.sign.draftFromText('Marta', 'Kalam', t.sign.inkColors.black!), 'Secret');
    const row = (
      await t.db.select<{ encrypted: number; png: string }>('SELECT encrypted, png FROM signatures')
    )[0]!;
    expect(row.encrypted).toBe(1);
    expect(Buffer.from(row.png, 'base64').subarray(0, 4).toString('latin1')).not.toBe('\x89PNG');
    expect(t.sign.signatures[0]!.png.subarray(1, 4).toString()).toBe('80,78,71');
    await t.app.setSetting('encryptSignatures', false);
    expect((await t.db.select<{ encrypted: number }>('SELECT encrypted FROM signatures'))[0]!.encrypted).toBe(
      0,
    );
  });
});

describe('E3 Edit text', () => {
  it('fixes "Invoce" in a subset font: font reused when the glyph exists, substituted with a notice otherwise; undo restores the page @FR-EDT-01 @FR-EDT-02 @FR-EDT-04', async () => {
    const t = await createTestApp();
    const s = await t.open('subset-font', '/inv.pdf');
    const tools = t.tools(s);
    await t.registry.run('tool.edit-text', t.ctx());
    expect([s.mode, tools.tool]).toEqual(['edit', 'edit-text']);
    const layer = await s.text.layer(0);
    const run = layer.runs.find((r) => r.text === 'Invoce')!;
    const at = { x: run.rect.x + run.rect.width - 2, y: run.rect.y + run.rect.height / 2 };
    await tools.pointerMove(0, at);
    expect(tools.hoverLine!.line).toMatchObject({ text: 'Invoce', fontName: 'LiberationSerif' });
    await tools.pointerDown(0, at);
    expect(tools.inlineEdit).toMatchObject({
      text: 'Invoce',
      badge: { text: 'LiberationSerif 24pt', substituted: false },
    });
    expect(tools.inlineEdit!.caret).toBeGreaterThanOrEqual(5);
    tools.rememberEditSize(24);
    const res = await tools.commitInlineEdit('Invoice');
    expect(res!.font.kind).toBe('reused');
    expect(tools.notice).toBeNull();
    await settle();
    expect(await pdftotext(await s.doc.save())).toMatch(/Invoice\n/);
    // A glyph the subset does not have: nearest bundled font, amber notice explains.
    await tools.pointerDown(0, at);
    await tools.commitInlineEdit('Invoice №7');
    expect(tools.notice).toMatchObject({
      kind: 'substituted',
      message: { key: 'edit.fontSubstituted', params: { from: 'LiberationSerif', to: 'Liberation Serif' } },
    });
    await settle();
    const bytes = await s.doc.save();
    expect(await pdftotext(bytes)).toContain('Invoice №7');
    expect((await pdffonts(bytes)).length).toBe(2);
    // Characters no bundled font has: that is the notice (it wins over the font substitution) and it sits on the line.
    await tools.pointerDown(0, at);
    await tools.commitInlineEdit('Invoice 日本語');
    expect(tools.notice).toMatchObject({ kind: 'missingGlyphs', message: { key: 'edit.missingGlyphs' } });
    expect(tools.notice!.rect).toMatchObject({ width: expect.any(Number) });
    await s.undo();
    await settle();
    // Unchanged text and Esc are no-ops.
    const steps = s.historyState.done.length;
    await tools.pointerDown(0, at);
    await tools.commitInlineEdit(tools.inlineEdit!.text);
    await tools.pointerDown(0, at);
    tools.cancel();
    expect(s.historyState.done.length).toBe(steps);
    await s.undo();
    await s.undo();
    await settle();
    expect((await s.text.layer(0)).text).toContain('Invoce');
    expect((await pdffonts(await s.doc.save())).length).toBe(1);
    expect(s.dirty).toBe(false);
  });

  it('says so on scanned pages and offers Cover & type instead @FR-EDT-08 @FR-FRM-06', async () => {
    const t = await createTestApp();
    const s = await t.open('scan', '/scan.pdf');
    const tools = t.tools(s);
    await t.registry.run('tool.edit-text', t.ctx());
    await tools.pointerMove(0, { x: 100, y: 100 });
    expect(tools.hint).toEqual({ key: 'edit.scannedPage' });
    await tools.pointerDown(0, { x: 100, y: 100 });
    expect(tools.inlineEdit).toBeNull();
    await t.registry.run('tool.cover-type', t.ctx());
    expect([s.mode, tools.hint]).toEqual(['fill', null]);
    await tools.pointerDown(0, { x: 100, y: 500 });
    expect(tools.typing).toMatchObject({ kind: 'cover', page: 0 });
    await tools.commitTyping('Typed over the scan');
    expect((await s.doc.listAnnotations(0))[0]).toMatchObject({
      type: 'freetext',
      contents: 'Typed over the scan',
    });
    expect(tools.tool).toBe('cover-type');
  });

  it('adds text, covers content with whiteout and edits images in Edit mode @FR-EDT-05 @FR-EDT-06 @FR-EDT-07', async () => {
    const t = await createTestApp();
    const s = await t.open('images', '/img.pdf');
    const tools = t.tools(s);
    s.setMode('edit');
    tools.setTool('add-text');
    tools.setOptions({ addAsPageContent: true, fontSize: 14 });
    await tools.pointerDown(0, { x: 100, y: 300 });
    await tools.commitTyping('Page content text');
    await settle();
    expect((await s.text.layer(0)).text).toContain('Page content text');
    expect(await s.doc.listAnnotations(0)).toEqual([]);
    tools.setTool('add-text');
    tools.setOptions({ addAsPageContent: false });
    await tools.pointerDown(0, { x: 100, y: 250 });
    await tools.commitTyping('Annotation text');
    expect((await s.doc.listAnnotations(0)).map((a) => a.type)).toEqual(['freetext']);
    // Whiteout over the heading (cover only).
    tools.setTool('whiteout');
    const heading = (await s.text.layer(0)).runs.find((r) => r.text === 'Two images below')!;
    await tools.pointerDown(0, { x: heading.rect.x - 2, y: heading.rect.y - 2 });
    await tools.pointerMove(0, {
      x: heading.rect.x + heading.rect.width + 2,
      y: heading.rect.y + heading.rect.height + 2,
    });
    await tools.pointerUp(0, {
      x: heading.rect.x + heading.rect.width + 2,
      y: heading.rect.y + heading.rect.height + 2,
    });
    await settle();
    expect(
      inkRatio(await s.doc.render(0, { scale: 1, annotations: false }), {
        x: heading.rect.x,
        y: 792 - heading.rect.y - heading.rect.height,
        width: heading.rect.width,
        height: heading.rect.height,
      }),
    ).toBe(0);
    expect((await s.text.layer(0)).text).toContain('Two images below');
    // Select an image, drag it, delete it.
    tools.setTool('select');
    await tools.pointerDown(0, { x: 100, y: 600 });
    expect(s.selection).toMatchObject({ kind: 'object', page: 0 });
    await tools.pointerMove(0, { x: 140, y: 580 });
    expect(tools.drag!.objectPreview).toMatchObject({ x: 112, y: 540 });
    await tools.pointerUp(0, { x: 140, y: 580 });
    await settle();
    expect((await t.services.objects.imagesOn(s.doc, 0))[0]!.bounds).toMatchObject({ x: 112, y: 540 });
    // A handle of the selected image resizes it and keeps it selected.
    const before = (await t.services.objects.imagesOn(s.doc, 0))[0]!.bounds;
    await tools.pointerDown(0, { x: before.x + before.width, y: before.y }, {}, 'br');
    expect(s.selection).toMatchObject({ kind: 'object', page: 0 });
    expect(tools.drag).toMatchObject({ kind: 'resize' });
    await tools.pointerMove(0, { x: before.x + before.width + 30, y: before.y - 30 });
    await tools.pointerUp(0, { x: before.x + before.width + 30, y: before.y - 30 });
    await settle();
    const resized = (await t.services.objects.imagesOn(s.doc, 0))[0]!.bounds;
    expect(resized.width).toBeGreaterThan(before.width + 20);
    expect(s.selection).toMatchObject({ kind: 'object', page: 0 });
    await tools.pointerDown(0, { x: 150, y: 580 });
    await tools.pointerUp(0, { x: 150, y: 580 });
    expect(await tools.deleteSelection()).toBe(1);
    await settle();
    expect((await t.services.objects.imagesOn(s.doc, 0)).length).toBe(1);
    // Insert a new image through the placement ghost.
    const prepared = await t.services.objects.prepare(samplePng(80, 40));
    tools.beginPlacement({
      kind: 'image',
      size: { width: 160, height: 80 },
      make: (rect) => ({ image: { image: prepared.image, rect } }),
    });
    await tools.pointerMove(0, { x: 300, y: 200 });
    await tools.pointerDown(0, { x: 300, y: 200 });
    await settle();
    expect((await t.services.objects.imagesOn(s.doc, 0)).map((o) => o.imageSize)).toContainEqual({
      width: 80,
      height: 40,
    });
    await expect(await s.doc.save()).toBeValidPdf();
  });
});

describe('E4 Fill a form', () => {
  it('tabs through fields, types values and saves a file other viewers read @FR-FRM-01 @FR-FRM-02', async () => {
    const t = await createTestApp();
    const s = await t.open('acroform', '/form.pdf');
    s.setMode('fill');
    const form = t.form(s);
    await form.load();
    expect(form.banner).toEqual({ kind: 'form', count: 7 });
    expect(form.highlight).toBe(true);
    await form.toggleHighlight();
    expect(t.app.settings.highlightFields).toBe(false);
    // The first Tab focuses the first field; Shift+Tab goes back.
    const first = form.tab(1)!;
    expect(first.field.name).toBe('person.name');
    expect(first.field.label).toBe('Your first and last name');
    await form.set(first.field, 'Marta Esempio');
    await form.set(form.tab(1)!.field, 'ab12');
    await form.set(form.tab(1)!.field, 'Line one\nLine two');
    await form.set(form.tab(1)!.field, true);
    const radio = form.tab(1)!;
    expect([radio.field.name, radio.widget]).toEqual(['color', 0]);
    await form.set(radio.field, radio.field.widgets[1]!.exportValue!);
    form.tab(1);
    await form.set(form.tab(1)!.field, 'France');
    await form.set(form.tab(1)!.field, ['EN', 'IT']);
    expect(form.tab(1)!.field.name).toBe('person.name');
    expect(form.tab(-1)!.field.name).toBe('langs');
    await settle();
    expect(Object.fromEntries(form.fields.map((f) => [f.name, f.value]))).toMatchObject({
      'person.name': 'Marta Esempio',
      code: 'ab12',
      agree: 'Yes',
      color: 'blue',
      country: 'France',
    });
    await t.app.save();
    const bytes = t.files.get('/form.pdf')!;
    await expect(bytes).toBeValidPdf();
    const rows = Object.fromEntries((await pdfcpuFormFields(bytes)).map((r) => [r.name, r.value]));
    expect(rows).toMatchObject({
      'person.name': 'Marta Esempio',
      code: 'ab12',
      agree: 'Yes',
      color: 'blue',
      country: 'France',
      langs: 'EN,IT',
    });
    // Appearance streams exist: an independent renderer shows the typed name.
    expect(
      inkRatio(await pdftoppm(bytes, 1), { x: 74, y: 792 - 700, width: 90, height: 18 }),
    ).toBeGreaterThan(0.03);
    // Each field edit is its own undo step.
    expect(s.historyState.done.length).toBe(7);
  });

  it('offers profile values while typing, exports and imports data, resets and flattens with confirmation @FR-FRM-05 @FR-FRM-10 @FR-AIF-01', async () => {
    const t = await createTestApp();
    const profile = await t.services.profiles.create('Personal', ['identity', 'contacts']);
    await t.services.profiles.setField(profile.id, {
      key: 'full_name',
      label: 'Full name',
      type: 'text',
      value: PERSON.fullName,
      aliases: ['name'],
    });
    await t.services.profiles.setField(profile.id, {
      key: 'email',
      label: 'Email',
      type: 'email',
      value: PERSON.email,
    });
    await t.services.profiles.setField(profile.id, {
      key: 'tax_id',
      label: 'Tax code',
      type: 'text',
      value: PERSON.taxId,
      sensitive: true,
    });
    const s = await t.open('acroform', '/form.pdf');
    const form = t.form(s);
    await form.load();
    const name = form.fields.find((f) => f.name === 'person.name')!;
    const sugg = await form.suggestions(name, '');
    expect(sugg[0]).toBe(PERSON.fullName);
    expect(sugg).not.toContain(PERSON.taxId);
    expect(await form.suggestions(name, 'mar')).toEqual([PERSON.fullName, PERSON.email]);
    expect(
      await form.suggestions(
        form.fields.find((f) => f.name === 'agree')!,
        '',
      ),
    ).toEqual([]);
    await form.set(name, PERSON.fullName);
    await settle();
    t.files.nextSave = ['/form.json'];
    expect(await form.exportJson()).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(t.files.get('/form.json')!))).toMatchObject({
      version: 1,
      fields: { 'person.name': PERSON.fullName, agree: false },
    });
    t.prompts.confirmAnswers = [false, true];
    await form.reset();
    expect(form.fields.find((f) => f.name === 'person.name')!.value).toBe(PERSON.fullName);
    await form.reset();
    await settle();
    expect(form.fields.find((f) => f.name === 'person.name')!.value).toBe('');
    t.files.nextOpen = [['/form.json']];
    expect(await form.importJson()).toEqual(['ref']);
    await settle();
    expect(form.fields.find((f) => f.name === 'person.name')!.value).toBe(PERSON.fullName);
    expect(t.toastKeys()).toContain('form.importSkipped');
    await form.clear(form.fields.find((f) => f.name === 'person.name')!);
    await s.undo();
    await form.flatten();
    await settle();
    expect(form.fields).toEqual([]);
    expect(form.banner.kind).toBe('none');
    expect(t.prompts.asked.filter((a) => a.startsWith('confirm:'))).toEqual([
      'confirm:form.confirmReset',
      'confirm:form.confirmReset',
      'confirm:form.confirmFlatten',
    ]);
  });

  it('explains that dynamic XFA forms cannot be edited @FR-FRM-09', async () => {
    const t = await createTestApp();
    const s = await t.open('xfa', '/xfa.pdf');
    const form = t.form(s);
    await form.load();
    expect(form.banner.kind).toBe('xfa');
  });
});

describe('Annotations can be placed from the keyboard @NFR-11', () => {
  it('Enter places the armed tool at the centre of the page and the arrow keys move it', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    const tools = t.tools(s);
    const size = s.pageInfos[0]!.size;
    tools.setTool('rect');
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    const [shape] = await s.doc.listAnnotations(0);
    expect(shape).toMatchObject({ type: 'square' });
    expect(shape!.rect.x + shape!.rect.width / 2).toBeCloseTo(size.width / 2, 3);
    expect(tools.tool).toBe('select');
    expect(s.selection).toMatchObject({ kind: 'annotations', page: 0 });
    await tools.nudgeSelection('ArrowRight', true);
    expect((await s.doc.listAnnotations(0))[0]!.rect.x).toBeCloseTo(shape!.rect.x + 10, 3);

    tools.setTool('arrow');
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    tools.setTool('note');
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    tools.setTool('textbox');
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    expect(tools.typing).toMatchObject({ kind: 'textbox', page: 0 });
    await tools.commitTyping('From the keyboard');
    expect((await s.doc.listAnnotations(0)).map((a) => a.type)).toEqual(['square', 'line', 'text', 'freetext']);

    // Select has nothing to place; a markup tool needs a text selection.
    tools.setTool('select');
    expect(await tools.placeWithKeyboard(0)).toBe(false);
    tools.setTool('highlight');
    expect(await tools.placeWithKeyboard(0)).toBe(false);

    // A signature or stamp waiting for a position is dropped at the centre.
    const prepared = await t.services.objects.prepare(samplePng(80, 40));
    tools.beginPlacement({
      kind: 'image',
      size: { width: 160, height: 80 },
      make: (rect) => ({ image: { image: prepared.image, rect } }),
    });
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    const images = await t.services.objects.imagesOn(s.doc, 0);
    expect(images.length).toBe(1);
    expect(images[0]!.bounds.x + images[0]!.bounds.width / 2).toBeCloseTo(size.width / 2, 3);
  });
});

describe('Keyboard placement covers every placement tool @NFR-11', () => {
  it('a text selection is highlighted; shapes, whiteout, marks and typed text land on the page', async () => {
    const t = await createTestApp();
    const s = await t.open('invoice', '/a.pdf');
    const tools = t.tools(s);
    const size = s.pageInfos[0]!.size;
    const centre = { x: size.width / 2, y: size.height / 2 };
    const near = (r: { x: number; y: number; width: number; height: number }): boolean =>
      Math.abs(r.x + r.width / 2 - centre.x) < 80 && Math.abs(r.y + r.height / 2 - centre.y) < 80;

    // A word is selected (as the mouse would do), then Enter with the underline tool marks it up once.
    const layer = await s.text.layer(0);
    const run = layer.runs.find((r) => r.text.startsWith('Payment within'))!;
    const c = layer.chars[run.charStart + 2]!.rect;
    await tools.doubleClick(0, { x: c.x + c.width / 2, y: run.rect.y + 4 });
    expect(await tools.selectedText()).toBe('Payment');
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    expect((await s.doc.listAnnotations(0)).map((a) => a.type)).toEqual(['highlight']);
    // A markup tool armed with no selection has nothing to place.
    tools.setTool('underline');
    expect(await tools.placeWithKeyboard(0)).toBe(false);

    // Shapes and whiteout are drawn at the centre at the default size.
    tools.setTool('ellipse');
    await tools.placeWithKeyboard(0);
    const shape = (await s.doc.listAnnotations(0)).find((a) => a.type === 'circle')!;
    expect(near(shape.rect)).toBe(true);
    expect(shape.rect).toMatchObject({ width: 120, height: 80 });
    tools.setTool('whiteout');
    await tools.placeWithKeyboard(0);
    await settle();
    expect(s.dirty).toBe(true);

    // Marks go to the centre; add-text and cover-type open the editor there and commit like a click.
    tools.setTool('check');
    await tools.placeWithKeyboard(0);
    tools.setTool('cross');
    await tools.placeWithKeyboard(0);
    const stamps = (await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp');
    expect(stamps.length).toBe(2);
    expect(stamps.every((a) => near(a.rect))).toBe(true);
    tools.setTool('add-text');
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    expect(tools.typing).toMatchObject({ kind: 'textbox', page: 0 });
    // While a text box is open, Enter does not place a second thing.
    expect(await tools.placeWithKeyboard(0)).toBe(false);
    await tools.commitTyping('typed');
    tools.setTool('cover-type');
    expect(await tools.placeWithKeyboard(0)).toBe(true);
    expect(tools.typing).toMatchObject({ kind: 'cover', page: 0 });
    tools.cancel();
    expect(tools.typing).toBeNull();
  });
});

describe('Typed text boxes keep everything that was typed @FR-ANN-03', () => {
  it('sizes the box to the wrapped text and keeps it on the page', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    const tools = t.tools(s);
    tools.setTool('textbox');
    tools.setOptions({ fontSize: 12 });
    await tools.pointerDown(0, { x: 100, y: 400 });
    const first = 'This sentence is long enough to wrap onto several lines inside the text box that was drawn. '.repeat(3).trim();
    await tools.commitTyping(`${first}\nSecond paragraph that must survive.`);
    tools.setTool('textbox');
    await tools.pointerDown(0, { x: 590, y: 30 });
    await tools.commitTyping('Edge text that is rather long and wraps');
    const [a, b] = (await s.doc.listAnnotations(0)).filter((x) => x.type === 'freetext');
    const page = s.pageInfos[0]!.cropBox;
    expect(a!.rect.height).toBeGreaterThan(12 * 1.3 * 5);
    for (const r of [a!.rect, b!.rect]) {
      expect(r.x).toBeGreaterThanOrEqual(page.x);
      expect(r.x + r.width).toBeLessThanOrEqual(page.x + page.width + 0.01);
      expect(r.y).toBeGreaterThanOrEqual(page.y);
    }
    expect(a!.contents).toContain('Second paragraph that must survive.');
  });
});

describe('E5 Smart Fill', () => {
  const profileFor = async (t: Awaited<ReturnType<typeof createTestApp>>) => {
    const p = await t.services.profiles.create('Personal', [
      'identity',
      'contacts',
      'address',
      'bank',
      'company',
    ]);
    const values: Record<string, string> = {
      first_name: PERSON.firstName,
      last_name: PERSON.lastName,
      full_name: PERSON.fullName,
      birth_date: PERSON.birthDate,
      email: PERSON.email,
      tax_id: PERSON.taxId,
      phone: PERSON.phone,
      street: PERSON.street,
      city: PERSON.city,
      postal_code: PERSON.postalCode,
      country: PERSON.country,
      iban: PERSON.iban,
      company: PERSON.company,
    };
    for (const f of p.fields)
      if (values[f.key]) await t.services.profiles.setField(p.id, { ...f, value: values[f.key]! });
    return p;
  };

  it('with a key: pre-flight shows what is sent, review, apply as one undo; without a key the same action works offline @FR-AIF-03 @FR-AIF-04 @FR-AIF-05 @FR-AIF-06 @FR-AIF-07 @FR-FRM-10', async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    await profileFor(t);
    const { pdf, areas } = await flatFormDoc();
    t.files.put('/apply.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/apply.pdf')))!;
    const sf = t.smartFill(s);
    // Hidden until configured and switched on.
    expect(await sf.aiAvailable()).toBe(false);
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true });
    expect(await sf.aiAvailable()).toBe(true);
    ai.enqueue((req) => ({
      fields: req.candidates.map((c) => ({
        ref: c.ref,
        label: c.label ?? '',
        fieldType: c.fieldType,
        profileKey:
          (
            {
              'First name': 'first_name',
              'Last name': 'last_name',
              'Date of birth': 'birth_date',
              Email: 'email',
              'Tax code': 'tax_id',
            } as Record<string, string>
          )[c.label ?? ''] ?? null,
        transform: 'none',
        choiceValue: null,
        confidence: 0.95,
      })),
      newAreas: [],
    }));
    await sf.start();
    expect(sf.stage).toBe('preflight');
    expect(sf.preflight).toMatchObject({
      mode: 'mapping_only',
      pages: [1],
      candidateCount: 6,
      valueKeys: [],
      includesImage: false,
    });
    expect(sf.preflight!.estimatedTokens).toBeGreaterThan(0);
    expect(ai.requests.length).toBe(0);
    await sf.confirmPreflight(true);
    expect(sf.stage).toBe('review');
    expect(t.app.settings.ai.preflightAcknowledged).toEqual(['mapping_only']);
    expect(JSON.stringify(ai.requests[0])).not.toContain(PERSON.email);
    const correct = sf.suggestions.filter(
      (x) =>
        (
          ({
            'First name': 'first_name',
            'Last name': 'last_name',
            'Date of birth': 'birth_date',
            Email: 'email',
            'Tax code': 'tax_id',
            'Send me the newsletter': null,
          }) as Record<string, string | null>
        )[x.label] === x.profileKey,
    ).length;
    expect(correct / sf.suggestions.length).toBeGreaterThanOrEqual(0.85);
    sf.locate(sf.suggestions[0]!.ref);
    expect(sf.located).toBe(sf.suggestions[0]!.ref);
    sf.setValue(sf.suggestions[3]!.ref, 'other@example.com');
    sf.toggle(sf.suggestions[1]!.ref, false);
    expect(sf.acceptedCount).toBe(4);
    expect(await sf.apply()).toBe(4);
    await settle();
    const boxes = await s.doc.listFormFields();
    expect(boxes.map((b) => b.value)).toEqual(['Marta', '1988-04-23', 'other@example.com', PERSON.taxId]);
    for (const [k, b] of boxes.entries()) {
      const truth = areas[[0, 2, 3, 4][k]!]!.rect;
      expect(Math.abs(b.widgets[0]!.rect.x - truth.x)).toBeLessThanOrEqual(3);
      expect(Math.abs(b.widgets[0]!.rect.y - truth.y)).toBeLessThanOrEqual(3);
    }
    expect(t.app.toasts.at(-1)).toMatchObject({
      message: { key: 'toast.smartFillApplied', params: { count: 4 } },
    });
    expect(sf.stage).toBe('idle');
    await s.undo();
    await settle();
    expect(await s.doc.listFormFields()).toEqual([]);

    // Key removed: the same button runs the local heuristic, with no request at all.
    ai.configured = false;
    const offline = t.smartFill(s);
    await t.services.mappings.forget(
      (
        await t.services.smartFill.analyze(s.doc, [0], (await t.services.profiles.getDefault())!, {
          useAi: false,
          mode: 'mapping_only',
        })
      ).fingerprint,
      (await t.services.profiles.getDefault())!.id,
    );
    const before = ai.requests.length;
    await offline.start();
    expect(offline.stage).toBe('review');
    expect(offline.result!.source).toBe('heuristic');
    expect(ai.requests.length).toBe(before);
    expect(t.http.requests.length).toBe(0);
    expect(offline.suggestions.find((x) => x.label === 'First name')).toMatchObject({
      value: 'Marta',
      accepted: true,
    });
    expect(await offline.apply(true)).toBeGreaterThanOrEqual(4);
  });

  it('remembers the mapping per form, lets the user add missing data to the profile, and fills AcroForms too @FR-AIF-06 @FR-AIF-08 @FR-AIF-10', async () => {
    const t = await createTestApp();
    await profileFor(t);
    const s = await t.open('acroform', '/form.pdf');
    const sf = t.smartFill(s);
    await sf.start();
    expect([sf.stage, sf.result!.source]).toEqual(['review', 'heuristic']);
    const notes = sf.suggestions.find((x) => x.ref === 'notes')!;
    expect(notes.profileKey).toBeNull();
    await sf.addToProfile('notes', 'notes', 'Notes', 'Please call before delivery');
    expect(sf.suggestions.find((x) => x.ref === 'notes')).toMatchObject({
      profileKey: 'notes',
      value: 'Please call before delivery',
      accepted: true,
    });
    sf.setScope('all');
    sf.setProfile(sf.profiles[0]!.id);
    expect(await sf.apply()).toBe(3);
    await settle();
    expect(Object.fromEntries((await s.fields()).map((f) => [f.name, f.value]))).toMatchObject({
      'person.name': PERSON.fullName,
      country: 'Italy',
      notes: 'Please call before delivery',
    });
    expect(s.historyState.done.length).toBe(1);
    // Same form again (another copy of the file): filled from the remembered mapping.
    const again = await t.open('acroform', '/form-copy.pdf');
    const sf2 = t.smartFill(again);
    await sf2.start();
    expect(sf2.result!.source).toBe('remembered');
    expect(
      sf2.suggestions
        .filter((x) => x.accepted)
        .map((x) => x.ref)
        .sort(),
    ).toEqual(['country', 'notes', 'person.name']);
    await sf2.analyse(true);
    expect(sf2.result!.source).toBe('heuristic');
    sf2.cancel();
    expect([sf2.stage, sf2.suggestions.length]).toEqual(['idle', 0]);
    // No profile yet → a hint instead of an empty panel.
    const empty = await createTestApp();
    const doc = await empty.open('acroform', '/f.pdf');
    await empty.smartFill(doc).start();
    expect(empty.toastKeys()).toEqual(['smartfill.needProfile']);
  });
});

describe('E6 Images to PDF', () => {
  it('reports progress and a cancelled run creates nothing and shows no error @FR-OPT-03', async () => {
    const t = await createTestApp();
    for (let i = 1; i <= 3; i++) t.files.put(`/pics/${i}.jpg`, sampleJpeg(200, 100, i));
    const w = t.images();
    await w.addFiles([1, 2, 3].map((i) => t.files.ref(`/pics/${i}.jpg`)));
    const before = t.app.sessions.length;
    const run = w.create();
    w.cancel();
    expect(await run).toBeNull();
    expect(t.app.sessions.length).toBe(before);
    expect(t.toastKeys()).toEqual([]);
    expect(w.busy).toBe(false);
    const s = await w.create();
    expect(s?.pageCount).toBe(3);
    expect(w.progress).toBe(1);
  });

  it('turns three photos into one PDF with one image per page, reordered, with a selectable margin @FR-OPT-03 @FR-MRG-03', async () => {
    const t = await createTestApp();
    t.files.put('/pics/1.jpg', sampleJpeg(400, 300, 1));
    t.files.put('/pics/2.jpg', sampleJpeg(300, 400, 2));
    t.files.put('/pics/3.jpg', sampleJpeg(500, 500, 3));
    t.files.put('/pics/notes.txt', new Uint8Array([1]));
    // Right extension, wrong content: refused when added (naming the file), not when creating the PDF.
    t.files.put('/pics/fake.png', new Uint8Array([1, 2, 3]));
    const w = t.images();
    await w.addFiles(
      ['/pics/1.jpg', '/pics/2.jpg', '/pics/3.jpg', '/pics/notes.txt', '/pics/fake.png'].map((p) => t.files.ref(p)),
    );
    expect(w.items.map((i) => i.name)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    expect(t.toastKeys()).toEqual(['images.notAnImage', 'images.notAnImage']);
    expect(t.app.toasts.map((x) => x.message.params?.name)).toEqual(['notes.txt', 'fake.png']);
    w.move(w.items[2]!.id, 0);
    w.setOptions({ margin: 18, pageSize: 'A4', fit: 'fit' });
    const s = await w.create();
    expect(s).toMatchObject({ name: '3.pdf', pageCount: 3, dirty: true });
    for (let p = 0; p < 3; p++) {
      const objs = await s!.doc.listObjects(p);
      expect(objs.map((o) => o.type)).toEqual(['image']);
      expect(objs[0]!.bounds.x).toBeGreaterThanOrEqual(17.9);
    }
    expect((await s!.doc.listObjects(0))[0]!.imageSize).toEqual({ width: 500, height: 500 });
    expect((await s!.doc.getPageInfo(1)).size.width).toBeGreaterThan(
      (await s!.doc.getPageInfo(1)).size.height,
    );
    t.files.nextSave = ['/pics/album.pdf'];
    await t.app.save(s!);
    const bytes = t.files.get('/pics/album.pdf')!;
    await expect(bytes).toBeValidPdf();
    expect((await pdfinfo(bytes)).pages).toBe(3);
    // Opens (renders with content) in three independent engines.
    expect(inkRatio(await s!.doc.render(0, { scale: 0.2 }))).toBeGreaterThan(0.3);
    expect(inkRatio(await pdftoppm(bytes, 1, 20))).toBeGreaterThan(0.3);
    expect(inkRatio(await mutoolDraw(bytes, 1, 20))).toBeGreaterThan(0.3);
    w.remove(w.items[0]!.id);
    expect(w.items.length).toBe(2);
    expect(await t.images().create()).toBeNull();
  });
});

describe('E7 Split every N pages', () => {
  it('splits 25 pages by 10 into three files named {name}_{n}.pdf; conflicts auto-number @FR-MRG-04 @FR-MRG-05 @FR-MRG-06', async () => {
    const t = await createTestApp();
    const s = await t.open('text-25', '/docs/big.pdf');
    t.files.put('/docs/big_2.pdf', new Uint8Array([9]));
    const w = t.split(s);
    await w.init();
    expect(w.folder!.path).toBe('/docs');
    expect(w.plan.map((f) => [f.name, f.from, f.to, f.pages.length])).toEqual([
      ['big_1.pdf', 1, 10, 10],
      ['big_2 (2).pdf', 11, 20, 10],
      ['big_3.pdf', 21, 25, 5],
    ]);
    expect(w.canRun).toBe(true);
    const res = await w.run();
    expect(res).toEqual({ written: ['big_1.pdf', 'big_2 (2).pdf', 'big_3.pdf'], skipped: [] });
    expect(t.files.get('/docs/big_2.pdf')!.length).toBe(1);
    await expect(t.files.get('/docs/big_1.pdf')!).toHavePageCount(10);
    await expect(t.files.get('/docs/big_2 (2).pdf')!).toHavePageCount(10);
    await expect(t.files.get('/docs/big_3.pdf')!).toHavePageCount(5);
    await expect(t.files.get('/docs/big_3.pdf')!).toBeValidPdf();
    expect(await pdftotext(t.files.get('/docs/big_2 (2).pdf')!, { page: 1 })).toContain('Page 11 of 25');
    expect(s.pageCount).toBe(25);
    expect(s.dirty).toBe(false);
    expect(t.toastKeys().at(-1)).toBe('toast.splitDone');
  });

  it('previews ranges, single pages and scissor cuts live; explains invalid input; honours ask/overwrite @FR-MRG-04 @FR-MRG-05 @FR-MRG-06', async () => {
    const t = await createTestApp();
    const s = await t.open('text-25', '/docs/big.pdf');
    const w = t.split(s);
    await w.init();
    await w.setMode('cuts');
    expect(w.cuts).toEqual([9, 19]);
    await w.toggleCut(4);
    expect(w.plan.map((f) => `${f.from}-${f.to}`)).toEqual(['1-5', '6-10', '11-20', '21-25']);
    await w.toggleCut(9);
    expect(w.plan.length).toBe(3);
    await w.setMode('single');
    expect(w.plan.length).toBe(25);
    expect(w.plan[0]!.name).toBe('big_01.pdf');
    await w.setMode('ranges');
    expect(w.problem).toEqual({ key: 'split.problem.noRanges', params: { reason: 'noRanges' } });
    expect(w.canRun).toBe(false);
    await w.setRange(0, '1-3');
    await w.addRange();
    await w.setRange(1, '40');
    expect([w.rangeValid(0), w.rangeValid(1)]).toEqual([true, false]);
    expect(w.problem!.key).toBe('split.problem.range');
    await w.setRange(1, '20-');
    await w.setTemplate('{name} pages {from}-{to}');
    expect(w.plan.map((f) => f.name)).toEqual(['big pages 1-3.pdf', 'big pages 20-25.pdf']);
    await w.setTemplate('{name}_{oops}');
    expect(w.problem).toMatchObject({ key: 'split.problem.badToken' });
    await w.setTemplate('part_{n}');
    await w.removeRange(1);
    await w.setMode('everyN');
    await w.setEveryN(0);
    expect(w.problem!.key).toBe('split.problem.badN');
    await w.setEveryN(12);
    t.files.put('/out/part_1.pdf', new Uint8Array([1]));
    t.files.nextFolder = ['/out'];
    await w.pickFolder();
    await w.setPolicy('ask');
    expect(w.plan.map((f) => [f.name, f.conflict])).toEqual([
      ['part_1.pdf', true],
      ['part_2.pdf', false],
      ['part_3.pdf', false],
    ]);
    t.prompts.confirmAnswers = [false];
    expect(await w.run()).toEqual({ written: ['part_2.pdf', 'part_3.pdf'], skipped: ['part_1.pdf'] });
    expect(t.files.get('/out/part_1.pdf')!.length).toBe(1);
    await w.setPolicy('overwrite');
    expect((await w.run())!.written.length).toBe(3);
    await expect(t.files.get('/out/part_1.pdf')!).toHavePageCount(12);
  });
});

describe('other everyday flows', () => {
  it('organises pages: select, drag, rotate, duplicate, insert, extract, replace, delete with an Undo toast @FR-ORG-01 @FR-ORG-02 @FR-ORG-03 @FR-ORG-04 @FR-ORG-05 @FR-ORG-06 @FR-ORG-07 @FR-ORG-08 @FR-ORG-09 @FR-ORG-10', async () => {
    const t = await createTestApp();
    const s = await t.open('text-25', '/docs/big.pdf');
    await t.put('/docs/extra.pdf', 'mixed-sizes');
    s.setMode('organise');
    const org = t.organise(s);
    org.setThumbSize(500);
    expect(org.thumbSize).toBe(320);
    org.click(2);
    org.click(5, { shift: true });
    expect(org.selected).toEqual([2, 3, 4, 5]);
    org.click(9, { mod: true });
    org.click(3, { mod: true });
    expect(org.selected).toEqual([2, 4, 5, 9]);
    org.selectBand([0, 1]);
    org.selectOdd();
    expect(org.selected.length).toBe(13);
    org.selectEven();
    expect(org.selected[0]).toBe(1);
    org.selectNone();
    expect(s.selection.kind).toBe('none');
    // Drag pages 2 and 3 to the front; the insertion marker follows the pointer.
    org.click(1);
    org.click(2, { shift: true });
    org.dragOver(0);
    expect(org.dropBefore).toBe(0);
    await org.drop(1, 0);
    await settle();
    expect((await markers(s)).slice(0, 4)).toEqual([2, 3, 1, 4]);
    expect([org.selected, org.dropBefore]).toEqual([[0, 1], null]);
    await org.nudge(1);
    await settle();
    expect((await markers(s)).slice(0, 4)).toEqual([1, 2, 3, 4]);
    // Dropping a page where it already is changes nothing: no history step, no unsaved-changes mark.
    const steps = s.historyState;
    org.click(3);
    await org.drop(3, 3);
    await org.drop(3, 4);
    await settle();
    expect(s.historyState).toEqual(steps);
    expect((await markers(s)).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    org.click(1);
    org.click(2, { shift: true });
    // Delete removes the selection and leaves nothing selected: a second Delete is not a second removal.
    org.click(0);
    const countBefore = s.pageCount;
    await org.delete();
    await settle();
    expect(s.pageCount).toBe(countBefore - 1);
    expect(org.selected).toEqual([]);
    await org.delete();
    await settle();
    expect(s.pageCount).toBe(countBefore - 1);
    await s.undo();
    await settle();
    org.click(1);
    org.click(2, { shift: true });
    // Hover mini action bar on a page that is not selected acts on that page only.
    await org.rotate(90, 7);
    expect((await s.doc.getPageInfo(7)).rotation).toBe(90);
    expect(org.selected).toEqual([1, 2]);
    await org.duplicate();
    await settle();
    expect((await markers(s)).slice(0, 6)).toEqual([1, 2, 2, 3, 3, 4]);
    expect(org.selected).toEqual([2, 4]);
    await org.insertBlank('after', { kind: 'preset', name: 'A5' });
    await settle();
    expect(org.selected).toEqual([5]);
    expect((await s.doc.getPageInfo(5)).size.width).toBeCloseTo(419.53, 1);
    t.files.nextOpen = [['/docs/extra.pdf']];
    await org.insertFromFile(0, '2,4');
    await settle();
    expect([(await s.doc.getPageInfo(0)).size, (await s.doc.getPageInfo(1)).size]).toEqual([
      { width: 792, height: 612 },
      { width: 300, height: 200 },
    ]);
    expect(s.pageCount).toBe(30);
    // Extract to a new tab and remove from the source.
    org.click(0);
    org.click(1, { shift: true });
    const extracted = await org.extract(true);
    await settle();
    expect(extracted).toMatchObject({ name: 'big (pages 1-2).pdf', pageCount: 2, dirty: true });
    expect(s.pageCount).toBe(28);
    t.app.activate(s.id);
    // Drag pages in from another open tab.
    await org.insertFromSession(extracted!, [1], 28);
    await settle();
    expect((await s.doc.getPageInfo(28)).size).toEqual({ width: 300, height: 200 });
    org.click(28);
    t.files.nextOpen = [['/docs/extra.pdf']];
    await org.replaceFromFile('1');
    await settle();
    expect((await s.doc.getPageInfo(28)).size.width).toBeCloseTo(595.28, 1);
    org.selectAll();
    await org.delete();
    expect(t.toastKeys().at(-1)).toBe('error.invalidArgument.lastPage');
    org.click(0);
    await org.delete();
    await settle();
    expect(t.app.toasts.at(-1)).toMatchObject({
      message: { key: 'toast.pagesDeleted', params: { count: 1 } },
    });
    await t.app.toasts.at(-1)!.action!.run();
    await settle();
    expect(s.pageCount).toBe(29);
    await expect(await s.doc.save()).toBeValidPdf();
  });

  it('annotates: sticky highlight on selection, shapes with Shift, notes, text boxes, copy and paste across tabs @FR-ANN-01 @FR-ANN-02 @FR-ANN-03 @FR-ANN-04 @FR-ANN-06 @FR-VIEW-03', async () => {
    const t = await createTestApp();
    const s = await t.open('invoice', '/a.pdf');
    const tools = t.tools(s);
    const layer = await s.text.layer(0);
    const run = layer.runs.find((r) => r.text.startsWith('Payment within'))!;
    const y = run.rect.y + 4;
    // Centre of the character at `offset` inside the run.
    const cx = (offset: number): number => {
      const r = layer.chars[run.charStart + offset]!.rect;
      return r.x + r.width / 2;
    };
    const within = run.text.indexOf('within');
    const days = run.text.indexOf('days');
    // Select text with the Select tool → mini-toolbar actions.
    await tools.pointerDown(0, { x: cx(0), y });
    await tools.pointerMove(0, { x: cx(within + 5), y });
    await tools.pointerUp(0, { x: cx(within + 5), y });
    expect(await tools.selectedText()).toBe('Payment within');
    await tools.copySelection();
    expect(t.clipboard.text).toBe('Payment within');
    expect(await tools.applyMarkup('highlight', { r: 124, g: 222, b: 132 })).toBe(true);
    await tools.doubleClick(0, { x: cx(days + 1), y });
    expect(await tools.selectedText()).toBe('days');
    await tools.commentSelection('Is this right?');
    await tools.tripleClick(0, { x: cx(days + 1), y });
    expect(await tools.selectedText()).toBe('Payment within 30 days. Thank you for your business.');
    // Highlight tool: selecting applies at once and the tool stays active when sticky.
    await t.registry.run('tool.highlight', t.ctx());
    tools.setTool('underline', { sticky: true });
    const total = layer.runs.find((r) => r.text.startsWith('Total due'))!;
    await tools.pointerDown(0, { x: total.rect.x + 1, y: total.rect.y + 4 });
    await tools.pointerMove(0, { x: total.rect.x + total.rect.width - 1, y: total.rect.y + 4 });
    await tools.pointerUp(0, { x: total.rect.x + total.rect.width - 1, y: total.rect.y + 4 });
    expect(tools.tool).toBe('underline');
    // Shapes; Shift constrains to a square and to 45° steps.
    tools.setTool('rect');
    await tools.pointerDown(0, { x: 100, y: 300 });
    await tools.pointerMove(0, { x: 180, y: 260 }, { shift: true });
    expect(tools.draft!.current).toEqual({ x: 180, y: 220 });
    await tools.pointerUp(0, { x: 180, y: 260 }, { shift: true });
    expect(tools.tool).toBe('select');
    tools.setTool('arrow');
    await tools.pointerDown(0, { x: 300, y: 300 });
    await tools.pointerMove(0, { x: 400, y: 306 }, { shift: true });
    await tools.pointerUp(0, { x: 400, y: 306 }, { shift: true });
    tools.setTool('polyline');
    await tools.pointerDown(0, { x: 100, y: 150 });
    await tools.pointerDown(0, { x: 150, y: 190 });
    await tools.pointerDown(0, { x: 200, y: 150 });
    await tools.doubleClick(0, { x: 200, y: 150 });
    tools.setTool('rect');
    await tools.pointerDown(0, { x: 10, y: 10 });
    await tools.pointerUp(0, { x: 11, y: 11 });
    tools.setTool('textbox');
    tools.setOptions({ fontFamily: 'serif', fontSize: 14 });
    await tools.pointerDown(0, { x: 300, y: 200 });
    await tools.commitTyping('A typed note\nsecond line');
    tools.setTool('textbox');
    await tools.pointerDown(0, { x: 300, y: 100 });
    await tools.commitTyping('   ');
    const list = await s.doc.listAnnotations(0);
    expect(list.map((a) => a.type)).toEqual([
      'highlight',
      'text',
      'underline',
      'square',
      'line',
      'polyline',
      'freetext',
    ]);
    expect(list[0]!.color).toMatchObject({ r: 124, g: 222, b: 132 });
    expect(list[3]!.rect).toMatchObject({ width: 80, height: 80 });
    expect(list[4]).toMatchObject({ endEnding: 'openArrow' });
    expect((list[4] as { end: { y: number } }).end.y).toBeCloseTo(300, 5);
    expect((list[5] as { vertices: unknown[] }).vertices.length).toBe(3);
    expect(list[6]).toMatchObject({ contents: 'A typed note\nsecond line', fontFamily: 'serif' });
    // Re-open the text box by double-click and change its text; restyle from the inspector.
    await tools.doubleClick(0, { x: list[6]!.rect.x + 5, y: list[6]!.rect.y + 5 });
    expect(tools.typing!.editing!.id).toBe(list[6]!.id);
    await tools.commitTyping('Changed');
    await tools.pointerDown(0, { x: 110, y: 290 });
    await tools.pointerUp(0, { x: 110, y: 290 });
    await tools.restyleSelection({ color: { r: 0, g: 0, b: 255 } });
    await tools.reorderSelection('front');
    const after = await s.doc.listAnnotations(0);
    expect(after.at(-1)).toMatchObject({ type: 'square', color: { r: 0, g: 0, b: 255 } });
    expect(after.find((a) => a.type === 'freetext')!.contents).toBe('Changed');
    // Resize by a handle, then copy and paste into another tab.
    await tools.pointerDown(0, { x: 180, y: 300 }, {}, 'tr');
    await tools.pointerMove(0, { x: 220, y: 320 });
    await tools.pointerUp(0, { x: 220, y: 320 });
    expect((await s.doc.listAnnotations(0)).at(-1)!.rect).toMatchObject({
      x: 100,
      y: 220,
      width: 120,
      height: 100,
    });
    await tools.copySelection();
    const other = await t.open('text', '/b.pdf');
    expect(await t.tools(other).paste(t.clipboard.text, 1)).toBe(1);
    expect((await other.doc.listAnnotations(1))[0]).toMatchObject({
      type: 'square',
      rect: { x: 112, y: 208 },
    });
    // Pasting the same copy again cascades instead of stacking exactly on the previous one.
    expect(await t.tools(other).paste(t.clipboard.text, 1)).toBe(1);
    expect((await other.doc.listAnnotations(1))[1]).toMatchObject({ rect: { x: 124, y: 196 } });
    expect(await t.tools(other).paste('plain text', 0)).toBe(0);
    expect(await t.tools(other).deleteSelection()).toBe(1);
    await t.app.save(s);
    await expect(t.files.get('/a.pdf')!).toBeValidPdf();
  });

  it('exports pages as images to a folder or a zip, copies a snapshot, and edits metadata @FR-OPT-02 @FR-OPT-04 @FR-SEC-04', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/docs/a.pdf');
    const ex = t.exportImages(s);
    expect(ex.formats).toEqual(['png', 'jpeg']);
    ex.set({ range: '1,3', dpi: 72 });
    t.files.nextFolder = ['/out'];
    expect(await ex.run()).toBe(2);
    expect(t.files.list('/out')).toEqual(['/out/a_p1.png', '/out/a_p3.png']);
    ex.set({ asZip: true, format: 'jpeg', range: '' });
    t.files.nextSave = ['/out/a.zip'];
    expect(await ex.run()).toBe(3);
    expect([...t.files.get('/out/a.zip')!.subarray(0, 2)]).toEqual([0x50, 0x4b]);
    ex.set({ range: '9' });
    expect([ex.rangeValid, await ex.run()]).toEqual([false, 0]);
    const tools = t.tools(s);
    tools.setTool('snapshot');
    await tools.pointerDown(0, { x: 60, y: 690 });
    await tools.pointerMove(0, { x: 260, y: 740 });
    await tools.pointerUp(0, { x: 260, y: 740 });
    expect(t.clipboard.image![1]).toBe(0x50);
    expect(t.toastKeys()).toContain('toast.snapshotCopied');
    await s.run(t.services.documents.setMetadata(s.meta, { title: 'New title' }));
    await settle();
    expect(s.meta.title).toBe('New title');
    await s.run(t.services.documents.removeAllMetadata());
    await settle();
    expect([s.meta.title, s.meta.author]).toEqual(['', '']);
    expect(s.historyState.done.map((d) => d.label.key)).toEqual(['cmd.editMetadata', 'cmd.removeMetadata']);
  });
});
