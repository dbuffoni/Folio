// Interoperability (NFR-08, SPEC §15): what Folio writes must be valid for qpdf and pdfcpu and must
// look the same in other renderers (poppler, MuPDF) as it does in ours.
import { describe, expect, it } from 'vitest';
import { FIXTURES, fixture, hasTool, mutoolDraw, pdftoppm, pdftotext, sharedEngine } from '@folio/testkit';

const RENDERABLE = ['text', 'invoice', 'subset-font', 'acroform', 'annotated', 'images', 'rotated-pages', 'mixed-sizes', 'unicode', 'links', 'bookmarks'].filter((n) => n in FIXTURES);

describe('files written by the engine are read correctly by other tools', () => {
  it.each(RENDERABLE)('%s: a full rewrite is valid and renders alike in poppler and MuPDF @NFR-08', async (name) => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture(name));
    const saved = await doc.save();
    await expect(saved).toBeValidPdf();
    const ours = await doc.render(0, { scale: 1 });
    expect(await pdftoppm(saved, 1, 72)).toRenderLike(ours, { tolerance: 0.06 });
    if (await hasTool('mutool')) expect(await mutoolDraw(saved, 1, 72)).toRenderLike(ours, { tolerance: 0.06 });
    doc.dispose();
  });

  it('page operations survive a round trip through other tools @NFR-08 @FR-ORG-04', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture('text-25'));
    await doc.rotatePages([0], 90);
    await doc.deletePages([1, 2]);
    await doc.movePages([22], 0);
    const saved = await doc.save();
    await expect(saved).toBeValidPdf();
    await expect(saved).toHavePageCount(23);
    expect(await pdftotext(saved, { page: 1 })).toContain('Page 25 of 25');
    doc.dispose();
  });

  it('annotations and form values are visible to poppler @NFR-08 @FR-FRM-02', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture('acroform'));
    const fields = await doc.listFormFields();
    const name = fields.find((f) => f.type === 'text' && !f.readOnly)!;
    await doc.setFieldValue(name.id, 'Interop Value');
    await doc.upsertAnnotation(0, { type: 'freetext', rect: { x: 72, y: 60, width: 200, height: 24 }, contents: 'Visible everywhere', fontSize: 12, fontFamily: 'sans', textColor: { r: 0, g: 0, b: 0 }, align: 'left' });
    const saved = await doc.save();
    await expect(saved).toBeValidPdf();
    const before = await pdftoppm(await fixture('acroform'), 1, 72);
    const after = await pdftoppm(saved, 1, 72);
    // Both the field value and the text box add ink that poppler draws from the appearance streams.
    expect(after).not.toRenderLike(before, { tolerance: 0.0005 });
    doc.dispose();
  });
});
