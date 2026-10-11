import { InvalidArgumentError, InvalidPdfError } from '@folio/core';
import type {
  FieldId,
  FieldValue,
  FormField,
  FormFieldType,
  FormWidget,
  PageIndex,
  Rect,
} from '@folio/ports';
import type { DocInternals } from './document.ts';
import { getUtf16, scope, type Arena, type Pdfium, type Ptr } from './mem.ts';

const WIDGET = 20;
const TYPES: Record<number, FormFieldType> = {
  1: 'button',
  2: 'checkbox',
  3: 'radio',
  4: 'dropdown',
  5: 'listbox',
  6: 'text',
  7: 'signature',
};
const FF_READONLY = 1 << 0;
const FF_REQUIRED = 1 << 1;
const FF_MULTILINE = 1 << 12;
const FF_PASSWORD = 1 << 13;
const FF_COMB = 1 << 24;
const FF_MULTISELECT = 1 << 21;
const AACTION_FORMAT = 13;

interface WidgetRef {
  page: PageIndex;
  index: number;
}

function rectOf(m: Pdfium, a: Arena, annot: Ptr): Rect {
  const p = a.alloc(16);
  m.FPDFAnnot_GetRect(annot, p);
  const [l, t, r, b] = [a.f32(p, 0), a.f32(p, 1), a.f32(p, 2), a.f32(p, 3)];
  return { x: Math.min(l, r), y: Math.min(b, t), width: Math.abs(r - l), height: Math.abs(t - b) };
}

/** Interprets the common Acrobat format scripts without executing them (FR-FRM-03). */
export function parseFormatScript(js: string): FormField['format'] {
  let m = /AFNumber_Format\(\s*(\d+)/.exec(js);
  if (m) return { kind: 'number', decimals: Number(m[1]) };
  m = /AFPercent_Format\(\s*(\d+)/.exec(js);
  if (m) return { kind: 'percent', decimals: Number(m[1]) };
  m = /AFDate_Format(?:Ex)?\(\s*["']([^"']+)["']/.exec(js);
  if (m) return { kind: 'date', pattern: m[1]! };
  return undefined;
}

/** Visits every widget annotation of the document. The callback must not keep the handle. */
function eachWidget(d: DocInternals, fn: (annot: Ptr, ref: WidgetRef, page: Ptr) => void | 'stop'): void {
  const m = d.m;
  for (let p = 0; p < d.pageCount; p++) {
    if (m.EPDFPage_GetAnnotCountRaw(d.doc, p) <= 0) continue;
    const page = d.page(p);
    const n = m.FPDFPage_GetAnnotCount(page);
    for (let k = 0; k < n; k++) {
      const annot = m.FPDFPage_GetAnnot(page, k);
      if (!annot) continue;
      let stop = false;
      try {
        if (m.FPDFAnnot_GetSubtype(annot) === WIDGET)
          stop = fn(annot, { page: p, index: k }, page) === 'stop';
      } finally {
        m.FPDFPage_CloseAnnot(annot);
      }
      if (stop) return;
    }
  }
}

const fieldName = (d: DocInternals, annot: Ptr): string =>
  getUtf16(d.m, (b, l) => d.m.FPDFAnnot_GetFormFieldName(d.form(), annot, b, l));
const fieldIdOf = (name: string, ref: WidgetRef): FieldId => name || `#p${ref.page}-${ref.index}`;

export function list(d: DocInternals): FormField[] {
  const m = d.m;
  const fh = d.form();
  const fields = new Map<FieldId, FormField>();
  eachWidget(d, (annot, ref) => {
    scope(m, (a) => {
      const name = fieldName(d, annot);
      const id = fieldIdOf(name, ref);
      const typeNum = m.FPDFAnnot_GetFormFieldType(fh, annot);
      const type = TYPES[typeNum];
      if (!type) return;
      const flags = Math.max(0, m.FPDFAnnot_GetFormFieldFlags(fh, annot));
      const exportValue = getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldExportValue(fh, annot, b, l));
      const widget: FormWidget = { page: ref.page, rect: rectOf(m, a, annot) };
      if (type === 'checkbox' || type === 'radio') widget.exportValue = exportValue || 'Yes';
      const checked = (type === 'checkbox' || type === 'radio') && m.FPDFAnnot_IsChecked(fh, annot);

      let field = fields.get(id);
      if (!field) {
        const value = getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldValue(fh, annot, b, l));
        field = {
          id,
          name,
          type,
          label: getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldAlternateName(fh, annot, b, l)) || undefined,
          value: type === 'checkbox' || type === 'radio' ? 'Off' : value.replace(/\r\n?/g, '\n'),
          widgets: [],
          readOnly: (flags & FF_READONLY) !== 0 || type === 'button' || type === 'signature',
          required: (flags & FF_REQUIRED) !== 0,
          multiline: type === 'text' && (flags & FF_MULTILINE) !== 0,
          password: type === 'text' && (flags & FF_PASSWORD) !== 0,
          comb: type === 'text' && (flags & FF_COMB) !== 0,
          multiSelect: type === 'listbox' && (flags & FF_MULTISELECT) !== 0,
        };
        if (type === 'dropdown' || type === 'listbox') {
          const n = Math.max(0, m.FPDFAnnot_GetOptionCount(fh, annot));
          field.options = [];
          const selected: string[] = [];
          for (let k = 0; k < n; k++) {
            const label = getUtf16(m, (b, l) => m.FPDFAnnot_GetOptionLabel(fh, annot, k, b, l));
            field.options.push({ label, value: label });
            if (m.FPDFAnnot_IsOptionSelected(fh, annot, k)) selected.push(label);
          }
          if (type === 'listbox') field.values = selected;
          if (!field.value && selected[0]) field.value = selected[0];
        }
        if (type === 'text') {
          const p = a.alloc(4);
          if (m.FPDFAnnot_GetNumberValue(annot, 'MaxLen', p) && a.f32(p) > 0)
            field.maxLength = Math.round(a.f32(p));
          const js = getUtf16(m, (b, l) =>
            m.FPDFAnnot_GetFormAdditionalActionJavaScript(fh, annot, AACTION_FORMAT, b, l),
          );
          if (js) field.format = parseFormatScript(js);
        }
        fields.set(id, field);
      }
      field.widgets.push(widget);
      if (checked) field.value = widget.exportValue!;
    });
  });
  return [...fields.values()];
}

/** Runs `fn` with each widget of the field; returns how many widgets were visited. */
function withField(
  d: DocInternals,
  id: FieldId,
  fn: (annot: Ptr, ref: WidgetRef, page: Ptr) => void | 'stop',
): number {
  let count = 0;
  eachWidget(d, (annot, ref, page) => {
    if (fieldIdOf(fieldName(d, annot), ref) !== id) return;
    count++;
    return fn(annot, ref, page);
  });
  if (count === 0) throw new InvalidArgumentError(`No form field "${id}"`, { field: id });
  return count;
}

function click(d: DocInternals, a: Arena, page: Ptr, annot: Ptr): void {
  const m = d.m;
  const fh = d.form();
  const r = rectOf(m, a, annot);
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  m.FORM_OnMouseMove(fh, page, 0, x, y);
  m.FORM_OnLButtonDown(fh, page, 0, x, y);
  m.FORM_OnLButtonUp(fh, page, 0, x, y);
  m.FORM_ForceToKillFocus(fh);
}

/**
 * Values are written through PDFium's form filler (focus → edit → blur), the same path a viewer uses,
 * so the field value, widget states and appearance streams stay consistent. No JavaScript runs:
 * the build has no script engine attached.
 */
export function setValue(d: DocInternals, id: FieldId, v: FieldValue): void {
  const m = d.m;
  const fh = d.form();
  let done = false;
  withField(d, id, (annot, _ref, page) =>
    scope(m, (a) => {
      const type = TYPES[m.FPDFAnnot_GetFormFieldType(fh, annot)];
      const flags = Math.max(0, m.FPDFAnnot_GetFormFieldFlags(fh, annot));
      if (!type || type === 'button' || type === 'signature' || flags & FF_READONLY) {
        throw new InvalidArgumentError(`Field "${id}" is read-only`, { field: id });
      }
      switch (type) {
        case 'text': {
          if (typeof v !== 'string') throw new InvalidArgumentError(`Field "${id}" expects text`);
          if (!m.FORM_SetFocusedAnnot(fh, annot)) throw new InvalidPdfError(`Could not focus field "${id}"`);
          m.FORM_SelectAllText(fh, page);
          m.FORM_ReplaceSelection(fh, page, a.utf16(v.replace(/\r\n?|\n/g, '\r')));
          m.FORM_ForceToKillFocus(fh);
          done = true;
          return 'stop';
        }
        case 'checkbox': {
          const want =
            v === true || (typeof v === 'string' && v !== '' && v !== 'Off' && v.toLowerCase() !== 'false');
          if (!!m.FPDFAnnot_IsChecked(fh, annot) !== want) click(d, a, page, annot);
          done = true;
          return 'stop';
        }
        case 'radio': {
          if (typeof v !== 'string') throw new InvalidArgumentError(`Field "${id}" expects an option name`);
          const exp = getUtf16(m, (b, l) => m.FPDFAnnot_GetFormFieldExportValue(fh, annot, b, l));
          if (exp !== v) return; // keep looking for the widget carrying this option
          if (!m.FPDFAnnot_IsChecked(fh, annot)) click(d, a, page, annot);
          done = true;
          return 'stop';
        }
        case 'dropdown':
        case 'listbox': {
          const wanted = Array.isArray(v) ? v : typeof v === 'string' ? (v === '' ? [] : [v]) : [];
          const n = Math.max(0, m.FPDFAnnot_GetOptionCount(fh, annot));
          const labels = Array.from({ length: n }, (_, k) =>
            getUtf16(m, (b, l) => m.FPDFAnnot_GetOptionLabel(fh, annot, k, b, l)),
          );
          for (const w of wanted) {
            if (!labels.includes(w))
              throw new InvalidArgumentError(`"${w}" is not an option of field "${id}"`, { field: id });
          }
          if (type === 'dropdown' && wanted.length > 1)
            throw new InvalidArgumentError(`Field "${id}" takes one value`);
          if (!m.FORM_SetFocusedAnnot(fh, annot)) throw new InvalidPdfError(`Could not focus field "${id}"`);
          labels.forEach((label, k) => {
            const sel = wanted.includes(label);
            if (!!m.FORM_IsIndexSelected(fh, page, k) !== sel) m.FORM_SetIndexSelected(fh, page, k, sel);
          });
          m.FORM_ForceToKillFocus(fh);
          done = true;
          return 'stop';
        }
      }
      return undefined;
    }),
  );
  if (!done)
    throw new InvalidArgumentError(`"${String(v)}" is not an option of field "${id}"`, { field: id });
}

/** Sets the partial name (/T) of the field; the returned id is the new fully qualified name. */
export function rename(d: DocInternals, id: FieldId, name: string): FieldId {
  if (!name || name.includes('.')) throw new InvalidArgumentError('Invalid field name');
  const m = d.m;
  const fh = d.form();
  let target: WidgetRef | null = null;
  withField(d, id, (annot, ref) => {
    if (scope(m, (a) => !!m.EPDFAnnot_SetFormFieldName(fh, annot, a.utf16(name)))) target = ref;
    return 'stop';
  });
  if (!target) throw new InvalidPdfError(`Could not rename field "${id}"`);
  d.resetForm();
  let renamed = '';
  eachWidget(d, (annot, ref) => {
    if (ref.page !== target!.page || ref.index !== target!.index) return;
    renamed = fieldIdOf(fieldName(d, annot), ref);
    return 'stop';
  });
  return renamed;
}

const FLAG_HIDDEN = 0x02;
/** Burns field values into the page content and removes the widgets (FR-FRM-05). */
export function flatten(d: DocInternals): void {
  const m = d.m;
  d.form(); // make sure appearances are current
  m.FORM_ForceToKillFocus(d.form());
  for (let p = 0; p < d.pageCount; p++) {
    if (m.EPDFPage_GetAnnotCountRaw(d.doc, p) <= 0) continue;
    const page = d.page(p);
    let changed = false;
    for (let k = m.FPDFPage_GetAnnotCount(page) - 1; k >= 0; k--) {
      const annot = m.FPDFPage_GetAnnot(page, k);
      if (!annot) continue;
      const isWidget = m.FPDFAnnot_GetSubtype(annot) === WIDGET;
      const done = isWidget && m.EPDFAnnot_Flatten(page, annot);
      m.FPDFPage_CloseAnnot(annot);
      changed ||= !!done;
    }
    // Widgets with on/off appearance states are not handled per annotation: flatten the page with
    // every other annotation temporarily hidden so only the remaining widgets are burned in.
    const hidden: number[] = [];
    let left = 0;
    for (let k = 0; k < m.FPDFPage_GetAnnotCount(page); k++) {
      const annot = m.FPDFPage_GetAnnot(page, k);
      if (!annot) continue;
      if (m.FPDFAnnot_GetSubtype(annot) === WIDGET) left++;
      else if (!(m.FPDFAnnot_GetFlags(annot) & FLAG_HIDDEN)) {
        m.FPDFAnnot_SetFlags(annot, m.FPDFAnnot_GetFlags(annot) | FLAG_HIDDEN);
        hidden.push(m.EPDFAnnot_GetObjectNumber(annot));
      }
      m.FPDFPage_CloseAnnot(annot);
    }
    if (left > 0) {
      m.FPDFPage_Flatten(page, 0);
      changed = true;
    }
    for (let k = 0; hidden.length && k < m.FPDFPage_GetAnnotCount(page); k++) {
      const annot = m.FPDFPage_GetAnnot(page, k);
      if (!annot) continue;
      if (hidden.includes(m.EPDFAnnot_GetObjectNumber(annot))) m.FPDFAnnot_SetFlags(annot, m.FPDFAnnot_GetFlags(annot) & ~FLAG_HIDDEN);
      m.FPDFPage_CloseAnnot(annot);
    }
    if (changed) d.commitPage(p);
  }
}
