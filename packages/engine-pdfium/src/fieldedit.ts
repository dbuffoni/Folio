// Form field authoring on saved bytes (FR-FRM-08, FR-FRM-11, FR-FRM-16). PDFium's public API has no
// field creation or deletion, so, like formrepair.ts, pdf-lib does the structural work and the
// document is reloaded from the result (SPEC §8.7: one writer at a time, hand-over on saved bytes).
import { InvalidArgumentError, InvalidPdfError } from '@folio/core';
import type { FieldPatch, FieldSpec, Rect } from '@folio/ports';
import type { PDFDocument as PDFDocumentT, PDFField as PDFFieldT, PDFFont as PDFFontT } from 'pdf-lib';

type Lib = typeof import('pdf-lib');

const FF_MULTILINE = 1 << 12;
const FF_COMBO = 1 << 17;

function checkRect(r: Rect): void {
  if (!(r.width > 0 && r.height > 0) || ![r.x, r.y, r.width, r.height].every(Number.isFinite))
    throw new InvalidArgumentError('The field needs a rectangle with a positive size', { reason: 'badFieldRect' });
}
function checkName(name: string): void {
  if (!name || name.startsWith('.') || name.endsWith('.') || name.includes('..'))
    throw new InvalidArgumentError('Field names must not be empty or contain empty parts', { reason: 'badFieldName' });
}

async function load(bytes: Uint8Array): Promise<{ lib: Lib; pdf: PDFDocumentT }> {
  const lib = await import('pdf-lib');
  try {
    return { lib, pdf: await lib.PDFDocument.load(bytes, { updateMetadata: false }) };
  } catch (e) {
    // Encrypted documents never get here (`rewriteForms` refuses them first): the structure is unreadable.
    throw new InvalidPdfError(String(e), 'formEdit');
  }
}
const colour = (lib: Lib, c?: { r: number; g: number; b: number }) => (c ? lib.rgb(c.r / 255, c.g / 255, c.b / 255) : undefined);
const alignOf = (lib: Lib, a?: 'left' | 'center' | 'right') =>
  a === 'center' ? lib.TextAlignment.Center : a === 'right' ? lib.TextAlignment.Right : lib.TextAlignment.Left;

async function fontFor(lib: Lib, pdf: PDFDocumentT, family: FieldSpec['font']): Promise<PDFFontT> {
  const f = family === 'serif' ? lib.StandardFonts.TimesRoman : family === 'mono' ? lib.StandardFonts.Courier : lib.StandardFonts.Helvetica;
  return pdf.embedFont(f);
}
function lookup(pdf: PDFDocumentT, id: string): PDFFieldT {
  const form = pdf.getForm();
  const field = form.getFieldMaybe(id);
  if (!field) throw new InvalidArgumentError(`No form field "${id}"`, { field: id });
  return field;
}

/**
 * PDFium reads /MaxLen from the widget annotation only; pdf-lib writes it on the parent field. It is
 * inheritable, so repeating it on the widgets is valid and keeps every reader in agreement.
 */
function mirrorMaxLen(lib: Lib, field: PDFFieldT): void {
  if (!(field instanceof lib.PDFTextField)) return;
  const max = field.getMaxLength();
  for (const w of field.acroField.getWidgets()) {
    if (max === undefined) w.dict.delete(lib.PDFName.of('MaxLen'));
    else w.dict.set(lib.PDFName.of('MaxLen'), lib.PDFNumber.of(max));
  }
}

/** Adds fields. Returns the new bytes and the fully qualified name of every spec. */
export async function addFields(input: Uint8Array, specs: FieldSpec[]): Promise<{ bytes: Uint8Array; ids: string[] }> {
  const { lib, pdf } = await load(input);
  const form = pdf.getForm();
  const pages = pdf.getPages();
  const helv = await pdf.embedFont(lib.StandardFonts.Helvetica);
  const ids: string[] = [];
  const created = new Set<string>();
  for (const spec of specs) {
    checkName(spec.name);
    checkRect(spec.rect);
    const page = pages[spec.page];
    if (!page) throw new InvalidArgumentError(`Page ${spec.page + 1} does not exist`, { reason: 'badFieldPage' });
    const existing = form.getFieldMaybe(spec.name);
    const joinsGroup = spec.type === 'radio' && (created.has(spec.name) || existing instanceof lib.PDFRadioGroup);
    if (existing && !joinsGroup) throw new InvalidArgumentError(`A field named "${spec.name}" already exists`, { reason: 'fieldNameTaken', field: spec.name });
    const font = spec.font ? await fontFor(lib, pdf, spec.font) : helv;
    const widget = {
      x: spec.rect.x,
      y: spec.rect.y,
      width: spec.rect.width,
      height: spec.rect.height,
      textColor: colour(lib, spec.textColor),
      backgroundColor: colour(lib, spec.backgroundColor),
      borderColor: colour(lib, spec.borderColor),
      borderWidth: spec.borderWidth,
      font,
    };
    let field: PDFFieldT;
    switch (spec.type) {
      case 'text': {
        const f = form.createTextField(spec.name);
        if (spec.multiline) f.enableMultiline();
        if (spec.password) f.enablePassword();
        if (spec.maxLength) f.setMaxLength(Math.floor(spec.maxLength));
        if (spec.comb) {
          if (!spec.maxLength) throw new InvalidArgumentError('Comb fields need a maximum length', { reason: 'badFieldComb' });
          f.enableCombing();
        }
        if (spec.value) f.setText(spec.value);
        f.setAlignment(alignOf(lib, spec.align));
        f.addToPage(page, widget);
        if (spec.fontSize !== undefined) f.setFontSize(spec.fontSize);
        mirrorMaxLen(lib, f);
        field = f;
        break;
      }
      case 'checkbox': {
        const f = form.createCheckBox(spec.name);
        f.addToPage(page, widget);
        if (spec.value && spec.value !== 'Off') f.check();
        field = f;
        break;
      }
      case 'radio': {
        const group = joinsGroup ? form.getRadioGroup(spec.name) : form.createRadioGroup(spec.name);
        const option = spec.exportValue ?? String(group.getOptions().length + 1);
        if (group.getOptions().includes(option)) throw new InvalidArgumentError(`The group "${spec.name}" already has an option "${option}"`, { reason: 'radioOptionTaken' });
        group.addOptionToPage(option, page, widget);
        if (spec.value === option) group.select(option);
        field = group;
        break;
      }
      case 'dropdown':
      case 'listbox': {
        const f = spec.type === 'dropdown' ? form.createDropdown(spec.name) : form.createOptionList(spec.name);
        const labels = (spec.options ?? []).map((o) => o.label);
        if (labels.length) f.addOptions(labels);
        if (spec.value && labels.includes(spec.value)) f.select(spec.value);
        f.addToPage(page, widget);
        if (spec.fontSize !== undefined) f.setFontSize(spec.fontSize);
        field = f;
        break;
      }
      case 'button': {
        const f = form.createButton(spec.name);
        f.addToPage(spec.caption ?? '', page, widget);
        field = f;
        break;
      }
      case 'signature': {
        // pdf-lib has no signature fields: an empty /Sig field with one widget, as other editors write it.
        const ctx = pdf.context;
        const N = lib.PDFName.of;
        const dict = ctx.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Sig',
          T: lib.PDFHexString.fromText(spec.name),
          F: 4,
          Rect: [spec.rect.x, spec.rect.y, spec.rect.x + spec.rect.width, spec.rect.y + spec.rect.height],
          P: page.ref,
        });
        const ref = ctx.register(dict);
        page.node.addAnnot(ref);
        const fields = form.acroForm.dict.lookup(N('Fields'), lib.PDFArray);
        fields.push(ref);
        ids.push(spec.name);
        created.add(spec.name);
        if (spec.tooltip) dict.set(N('TU'), lib.PDFHexString.fromText(spec.tooltip));
        continue;
      }
    }
    if (spec.required) field.enableRequired();
    if (spec.readOnly) field.enableReadOnly();
    if (spec.tooltip) field.acroField.dict.set(lib.PDFName.of('TU'), lib.PDFHexString.fromText(spec.tooltip));
    created.add(spec.name);
    ids.push(field.getName());
  }
  form.updateFieldAppearances(helv);
  return { bytes: await pdf.save({ useObjectStreams: false, updateFieldAppearances: false }), ids };
}

export async function patchField(input: Uint8Array, id: string, patch: FieldPatch): Promise<Uint8Array> {
  const { lib, pdf } = await load(input);
  const field = lookup(pdf, id);
  const acro = field.acroField;
  if (patch.tooltip !== undefined) {
    if (patch.tooltip === '') acro.dict.delete(lib.PDFName.of('TU'));
    else acro.dict.set(lib.PDFName.of('TU'), lib.PDFHexString.fromText(patch.tooltip));
  }
  if (patch.required === true) field.enableRequired();
  else if (patch.required === false) field.disableRequired();
  if (patch.readOnly === true) field.enableReadOnly();
  else if (patch.readOnly === false) field.disableReadOnly();
  if (patch.multiline !== undefined) {
    if (!(field instanceof lib.PDFTextField)) throw new InvalidArgumentError('Only text fields can be multiline', { reason: 'badFieldType' });
    acro.setFlagTo(FF_MULTILINE, patch.multiline);
  }
  if (patch.maxLength !== undefined) {
    if (!(field instanceof lib.PDFTextField)) throw new InvalidArgumentError('Only text fields have a maximum length', { reason: 'badFieldType' });
    field.setMaxLength(patch.maxLength === null ? undefined : Math.max(1, Math.floor(patch.maxLength)));
    mirrorMaxLen(lib, field);
  }
  if (patch.listbox !== undefined) {
    if (!(field instanceof lib.PDFDropdown) && !(field instanceof lib.PDFOptionList)) throw new InvalidArgumentError('Only choice fields can switch between dropdown and list', { reason: 'badFieldType' });
    acro.setFlagTo(FF_COMBO, !patch.listbox);
  }
  if (patch.options !== undefined) {
    if (!(field instanceof lib.PDFDropdown) && !(field instanceof lib.PDFOptionList)) throw new InvalidArgumentError('Only choice fields have options', { reason: 'badFieldType' });
    const labels = patch.options.map((o) => o.label);
    if (field instanceof lib.PDFDropdown) field.setOptions(labels);
    else field.setOptions(labels);
  }
  if (patch.fontSize !== undefined && (field instanceof lib.PDFTextField || field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList)) field.setFontSize(patch.fontSize);
  if (patch.align !== undefined && field instanceof lib.PDFTextField) field.setAlignment(alignOf(lib, patch.align));
  const helv = await pdf.embedFont(lib.StandardFonts.Helvetica);
  pdf.getForm().updateFieldAppearances(helv);
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

export async function moveWidget(input: Uint8Array, id: string, widget: number, rect: Rect): Promise<Uint8Array> {
  checkRect(rect);
  const { lib, pdf } = await load(input);
  const field = lookup(pdf, id);
  const w = field.acroField.getWidgets()[widget];
  if (!w) throw new InvalidArgumentError(`Field "${id}" has no widget ${widget}`, { field: id });
  w.setRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  // Regenerate this field's appearance at the new size.
  const helv = await pdf.embedFont(lib.StandardFonts.Helvetica);
  field.defaultUpdateAppearances(helv);
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

export async function deleteField(input: Uint8Array, id: string, widget?: number): Promise<Uint8Array> {
  const { lib, pdf } = await load(input);
  const form = pdf.getForm();
  const field = lookup(pdf, id);
  const widgets = field.acroField.getWidgets();
  if (widget === undefined || widgets.length <= 1) {
    form.removeField(field);
  } else {
    const w = widgets[widget];
    if (!w) throw new InvalidArgumentError(`Field "${id}" has no widget ${widget}`, { field: id });
    // Find the annotation reference of this widget on its page and take it out of the field and the page.
    const ctx = pdf.context;
    for (const page of pdf.getPages()) {
      const annots = page.node.Annots();
      for (let k = 0; annots && k < annots.size(); k++) {
        const ref = annots.get(k);
        if (ref instanceof lib.PDFRef && ctx.lookup(ref) === w.dict) {
          page.node.removeAnnot(ref);
          field.acroField.removeWidget(widget);
          if (field instanceof lib.PDFRadioGroup) field.acroField.dict.delete(lib.PDFName.of('V'));
        }
      }
    }
  }
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}
