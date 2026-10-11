// Spike S2: which annotation subtypes get a usable appearance stream from the engine build?
import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createNodeEngine } from '../src/node.ts';
import { scope } from '../src/mem.ts';

const out = process.argv[2] ?? '/tmp';
const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
const pg = src.addPage([612, 792]);
pg.drawText('The quick brown fox jumps over the lazy dog', { x: 72, y: 700, size: 14, font });
const engine = await createNodeEngine();
const doc: any = await engine.open(await src.save());
const m = doc.m;
const page = doc.page(0);
const rectOf = (a: any, l: number, b: number, r: number, t: number) => a.floats([l, t, r, b]);
const report: Record<string, unknown> = {};
const mk = (name: string, subtype: number, fn: (a: any, an: number) => void) =>
  scope(m, (a) => {
    const an = m.FPDFPage_CreateAnnot(page, subtype);
    const steps: Record<string, unknown> = {};
    try { fn(a, an); } catch (e) { steps.error = String(e); }
    steps.gen = m.EPDFAnnot_GenerateAppearance(an);
    steps.hasAP = m.EPDFAnnot_HasAppearanceStream(an, 0);
    report[name] = steps;
    m.FPDFPage_CloseAnnot(an);
  });
mk('highlight', 9, (a, an) => {
  m.FPDFAnnot_SetRect(an, rectOf(a, 72, 696, 200, 714));
  m.EPDFAnnot_SetColor(an, 0, 255, 213, 74);
  m.EPDFAnnot_SetOpacity(an, 128);
  m.FPDFAnnot_AppendAttachmentPoints(an, a.floats([72, 714, 200, 714, 72, 696, 200, 696]));
});
mk('underline', 10, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 210, 696, 300, 714)); m.EPDFAnnot_SetColor(an, 0, 211, 47, 47); m.FPDFAnnot_AppendAttachmentPoints(an, a.floats([210, 714, 300, 714, 210, 696, 300, 696])); });
mk('squiggly', 11, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 310, 696, 360, 714)); m.EPDFAnnot_SetColor(an, 0, 0, 150, 0); m.FPDFAnnot_AppendAttachmentPoints(an, a.floats([310, 714, 360, 714, 310, 696, 360, 696])); });
mk('strikeout', 12, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 370, 696, 420, 714)); m.EPDFAnnot_SetColor(an, 0, 211, 47, 47); m.FPDFAnnot_AppendAttachmentPoints(an, a.floats([370, 714, 420, 714, 370, 696, 420, 696])); });
mk('note', 1, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 72, 640, 92, 660)); m.EPDFAnnot_SetColor(an, 0, 255, 213, 74); m.FPDFAnnot_SetStringValue(an, 'Contents', a.utf16('A note')); });
mk('freetext', 3, (a, an) => {
  m.FPDFAnnot_SetRect(an, rectOf(a, 120, 620, 320, 660));
  m.FPDFAnnot_SetStringValue(an, 'Contents', a.utf16('Free text box'));
  report.da = m.EPDFAnnot_SetDefaultAppearance(an, 4, 12, 29, 78, 216);
  m.EPDFAnnot_SetTextAlignment(an, 1);
});
mk('square', 5, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 72, 540, 172, 600)); m.EPDFAnnot_SetColor(an, 0, 211, 47, 47); m.EPDFAnnot_SetColor(an, 1, 255, 240, 200); m.EPDFAnnot_SetBorderStyle(an, 0, 2); });
mk('circle', 6, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 190, 540, 290, 600)); m.EPDFAnnot_SetColor(an, 0, 0, 0, 200); m.EPDFAnnot_SetBorderStyle(an, 1, 3); m.EPDFAnnot_SetBorderDashPattern(an, a.floats([4, 3]), 2); });
mk('line', 4, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 300, 540, 420, 600)); m.EPDFAnnot_SetColor(an, 0, 0, 120, 0); m.EPDFAnnot_SetBorderStyle(an, 0, 2); m.EPDFAnnot_SetLine(an, a.floats([305, 545]), a.floats([415, 595])); m.EPDFAnnot_SetLineEndings(an, 0, 4); });
mk('polyline', 8, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 430, 540, 540, 600)); m.EPDFAnnot_SetColor(an, 0, 120, 0, 120); m.EPDFAnnot_SetBorderStyle(an, 0, 2); m.EPDFAnnot_SetVertices(an, a.floats([435, 545, 480, 595, 535, 550]), 3); });
mk('ink', 15, (a, an) => { m.FPDFAnnot_SetRect(an, rectOf(a, 72, 460, 200, 520)); m.EPDFAnnot_SetColor(an, 0, 0, 0, 0); m.EPDFAnnot_SetBorderStyle(an, 0, 2); m.FPDFAnnot_AddInkStroke(an, a.floats([75, 465, 100, 515, 150, 470, 195, 510]), 4); });
mk('stamp-image', 13, (a, an) => {
  m.FPDFAnnot_SetRect(an, rectOf(a, 220, 460, 320, 510));
  const img = m.FPDFPageObj_NewImageObj(doc.doc);
  const bmp = m.FPDFBitmap_CreateEx(40, 20, 4, 0, 0);
  const buf = m.FPDFBitmap_GetBuffer(bmp);
  for (let i = 0; i < 40 * 20; i++) { m.pdfium.HEAPU8.set([200, 60, 20, i % 40 < 20 ? 255 : 90], buf + i * 4); }
  m.FPDFImageObj_SetBitmap(0, 0, img, bmp); m.FPDFBitmap_Destroy(bmp);
  m.FPDFPageObj_SetMatrix(img, a.floats([100, 0, 0, 50, 220, 460]));
  report.stampAppendImg = m.FPDFAnnot_AppendObject(an, img);
});
mk('stamp-vector', 13, (a, an) => {
  m.FPDFAnnot_SetRect(an, rectOf(a, 340, 460, 480, 510));
  const path = m.FPDFPageObj_CreateNewPath(345, 465);
  m.FPDFPath_BezierTo(path, 380, 520, 420, 440, 475, 505);
  m.FPDFPageObj_SetStrokeColor(path, 29, 78, 216, 255); m.FPDFPageObj_SetStrokeWidth(path, 2); m.FPDFPath_SetDrawMode(path, 0, true);
  report.stampAppendPath = m.FPDFAnnot_AppendObject(an, path);
  const f = doc.shared.fonts.load(doc.doc, 'sans', 'bold');
  const t = m.FPDFPageObj_CreateTextObj(doc.doc, f, 14);
  m.FPDFText_SetText(t, a.utf16('PAID')); m.FPDFPageObj_SetFillColor(t, 198, 40, 40, 255);
  m.FPDFPageObj_SetMatrix(t, a.floats([1, 0, 0, 1, 400, 470]));
  report.stampAppendText = m.FPDFAnnot_AppendObject(an, t);
});
console.log(JSON.stringify(report, null, 1));
await writeFile(`${out}/s2.pdf`, await doc.save());
await engine.dispose();
