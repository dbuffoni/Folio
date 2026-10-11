import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createNodeEngine } from '../src/node.ts';
import { scope, getUtf16 } from '../src/mem.ts';
const out = process.argv[2]!;
const s = await PDFDocument.create();
const font = await s.embedFont(StandardFonts.Helvetica);
const pg = s.addPage([612, 792]);
const form = s.getForm();
const t = form.createTextField('person.name'); t.addToPage(pg, { x: 72, y: 700, width: 200, height: 22, font });
const ml = form.createTextField('notes'); ml.enableMultiline(); ml.addToPage(pg, { x: 72, y: 620, width: 200, height: 60, font });
const cb = form.createCheckBox('agree'); cb.addToPage(pg, { x: 72, y: 580, width: 16, height: 16 });
const rg = form.createRadioGroup('color'); rg.addOptionToPage('red', pg, { x: 72, y: 540, width: 16, height: 16 }); rg.addOptionToPage('blue', pg, { x: 100, y: 540, width: 16, height: 16 });
const dd = form.createDropdown('country'); dd.addOptions(['Italy', 'France', 'Spain']); dd.addToPage(pg, { x: 72, y: 500, width: 150, height: 22, font });
const ol = form.createOptionList('langs'); ol.addOptions(['EN', 'IT', 'DE']); ol.enableMultiselect(); ol.addToPage(pg, { x: 72, y: 420, width: 100, height: 60, font });
const comb = form.createTextField('code'); comb.setMaxLength(6); comb.enableCombing(); comb.addToPage(pg, { x: 300, y: 700, width: 150, height: 22, font });
const bytes = await s.save();
await writeFile(`${out}/form-src.pdf`, bytes);
const engine = await createNodeEngine();
const doc: any = await engine.open(bytes);
const m = doc.m; const page = doc.page(0); const fh = doc.form();
const n = m.FPDFPage_GetAnnotCount(page);
const info: any[] = [];
for (let k = 0; k < n; k++) scope(m, (a: any) => {
  const an = m.FPDFPage_GetAnnot(page, k);
  const name = getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldName(fh, an, b, l));
  const type = m.FPDFAnnot_GetFormFieldType(fh, an);
  const r: any = { k, name, type, flags: m.FPDFAnnot_GetFormFieldFlags(fh, an), val: getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldValue(fh, an, b, l)), exp: getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldExportValue(fh, an, b, l)), opts: m.FPDFAnnot_GetOptionCount(fh, an), ctl: [m.FPDFAnnot_GetFormControlCount(fh, an), m.FPDFAnnot_GetFormControlIndex(fh, an)], checked: m.FPDFAnnot_IsChecked(fh, an) };
  const p = a.alloc(4); r.maxlen = m.FPDFAnnot_GetNumberValue(an, 'MaxLen', p) ? a.f32(p) : null;
  if (type === 6) { r.set = m.EPDFAnnot_SetFormFieldValue(fh, an, a.utf16(name === 'code' ? 'AB12' : name === 'notes' ? 'Line one\nLine two' : 'Marta Rossi')); r.ap = m.EPDFAnnot_GenerateFormFieldAP(an); }
  if (type === 4) { r.set = m.EPDFAnnot_SetFormFieldValue(fh, an, a.utf16('France')); r.ap = m.EPDFAnnot_GenerateFormFieldAP(an); }
  if (type === 5) { r.set = m.EPDFAnnot_SetFormFieldValue(fh, an, a.utf16('IT')); r.ap = m.EPDFAnnot_GenerateFormFieldAP(an); }
  if (type === 2) { r.set = m.EPDFAnnot_SetFormFieldValue(fh, an, a.utf16('Yes')); r.ap = m.EPDFAnnot_GenerateFormFieldAP(an); r.checkedAfter = m.FPDFAnnot_IsChecked(fh, an); }
  if (type === 3 && r.exp === 'blue') { r.set = m.EPDFAnnot_SetFormFieldValue(fh, an, a.utf16('blue')); r.ap = m.EPDFAnnot_GenerateFormFieldAP(an); r.checkedAfter = m.FPDFAnnot_IsChecked(fh, an); }
  r.valAfter = getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldValue(fh, an, b, l));
  info.push(r); m.FPDFPage_CloseAnnot(an);
});
for (const r of info) console.log(JSON.stringify(r));
await writeFile(`${out}/form-out.pdf`, await doc.save());
await engine.dispose();
