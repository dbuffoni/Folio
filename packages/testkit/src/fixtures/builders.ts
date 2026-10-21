// Deterministic PDF fixture builders (SPEC §16.4). Built with pdf-lib, which is independent from the
// PDFium engine under test. No builder uses real personal data: see people.ts.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { PERSON } from './people.ts';

const FIXED_DATE = new Date(Date.UTC(2026, 0, 15, 10, 30, 0));
const FONT_DIR = fileURLToPath(new URL('../../../../assets/fonts/liberation/', import.meta.url));

/** Runs `fn` with a seeded Math.random so pdf-lib's random subset tags are reproducible. */
async function deterministic<T>(seed: number, fn: () => Promise<T>): Promise<T> {
  const original = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

async function newDoc(title: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('Folio testkit');
  doc.setSubject('Fixture');
  doc.setKeywords(['fixture', 'folio']);
  doc.setProducer('folio-testkit');
  doc.setCreator('folio-testkit');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  return doc;
}
const finish = (doc: PDFDocument): Promise<Uint8Array> => doc.save({ useObjectStreams: false });

// ---- text ------------------------------------------------------------------------------------

export interface TextDocOptions {
  pages?: number;
  title?: string;
  size?: [number, number];
  /** Extra lines per page. */
  lines?: string[];
}
/** Pages with a heading "Page N of M", a marker line and optional body lines, standard Helvetica. */
export async function textDoc(opts: TextDocOptions = {}): Promise<Uint8Array> {
  const { pages = 3, title = 'Text document', size = [612, 792], lines = [] } = opts;
  const doc = await newDoc(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage(size);
    const top = size[1] - 72;
    page.drawText(`Page ${p} of ${pages}`, { x: 72, y: top, size: 20, font: bold });
    page.drawText(`${title} marker-${p}`, { x: 72, y: top - 30, size: 12, font });
    lines.forEach((line, k) => page.drawText(line, { x: 72, y: top - 60 - k * 18, size: 12, font }));
  }
  return finish(doc);
}

/**
 * One page per entry of `bodySizes`: a 20 pt heading and eight lines of body text at that size, so the
 * predominant text size of page N is `bodySizes[N - 1]`.
 */
export async function bodySizesDoc(bodySizes: number[] = [9, 12, 18]): Promise<Uint8Array> {
  const doc = await newDoc('Body sizes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  bodySizes.forEach((size, k) => {
    const page = doc.addPage([612, 792]);
    page.drawText(`Body ${size} pt`, { x: 72, y: 720, size: 20, font: bold });
    for (let i = 0; i < 8; i++) page.drawText(`Line ${i + 1} of the body text on page ${k + 1}, set at ${size} pt.`, { x: 72, y: 680 - i * size * 1.5, size, font });
  });
  return finish(doc);
}

/** Invoice-like page: misspelt heading, table, coloured text, a second font. */
export async function invoiceDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Invoice 2026-014');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([612, 792]);
  page.drawText('Invoce', { x: 72, y: 708, size: 28, font: bold, color: rgb(0.08, 0.13, 0.24) });
  page.drawText('No. 2026-014', { x: 72, y: 686, size: 11, font });
  page.drawText(`Bill to: ${PERSON.fullName}`, { x: 72, y: 650, size: 11, font });
  page.drawText(PERSON.addressLine, { x: 72, y: 634, size: 11, font });
  const rows = [
    ['Description', 'Qty', 'Amount'],
    ['Design services', '12', '1,200.00'],
    ['Hosting (annual)', '1', '240.00'],
    ['Support hours', '3', '180.00'],
  ];
  rows.forEach((row, r) => {
    const y = 590 - r * 22;
    const f = r === 0 ? bold : font;
    page.drawText(row[0]!, { x: 72, y, size: 11, font: f });
    page.drawText(row[1]!, { x: 380, y, size: 11, font: f });
    page.drawText(row[2]!, { x: 470, y, size: 11, font: f });
    page.drawLine({ start: { x: 72, y: y - 6 }, end: { x: 540, y: y - 6 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.85) });
  });
  page.drawText('Total due: 1,620.00 EUR', { x: 380, y: 480, size: 13, font: bold, color: rgb(0.78, 0.16, 0.16) });
  page.drawText('Payment within 30 days. Thank you for your business.', { x: 72, y: 430, size: 11, font: serif });
  return finish(doc);
}

/** Text drawn with an embedded *subset* TrueType font (CID, Identity-H). The subset lacks most glyphs. */
export async function subsetFontDoc(): Promise<Uint8Array> {
  return deterministic(7, async () => {
    const doc = await newDoc('Subset font');
    doc.registerFontkit(fontkit);
    const data = await readFile(`${FONT_DIR}LiberationSerif-Regular.ttf`);
    const font = await doc.embedFont(data, { subset: true, customName: 'FOLIOX+LiberationSerif' });
    const page = doc.addPage([612, 792]);
    page.drawText('Invoce', { x: 72, y: 700, size: 24, font });
    page.drawText('Payment is due within thirty days', { x: 72, y: 660, size: 12, font });
    page.drawText('Qty', { x: 72, y: 630, size: 12, font });
    return finish(doc);
  });
}

/** Two columns of short paragraphs. */
export async function multiColumnDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Two columns');
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([612, 792]);
  for (let col = 0; col < 2; col++) {
    for (let line = 0; line < 20; line++) {
      page.drawText(`Column ${col + 1} line ${line + 1} lorem ipsum`, { x: 72 + col * 250, y: 700 - line * 16, size: 10, font });
    }
  }
  return finish(doc);
}

/** Four pages with /Rotate 0, 90, 180, 270 and a label naming the rotation. */
export async function rotatedPagesDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Rotated pages');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rot of [0, 90, 180, 270]) {
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(rot));
    page.drawText(`Rotation ${rot}`, { x: 72, y: 700, size: 18, font });
    page.drawRectangle({ x: 72, y: 600, width: 60, height: 30, color: rgb(0.15, 0.39, 0.92) });
  }
  return finish(doc);
}

/** A4 portrait, Letter landscape, A5, and a small custom size. */
export async function mixedSizesDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Mixed sizes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes: [number, number][] = [
    [595.28, 841.89],
    [792, 612],
    [419.53, 595.28],
    [300, 200],
  ];
  sizes.forEach((s, k) => doc.addPage(s).drawText(`Size ${k + 1}`, { x: 30, y: s[1] - 50, size: 14, font }));
  return finish(doc);
}

/** Text drawn at an angle (not editable in Release 1). */
export async function rotatedTextDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Rotated text');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Straight text', { x: 72, y: 700, size: 14, font });
  page.drawText('Tilted text', { x: 200, y: 500, size: 14, font, rotate: degrees(30) });
  return finish(doc);
}

/** Hebrew (RTL) and Greek/Cyrillic text with an embedded Unicode font. */
export async function unicodeDoc(): Promise<Uint8Array> {
  return deterministic(11, async () => {
    const doc = await newDoc('Unicode text');
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await readFile(`${FONT_DIR}LiberationSans-Regular.ttf`), { subset: true, customName: 'FOLIOY+LiberationSans' });
    const page = doc.addPage([612, 792]);
    page.drawText('Ελληνικά κείμενο', { x: 72, y: 700, size: 14, font });
    page.drawText('Русский текст', { x: 72, y: 670, size: 14, font });
    page.drawText('שלום עולם', { x: 72, y: 640, size: 14, font });
    page.drawText('Żółć gęślą jaźń — “quotes” €', { x: 72, y: 610, size: 14, font });
    return finish(doc);
  });
}

// ---- structure: outline, links ---------------------------------------------------------------

function addOutline(doc: PDFDocument, items: { title: string; page: number; children?: { title: string; page: number }[] }[]): void {
  const ctx = doc.context;
  const pages = doc.getPages();
  const outlineRef = ctx.nextRef();
  const make = (list: { title: string; page: number; children?: { title: string; page: number }[] }[], parent: PDFRef): PDFRef[] => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((item, k) => {
      const dict = ctx.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parent,
        Dest: [pages[item.page]!.ref, PDFName.of('XYZ'), 72, 720, 0],
      }) as PDFDict;
      if (k > 0) dict.set(PDFName.of('Prev'), refs[k - 1]!);
      if (k < refs.length - 1) dict.set(PDFName.of('Next'), refs[k + 1]!);
      if (item.children?.length) {
        const kids = make(item.children, refs[k]!);
        dict.set(PDFName.of('First'), kids[0]!);
        dict.set(PDFName.of('Last'), kids[kids.length - 1]!);
        dict.set(PDFName.of('Count'), PDFNumber.of(kids.length));
      }
      ctx.assign(refs[k]!, dict);
    });
    return refs;
  };
  const top = make(items, outlineRef);
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: top[0]!, Last: top[top.length - 1]!, Count: top.length }));
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
}

function addAnnot(page: PDFPage, dict: PDFDict): PDFRef {
  const ref = page.doc.context.register(dict);
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = page.doc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
  return ref;
}

/** Five pages with a two-level outline: Chapter 1 (p1) → Section 1.1 (p2), Chapter 2 (p4), Appendix (p5). */
export async function bookmarksDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 5, title: 'Bookmarks' }));
  addOutline(doc, [
    { title: 'Chapter 1', page: 0, children: [{ title: 'Section 1.1', page: 1 }] },
    { title: 'Chapter 2', page: 3 },
    { title: 'Appendix – Ünïcode', page: 4 },
  ]);
  return finish(doc);
}

/**
 * Outline whose entries use more than a page destination: a bold red entry with a named action, a web
 * link and a JavaScript action (FR-EDT-27: editing other entries must leave these untouched).
 */
export async function bookmarksActionsDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 4, title: 'Bookmark actions' }));
  const ctx = doc.context;
  const pages = doc.getPages();
  const outlineRef = ctx.nextRef();
  const refs = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
  const entries: Array<Record<string, unknown>> = [
    { Title: PDFHexString.fromText('Intro'), Dest: [pages[0]!.ref, PDFName.of('XYZ'), 72, 720, 0] },
    { Title: PDFHexString.fromText('Next page'), F: 2, C: [1, 0, 0], A: { S: 'Named', N: 'NextPage' } },
    { Title: PDFHexString.fromText('Website'), A: { S: 'URI', URI: PDFString.of('https://example.com/spec') } },
    { Title: PDFHexString.fromText('Script'), A: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } },
  ];
  entries.forEach((e, k) => {
    const dict = ctx.obj({ ...e, Parent: outlineRef }) as PDFDict;
    if (k > 0) dict.set(PDFName.of('Prev'), refs[k - 1]!);
    if (k < refs.length - 1) dict.set(PDFName.of('Next'), refs[k + 1]!);
    ctx.assign(refs[k]!, dict);
  });
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: refs[0]!, Last: refs[3]!, Count: 4 }));
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  return finish(doc);
}

/** Page 1 has an internal link to page 3, an https link, a JavaScript action and a launch action. */
export async function linksDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 3, title: 'Links' }));
  const ctx = doc.context;
  const pages = doc.getPages();
  const link = (rect: number[], extra: Record<string, unknown>): void => {
    addAnnot(pages[0]!, ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], ...extra }) as PDFDict);
  };
  link([72, 600, 200, 620], { Dest: [pages[2]!.ref, PDFName.of('Fit')] });
  link([72, 570, 200, 590], { A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/docs?a=1') } });
  link([72, 540, 200, 560], { A: { Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert("x")') } });
  link([72, 510, 200, 530], { A: { Type: 'Action', S: 'Launch', F: PDFString.of('calc.exe') } });
  link([72, 480, 200, 500], { A: { Type: 'Action', S: 'URI', URI: PDFString.of('javascript:alert(1)') } });
  return finish(doc);
}

// ---- forms -----------------------------------------------------------------------------------

/**
 * AcroForm with every Release 1 field type:
 * text `person.name`, multiline `notes`, comb `code` (max 6), read-only `ref`, checkbox `agree`,
 * radio `color` (red/blue), dropdown `country`, multi-select list `langs`, push button `submit`.
 */
export async function acroFormDoc(opts: { prefilled?: boolean } = {}): Promise<Uint8Array> {
  const doc = await newDoc('Registration form');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const label = (text: string, x: number, y: number): void => page.drawText(text, { x, y, size: 10, font });
  page.drawText('Registration form', { x: 72, y: 730, size: 18, font });

  label('Full name', 72, 706);
  const name = form.createTextField('person.name');
  name.addToPage(page, { x: 72, y: 680, width: 220, height: 22, font });
  name.setFontSize(11);
  label('Code', 320, 706);
  const code = form.createTextField('code');
  code.setMaxLength(6);
  code.enableCombing();
  code.addToPage(page, { x: 320, y: 680, width: 150, height: 22, font });
  code.setFontSize(11);
  label('Notes', 72, 660);
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 72, y: 590, width: 220, height: 64, font });
  notes.setFontSize(10);
  label('Reference', 320, 660);
  const ref = form.createTextField('ref');
  ref.setText('R-0042');
  ref.enableReadOnly();
  ref.addToPage(page, { x: 320, y: 632, width: 150, height: 22, font });
  ref.setFontSize(11);

  label('I agree to the terms', 94, 562);
  form.createCheckBox('agree').addToPage(page, { x: 72, y: 558, width: 16, height: 16 });
  label('Red', 94, 532);
  label('Blue', 164, 532);
  const color = form.createRadioGroup('color');
  color.addOptionToPage('red', page, { x: 72, y: 528, width: 16, height: 16 });
  color.addOptionToPage('blue', page, { x: 142, y: 528, width: 16, height: 16 });
  label('Country', 72, 506);
  const country = form.createDropdown('country');
  country.addOptions(['Italy', 'France', 'Spain']);
  country.addToPage(page, { x: 72, y: 478, width: 150, height: 22, font });
  country.setFontSize(11);
  label('Languages', 320, 506);
  const langs = form.createOptionList('langs');
  langs.addOptions(['EN', 'IT', 'DE']);
  langs.enableMultiselect();
  langs.addToPage(page, { x: 320, y: 440, width: 100, height: 60, font });
  langs.setFontSize(11);
  form.createButton('submit').addToPage('Send', page, { x: 72, y: 400, width: 80, height: 24, font });

  if (opts.prefilled) {
    name.setText(PERSON.fullName);
    form.getCheckBox('agree').check();
    color.select('red');
    country.select('Italy');
  }
  // Tooltip (/TU) on the name field.
  name.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Your first and last name'));
  return finish(doc);
}

/** Form over two pages (fields created out of reading order): Tab has to cross the page boundary. */
export async function acroFormMultiPageDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Two-page form');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  const text = (name: string, page: typeof p1, x: number, y: number): void => {
    const f = form.createTextField(name);
    f.addToPage(page, { x, y, width: 200, height: 22, font });
    f.setFontSize(11);
  };
  p1.drawText('Page one', { x: 72, y: 730, size: 18, font });
  // Created bottom-first on purpose: reading order is by position, not by creation.
  text('p1.second', p1, 72, 600);
  text('p1.first', p1, 72, 680);
  p2.drawText('Page two', { x: 72, y: 730, size: 18, font });
  text('p2.first', p2, 72, 680);
  const kind = form.createRadioGroup('kind');
  kind.addOptionToPage('a', p2, { x: 72, y: 640, width: 16, height: 16 });
  kind.addOptionToPage('b', p2, { x: 142, y: 640, width: 16, height: 16 });
  text('p2.last', p2, 72, 580);
  return finish(doc);
}

/** Second form reusing the field name `person.name` (collision when merged with acroFormDoc). */
export async function acroFormDoc2(): Promise<Uint8Array> {
  const doc = await newDoc('Second form');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField('person.name');
  name.addToPage(page, { x: 72, y: 680, width: 220, height: 22, font });
  name.setFontSize(11);
  const email = form.createTextField('email');
  email.addToPage(page, { x: 72, y: 640, width: 220, height: 22, font });
  email.setFontSize(11);
  return finish(doc);
}

/** AcroForm that also declares an /XFA packet (dynamic XFA forms are detected, not edited). */
export async function xfaDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await acroFormDoc());
  const ctx = doc.context;
  const xml = '<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.0/"><subform name="form1"/></template></xdp:xdp>';
  const stream = ctx.register(ctx.stream(xml));
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acro.set(PDFName.of('XFA'), ctx.obj([PDFString.of('xdp:xdp'), stream]));
  return finish(doc);
}

export interface FlatFormField {
  /** Expected profile key for evaluation corpora; not written into the PDF. */
  key: string;
  label: string;
  kind: 'underline' | 'box' | 'underscores' | 'dots' | 'comb' | 'checkbox';
}
/**
 * Non-fillable form: labels with ruled lines, empty rectangles, underscore runs, comb boxes and
 * check squares, all drawn as plain page content. Returns the PDF and the ground-truth areas.
 */
export async function flatFormDoc(
  fields: FlatFormField[] = [
    { key: 'first_name', label: 'First name', kind: 'underline' },
    { key: 'last_name', label: 'Last name', kind: 'underline' },
    { key: 'birth_date', label: 'Date of birth', kind: 'box' },
    { key: 'email', label: 'Email', kind: 'underscores' },
    { key: 'tax_id', label: 'Tax code', kind: 'comb' },
    { key: 'newsletter', label: 'Send me the newsletter', kind: 'checkbox' },
  ],
  title = 'Application form',
): Promise<{ pdf: Uint8Array; areas: Array<FlatFormField & { rect: { x: number; y: number; width: number; height: number } }> }> {
  const doc = await newDoc(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(title, { x: 72, y: 730, size: 18, font });
  const areas: Array<FlatFormField & { rect: { x: number; y: number; width: number; height: number } }> = [];
  const black = rgb(0, 0, 0);
  fields.forEach((f, k) => {
    const y = 680 - k * 44;
    const labelWidth = font.widthOfTextAtSize(f.label, 11);
    switch (f.kind) {
      case 'underline': {
        page.drawText(`${f.label}:`, { x: 72, y, size: 11, font });
        const x = 72 + labelWidth + 14;
        page.drawLine({ start: { x, y: y - 2 }, end: { x: 400, y: y - 2 }, thickness: 0.7, color: black });
        areas.push({ ...f, rect: { x, y: y - 2, width: 400 - x, height: 16 } });
        break;
      }
      case 'box': {
        page.drawText(f.label, { x: 72, y: y + 16, size: 9, font });
        page.drawRectangle({ x: 72, y: y - 6, width: 200, height: 20, borderColor: black, borderWidth: 0.7 });
        areas.push({ ...f, rect: { x: 72, y: y - 6, width: 200, height: 20 } });
        break;
      }
      case 'underscores': {
        page.drawText(`${f.label}: `, { x: 72, y, size: 11, font });
        const x = 72 + labelWidth + 12;
        const run = '_'.repeat(34);
        page.drawText(run, { x, y, size: 11, font });
        areas.push({ ...f, rect: { x, y: y - 2, width: font.widthOfTextAtSize(run, 11), height: 16 } });
        break;
      }
      case 'dots': {
        // "Label ………………": the leader of a Word form, typed as ellipsis characters.
        page.drawText(`${f.label} `, { x: 72, y, size: 11, font });
        const x = 72 + font.widthOfTextAtSize(`${f.label} `, 11);
        const run = '…'.repeat(20);
        page.drawText(run, { x, y, size: 11, font });
        areas.push({ ...f, rect: { x, y: y - 2, width: font.widthOfTextAtSize(run, 11), height: 16 } });
        break;
      }
      case 'comb': {
        page.drawText(f.label, { x: 72, y: y + 16, size: 9, font });
        for (let c = 0; c < 16; c++) page.drawRectangle({ x: 72 + c * 16, y: y - 6, width: 16, height: 20, borderColor: black, borderWidth: 0.7 });
        areas.push({ ...f, rect: { x: 72, y: y - 6, width: 256, height: 20 } });
        break;
      }
      case 'checkbox': {
        page.drawRectangle({ x: 72, y: y - 2, width: 12, height: 12, borderColor: black, borderWidth: 0.8 });
        page.drawText(f.label, { x: 92, y, size: 11, font });
        areas.push({ ...f, rect: { x: 72, y: y - 2, width: 12, height: 12 } });
        break;
      }
    }
  });
  return { pdf: await finish(doc), areas };
}

// ---- images ----------------------------------------------------------------------------------

/** Deterministic RGBA test pattern: colour gradient with a dark diagonal band. */
export function sampleRaster(width: number, height: number, seed = 1): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const band = Math.abs(x - y * (width / height)) < Math.max(2, width / 20);
      data[o] = band ? 20 : (x * 255) / width;
      data[o + 1] = band ? 20 : (y * 255) / height;
      data[o + 2] = band ? 20 : (seed * 53) % 256;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}
export function samplePng(width = 120, height = 80, seed = 1): Uint8Array {
  const r = sampleRaster(width, height, seed);
  const png = new PNG({ width, height });
  png.data = Buffer.from(r.data.buffer);
  return new Uint8Array(PNG.sync.write(png, { deflateLevel: 6 }));
}
export function sampleJpeg(width = 120, height = 80, seed = 1): Uint8Array {
  const r = sampleRaster(width, height, seed);
  return new Uint8Array(jpeg.encode({ width, height, data: Buffer.from(r.data.buffer) }, 85).data);
}
/** Deterministic noisy photo-like JPEG: smooth gradients plus seeded noise, so it neither compresses to nothing nor to everything. */
export function noisyJpeg(width: number, height: number, seed = 1, quality = 92, gray = false): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let state = seed * 2654435761;
  const rnd = (): number => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const base = 90 + 80 * Math.sin(x / 37 + seed) * Math.cos(y / 53);
      const n = (rnd() - 0.5) * 40;
      data[o] = Math.max(0, Math.min(255, base + n + (gray ? 0 : x / 12)));
      data[o + 1] = Math.max(0, Math.min(255, gray ? data[o]! : base + n + y / 14));
      data[o + 2] = Math.max(0, Math.min(255, gray ? data[o]! : base + n + 40));
      data[o + 3] = 255;
    }
  }
  return new Uint8Array(jpeg.encode({ width, height, data }, quality).data);
}

/**
 * Photographs at 300 dpi for the compression tests: one colour JPEG drawn on page 1 (3.0 × 4.0 in) and
 * again, smaller, on page 2 (the same stored image, highest resolution 600 dpi); a grey JPEG; a PNG
 * with transparency that must stay untouched. Text on both pages.
 */
export async function photosDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Photos');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const photo = await doc.embedJpg(noisyJpeg(900, 1200, 7));
  const grey = await doc.embedJpg(noisyJpeg(600, 450, 9, 90, true));
  const alpha = new PNG({ width: 300, height: 150 });
  for (let i = 0; i < 300 * 150; i++) alpha.data.set([30 + (i % 200), 90, 160, i % 7 === 0 ? 0 : 255], i * 4);
  const logo = await doc.embedPng(PNG.sync.write(alpha));
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Photos at 300 dpi', { x: 72, y: 740, size: 18, font });
  p1.drawText('The quick brown fox jumps over the lazy dog', { x: 72, y: 715, size: 11, font });
  p1.drawImage(photo, { x: 72, y: 380, width: 216, height: 288 });
  p1.drawImage(grey, { x: 320, y: 500, width: 144, height: 108 });
  p1.drawImage(logo, { x: 320, y: 380, width: 72, height: 36 });
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Second page uses the photo again', { x: 72, y: 740, size: 14, font });
  p2.drawImage(photo, { x: 72, y: 560, width: 108, height: 144 });
  return finish(doc);
}

/** Paragraphs of the OCR fixtures, kept next to the builder so tests can compute the word error rate. */
export const OCR_TEXT = {
  en: 'The quick brown fox jumps over the lazy dog. Invoices are due within thirty days of receipt, and late payments may be charged interest.',
  it: 'La volpe veloce salta sopra il cane pigro. Le fatture devono essere pagate entro trenta giorni dalla ricezione, perché i ritardi sono già costosi.',
};
/**
 * Text set at 16 pt, English then Italian, for the recognition tests. The page is vector text: tests
 * render it to pixels and recognise that, so the expected text is known exactly.
 */
export async function multilingualDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Multilingual');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const wrap = (text: string, width: number): string[] => {
    const lines: string[] = [];
    let cur = '';
    for (const word of text.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, 16) > width && cur) {
        lines.push(cur);
        cur = word;
      } else cur = next;
    }
    return cur ? [...lines, cur] : lines;
  };
  let y = 720;
  for (const para of [OCR_TEXT.en, OCR_TEXT.it]) {
    for (const line of wrap(para, 468)) {
      page.drawText(line, { x: 72, y, size: 16, font });
      y -= 26;
    }
    y -= 30;
  }
  return finish(doc);
}

/** What `tablesDoc` draws, row by row, so tests can compare the extracted cells exactly. */
export const TABLE_TRUTH = {
  ruled: [
    ['Item', 'Qty', 'Price'],
    ['Widget', '2', '10.50'],
    ['Gadget with a long name', '5', '3,20'],
    ['Total', '7', '13.70'],
  ],
  plain: [
    ['Name', 'City', 'Amount'],
    ['Marta Rossi', 'Firenze', '1,250.00'],
    ['Luca Bianchi', 'Milano', '980.50'],
    ['Anna Verdi', 'Roma', '12.00'],
  ],
  /** Where the ruled table sits on page 1 and the plain one on page 2 (user space). */
  ruledArea: { x: 60, y: 560, width: 420, height: 160 },
  plainArea: { x: 60, y: 560, width: 460, height: 160 },
};
/**
 * Page 1: a ruled table whose second row has a two-line cell. Page 2: the same kind of data aligned in
 * columns with no lines at all, preceded by a paragraph that is not part of the table.
 */
export async function tablesDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Tables');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Order lines', { x: 60, y: 745, size: 16, font });
  const xs = [60, 300, 380, 480];
  const ys = [720, 690, 650, 620, 590];
  for (const y of ys) p1.drawLine({ start: { x: xs[0]!, y }, end: { x: xs[3]!, y }, thickness: 0.8, color: rgb(0, 0, 0) });
  for (const x of xs) p1.drawLine({ start: { x, y: ys[0]! }, end: { x, y: ys[4]! }, thickness: 0.8, color: rgb(0, 0, 0) });
  const cell = (text: string, c: number, y: number): void => p1.drawText(text, { x: xs[c]! + 6, y, size: 11, font });
  TABLE_TRUTH.ruled[0]!.forEach((t, c) => cell(t, c, 701));
  cell('Widget', 0, 666);
  cell('2', 1, 666);
  cell('10.50', 2, 666);
  // The long name wraps over two lines inside its cell.
  cell('Gadget with', 0, 641);
  cell('a long name', 0, 629);
  cell('5', 1, 635);
  cell('3,20', 2, 635);
  cell('Total', 0, 601);
  cell('7', 1, 601);
  cell('13.70', 2, 601);
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Quarterly summary of the three largest customers, as agreed at the meeting.', { x: 60, y: 745, size: 11, font });
  const cols = [60, 240, 400];
  TABLE_TRUTH.plain.forEach((row, r) => row.forEach((text, c) => p2.drawText(text, { x: cols[c]!, y: 700 - r * 24, size: 11, font })));
  return finish(doc);
}

export interface ScannedFormArea {
  /** PDF user space of the unrotated page. */
  rect: { x: number; y: number; width: number; height: number };
  kind: 'text' | 'checkbox';
  /** What the printed label next to it says (not drawn: a scan has no text). */
  label: string;
}
/**
 * A scanned paper form: one full-page image with five ruled boxes and two check squares drawn on it,
 * no text and no fields. `rotate` sets the page's /Rotate; the image itself is not turned, so the areas
 * stay in unrotated user space and a viewer shows them rotated.
 */
export async function scannedFormDoc(opts: { rotate?: 0 | 90 | 180 | 270 } = {}): Promise<{ pdf: Uint8Array; areas: ScannedFormArea[] }> {
  const W = 612;
  const H = 792;
  const areas: ScannedFormArea[] = [
    { rect: { x: 150, y: 700, width: 300, height: 24 }, kind: 'text', label: 'First name' },
    { rect: { x: 150, y: 660, width: 300, height: 24 }, kind: 'text', label: 'Last name' },
    { rect: { x: 150, y: 620, width: 140, height: 24 }, kind: 'text', label: 'Date of birth' },
    { rect: { x: 150, y: 580, width: 300, height: 24 }, kind: 'text', label: 'Email' },
    { rect: { x: 150, y: 540, width: 300, height: 24 }, kind: 'text', label: 'Tax code' },
    { rect: { x: 150, y: 500, width: 14, height: 14 }, kind: 'checkbox', label: 'Newsletter' },
    { rect: { x: 300, y: 500, width: 14, height: 14 }, kind: 'checkbox', label: 'Privacy' },
  ];
  const png = new PNG({ width: W, height: H });
  png.data.fill(255);
  const dot = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    png.data.set([20, 20, 20, 255], (y * W + x) * 4);
  };
  for (const { rect: r } of areas) {
    const top = Math.round(H - r.y - r.height);
    const left = Math.round(r.x);
    for (let x = 0; x <= r.width; x++) for (const y of [0, Math.round(r.height)]) dot(left + x, top + y);
    for (let y = 0; y <= r.height; y++) for (const x of [0, Math.round(r.width)]) dot(left + x, top + y);
  }
  const doc = await newDoc('Scanned form');
  const page = doc.addPage([W, H]);
  page.drawImage(await doc.embedPng(PNG.sync.write(png)), { x: 0, y: 0, width: W, height: H });
  if (opts.rotate) page.setRotation(degrees(opts.rotate));
  return { pdf: await finish(doc), areas };
}

/** PNG with a transparent background and a dark handwritten-like stroke (signature import tests). */
export function signaturePng(width = 200, height = 80, background: [number, number, number, number] = [255, 255, 255, 255]): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) png.data.set(background, i * 4);
  for (let x = 10; x < width - 10; x++) {
    const y = Math.round(height / 2 + Math.sin(x / 9) * (height / 4));
    for (let dy = -1; dy <= 1; dy++) png.data.set([20, 30, 110, 255], ((y + dy) * width + x) * 4);
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** Image-only pages (simulated scan): one full-page JPEG per page, no text objects. */
export async function scanDoc(pages = 2): Promise<Uint8Array> {
  const doc = await newDoc('Scanned document');
  for (let p = 0; p < pages; p++) {
    const img = await doc.embedJpg(sampleJpeg(306, 396, p + 1));
    doc.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  return finish(doc);
}

/** One page with text plus a PNG and a JPEG image object. */
export async function imagesDoc(): Promise<Uint8Array> {
  const doc = await newDoc('Images');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Two images below', { x: 72, y: 720, size: 14, font });
  page.drawImage(await doc.embedPng(samplePng(120, 80, 3)), { x: 72, y: 560, width: 180, height: 120 });
  page.drawImage(await doc.embedJpg(sampleJpeg(100, 100, 5)), { x: 300, y: 560, width: 120, height: 120 });
  return finish(doc);
}

// ---- annotations written by "another tool" -----------------------------------------------------

/**
 * Annotations as another viewer would write them: a highlight with QuadPoints and an appearance
 * stream, a sticky note with a popup, a square without /NM, and a FileAttachment (foreign type).
 */
export async function annotatedDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 2, title: 'Annotated' }));
  const ctx = doc.context;
  const page = doc.getPages()[0]!;
  const ap = (content: string, bbox: number[]): PDFRef =>
    ctx.register(ctx.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: {} }));
  addAnnot(
    page,
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [72, 716, 200, 740],
      QuadPoints: [72, 740, 200, 740, 72, 716, 200, 716],
      C: [1, 0.84, 0.29],
      CA: 0.5,
      T: PDFHexString.fromText('Other Viewer'),
      Contents: PDFHexString.fromText('Check this heading'),
      NM: PDFString.of('other-hl-1'),
      M: PDFString.of('D:20260110090000Z'),
      F: 4,
      AP: { N: ap('1 0.84 0.29 rg 72 716 128 24 re f', [72, 716, 200, 740]) },
    }) as PDFDict,
  );
  const noteRef = addAnnot(
    page,
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [300, 700, 320, 720],
      Name: 'Comment',
      C: [1, 0.84, 0.29],
      T: PDFHexString.fromText('Other Viewer'),
      Contents: PDFHexString.fromText('A sticky note'),
      NM: PDFString.of('other-note-1'),
      F: 28,
      AP: { N: ap('1 0.84 0.29 rg 0 0 20 20 re f', [0, 0, 20, 20]) },
    }) as PDFDict,
  );
  addAnnot(page, ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [330, 620, 480, 720], Parent: noteRef, Open: false }) as PDFDict);
  addAnnot(
    page,
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [72, 560, 172, 620],
      C: [0.83, 0.18, 0.18],
      BS: { W: 2 },
      F: 4,
      AP: { N: ap('0.83 0.18 0.18 RG 2 w 1 1 98 58 re S', [0, 0, 100, 60]) },
    }) as PDFDict,
  );
  const file = ctx.register(ctx.stream('attached text', { Type: 'EmbeddedFile' }));
  addAnnot(
    page,
    ctx.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [400, 700, 420, 720],
      FS: { Type: 'Filespec', F: PDFString.of('note.txt'), EF: { F: file } },
      NM: PDFString.of('other-file-1'),
      F: 4,
      AP: { N: ap('0.2 0.4 0.8 rg 0 0 20 20 re f', [0, 0, 20, 20]) },
    }) as PDFDict,
  );
  return finish(doc);
}

/** Document-level embedded file "data.txt" (attachments are listed read-only). */
export async function attachmentDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 1, title: 'Attachment' }));
  await doc.attach(new TextEncoder().encode('hello attachment'), 'data.txt', {
    mimeType: 'text/plain',
    creationDate: FIXED_DATE,
    modificationDate: FIXED_DATE,
  });
  return finish(doc);
}

/** Strings that must not survive "Remove hidden data": the tests search the saved bytes for them. */
export const HIDDEN_MARKERS = {
  author: 'SECRET-AUTHOR-7731',
  xmp: 'SECRET-XMP-4418',
  script: 'SECRET-SCRIPT-9902',
  annotAuthor: 'SECRET-REVIEWER-5520',
  attachment: 'SECRET-ATTACHMENT-3306',
  oldRevision: 'SECRET-OLD-REVISION-1187',
} as const;

/**
 * A file carrying every kind of hidden data FR-SEC-12 removes: Info, XMP, a page thumbnail, document and
 * open-action JavaScript, an embedded file and a comment with an author. `oldRevision` is a title that tests
 * write in an incremental revision when they need an earlier revision in the bytes.
 */
export async function hiddenDataDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 1, title: 'Hidden data fixture' }));
  doc.setAuthor(HIDDEN_MARKERS.author);
  const ctx = doc.context;
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${HIDDEN_MARKERS.xmp}</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const xmpRef = ctx.register(ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' }));
  doc.catalog.set(PDFName.of('Metadata'), xmpRef);
  const page = doc.getPages()[0]!;
  const thumb = ctx.register(ctx.stream(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]), { Width: 2, Height: 2, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  page.node.set(PDFName.of('Thumb'), thumb);
  const js = ctx.obj({ S: 'JavaScript', JS: PDFString.of(`app.alert("${HIDDEN_MARKERS.script}");`) });
  doc.catalog.set(PDFName.of('OpenAction'), ctx.register(js));
  const jsName = ctx.obj({ Names: [PDFString.of('boot'), ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('var x = 1;') }))] });
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: jsName }));
  await doc.attach(new TextEncoder().encode(HIDDEN_MARKERS.attachment), 'notes.txt', { mimeType: 'text/plain' });
  const note = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [72, 700, 92, 720], Contents: PDFString.of('Check this'), T: PDFString.of(HIDDEN_MARKERS.annotAuthor), F: 4, P: page.ref }),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([note]));
  return finish(doc);
}

// ---- special files ---------------------------------------------------------------------------

/**
 * A file carrying a signature field with a (dummy) PKCS#7 value and ByteRange, enough for engines to
 * report "has signatures". The signature is not cryptographically valid — Folio never validates.
 */
export async function signedDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 1, title: 'Signed' }));
  const ctx = doc.context;
  const page = doc.getPages()[0]!;
  const sig = ctx.register(
    ctx.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 100, 200, 100],
      Contents: PDFHexString.of('00'.repeat(64)),
      Reason: PDFString.of('Fixture'),
      M: PDFString.of('D:20260110090000Z'),
    }),
  );
  const widget = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), V: sig, Rect: [72, 100, 272, 150], F: 132, P: page.ref }),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widget], SigFlags: 3 }));
  return finish(doc);
}

/** The registration form (all field types) with a signature field carrying a dummy signature value. */
export async function signedFormDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await acroFormDoc());
  const ctx = doc.context;
  const page = doc.getPages()[0]!;
  const sig = ctx.register(
    ctx.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 100, 200, 100],
      Contents: PDFHexString.of('00'.repeat(64)),
      Reason: PDFString.of('Fixture'),
      M: PDFString.of('D:20260110090000Z'),
    }),
  );
  const widget = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), V: sig, Rect: [320, 100, 520, 150], F: 132, P: page.ref }),
  );
  const annots = page.node.Annots();
  if (annots) annots.push(widget);
  else page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acro.lookup(PDFName.of('Fields'), PDFArray).push(widget);
  acro.set(PDFName.of('SigFlags'), ctx.obj(3));
  return finish(doc);
}

/** Valid header and objects but a truncated tail: the cross-reference table must be rebuilt. */
export async function damagedDoc(): Promise<Uint8Array> {
  const bytes = await textDoc({ pages: 2, title: 'Damaged' });
  const text = Buffer.from(bytes).toString('latin1');
  const cut = text.lastIndexOf('xref');
  return bytes.slice(0, cut);
}

/** Not a PDF at all. */
export function garbageBytes(): Uint8Array {
  return new TextEncoder().encode('This is definitely not a PDF file.\n'.repeat(4));
}

/** Many small pages for performance and virtualisation tests. */
export async function bigDoc(pages = 500): Promise<Uint8Array> {
  const doc = await newDoc(`Big document (${pages} pages)`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${p} of ${pages}`, { x: 72, y: 720, size: 20, font });
    for (let l = 0; l < 30; l++) page.drawText(`Line ${l + 1} of page ${p}: the quick brown fox jumps over the lazy dog.`, { x: 72, y: 690 - l * 20, size: 10, font });
  }
  return finish(doc);
}

export type { PDFFont };
