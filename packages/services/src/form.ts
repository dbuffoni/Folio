import { CompositeCommand, InvalidArgumentError, formatDate, intersects, unionAll, type Command } from '@folio/core';
import type { Annotation, FieldValue, FormField, FreeTextAnnotation, PageIndex, PageObject, PdfDocument, Point, Rect, StandardFontFamily, TextLayer } from '@folio/ports';
import { inverseCommand, checkpointCommand, label } from './commands.ts';

const sameValue = (a: FieldValue, b: FieldValue): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Current value of a field in the shape `setFieldValue` accepts. */
export function currentValue(f: FormField): FieldValue {
  if (f.type === 'listbox') return [...(f.values ?? (f.value ? [f.value] : []))];
  if (f.type === 'checkbox') return f.value !== 'Off' && f.value !== '';
  return f.value;
}
/** Empty value for "clear field". */
export function emptyValue(f: FormField): FieldValue {
  return f.type === 'listbox' ? [] : f.type === 'checkbox' ? false : '';
}
export const isFillable = (f: FormField): boolean => !f.readOnly && f.type !== 'button' && f.type !== 'signature';

/** Reading order for Tab / Shift+Tab: page, then top to bottom, then left to right (FR-FRM-02). */
export function tabOrder(fields: FormField[]): Array<{ field: FormField; widget: number }> {
  const stops = fields.filter(isFillable).flatMap((field) => field.widgets.map((w, widget) => ({ field, widget, w })));
  stops.sort((a, b) => a.w.page - b.w.page || (Math.abs(a.w.rect.y - b.w.rect.y) > Math.min(a.w.rect.height, b.w.rect.height) / 2 ? b.w.rect.y - a.w.rect.y : a.w.rect.x - b.w.rect.x));
  return stops.map(({ field, widget }) => ({ field, widget }));
}
export function nextStop(count: number, current: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  return current < 0 ? (direction > 0 ? 0 : count - 1) : (((current + direction) % count) + count) % count;
}

/** Display formatting for known simple formats; the stored value is not changed (FR-FRM-03). */
export function formatFieldValue(f: FormField, locale = 'en'): string {
  if (!f.format || f.value === '') return f.value;
  if (f.format.kind === 'number' || f.format.kind === 'percent') {
    const num = Number(f.value.replace(',', '.'));
    if (!Number.isFinite(num)) return f.value;
    const text = new Intl.NumberFormat(locale, { minimumFractionDigits: f.format.decimals, maximumFractionDigits: f.format.decimals }).format(f.format.kind === 'percent' ? num * 100 : num);
    return f.format.kind === 'percent' ? `${text}%` : text;
  }
  const d = new Date(f.value);
  if (Number.isNaN(d.getTime())) return f.value;
  const p = f.format.pattern.toLowerCase();
  return p.startsWith('yyyy') ? formatDate(d, 'iso') : p.startsWith('mm') ? formatDate(d, 'mdy') : p.startsWith('dd') ? formatDate(d, 'dmy') : f.value;
}
/** Text accepted by a field: maximum length and comb cells are enforced before the engine sees it. */
export function clampToField(f: FormField, text: string): string {
  const single = f.multiline ? text : text.replace(/[\r\n]+/g, ' ');
  return f.maxLength ? [...single].slice(0, f.maxLength).join('') : single;
}

export interface FormData {
  version: 1;
  fields: Record<string, string | boolean | string[]>;
}

export interface CoverTextStyle {
  fontFamily: StandardFontFamily;
  fontSize: number;
  color: { r: number; g: number; b: number };
}
export const DEFAULT_COVER_STYLE: CoverTextStyle = { fontFamily: 'sans', fontSize: 11, color: { r: 17, g: 17, b: 17 } };

export type DetectedKind = 'text' | 'checkbox' | 'comb';
export interface DetectedArea {
  /** Stable id `p{page}-a{n}` (1-based page, 1-based n), SPEC §10.3. */
  id: string;
  page: PageIndex;
  rect: Rect;
  kind: DetectedKind;
  /** Nearby label text, when one was found. */
  label?: string;
  /** Number of cells for comb areas. */
  cells?: number;
  /** True when the area is a run of dots or underscores printed in the text: its bottom edge is the text line, not free space. */
  leader?: boolean;
}

const right = (r: Rect): number => r.x + r.width;
const topOf = (r: Rect): number => r.y + r.height;

/**
 * Local detection of fillable areas on a non-fillable page (FR-FRM-07): ruled lines, empty boxes,
 * comb boxes, check squares and underscore runs, each paired with the closest label.
 */
export function detectAreas(page: PageIndex, objects: PageObject[], layer: TextLayer): Omit<DetectedArea, 'id'>[] {
  const paths = objects.filter((o) => o.type === 'path').map((o) => o.bounds);
  const found: Array<Omit<DetectedArea, 'id' | 'label'> & { preLabel?: string }> = [];

  // Boxes: comb rows first (adjacent equal cells), then check squares, then free boxes.
  const boxes = paths.filter((b) => b.height >= 8 && b.height <= 70 && b.width >= 8).sort((a, b) => b.y - a.y || a.x - b.x);
  const used = new Set<Rect>();
  for (const b of boxes) {
    if (used.has(b)) continue;
    const row = [b];
    for (;;) {
      const last = row[row.length - 1]!;
      const next = boxes.find((o) => !used.has(o) && !row.includes(o) && Math.abs(o.y - last.y) < 1.5 && Math.abs(o.height - last.height) < 1.5 && Math.abs(o.width - last.width) < 1.5 && Math.abs(o.x - right(last)) < 2.5);
      if (!next) break;
      row.push(next);
    }
    if (row.length >= 3 && b.width <= 40) {
      row.forEach((r) => used.add(r));
      found.push({ page, rect: unionAll(row), kind: 'comb', cells: row.length });
    }
  }
  for (const b of boxes) {
    if (used.has(b)) continue;
    used.add(b);
    const square = Math.abs(b.width - b.height) <= 3 && b.width <= 20;
    if (square) found.push({ page, rect: b, kind: 'checkbox' });
    else if (b.width >= 30) found.push({ page, rect: b, kind: 'text' });
  }
  // Ruled lines: a thin wide path with free space above it.
  for (const l of paths) {
    if (l.height > 3 || l.width < 40) continue;
    const area = { x: l.x, y: l.y + l.height / 2, width: l.width, height: 16 };
    // Skip table rules and box edges: a writing line has nothing but white above it.
    const crowded = layer.runs.some((r) => intersects(r.rect, { ...area, y: area.y + 2, height: 10 })) || found.some((f) => intersects(f.rect, { ...area, y: area.y + 1, height: 6 }));
    if (!crowded) found.push({ page, rect: area, kind: 'text' });
  }
  // Leaders inside text: underscore runs and the dotted lines of word-processor forms ("name ………………").
  // An ellipsis character counts as three dots; fewer than six dots is punctuation, not a field.
  const weight = (t: string | undefined): number => (t === '_' ? 2 : t === '…' ? 3 : t === '.' || t === '·' ? 1 : 0);
  let start = -1;
  for (let i = 0; i <= layer.chars.length; i++) {
    const leader = weight(layer.chars[i]?.text) > 0;
    if (leader && start < 0) start = i;
    if (!leader && start >= 0) {
      const run = layer.chars.slice(start, i);
      if (run.reduce((n, c) => n + weight(c.text), 0) >= 6 && !(run[0]?.text === '_' && i - start < 4)) {
        const rects = run.map((c) => c.rect).filter((r) => r.width > 0);
        if (rects.length) {
          const u = unionAll(rects);
          // The words before the leader on the same line name it.
          let from = start;
          while (from > 0 && start - from < 60 && !/[\n\r]/.test(layer.chars[from - 1]!.text) && weight(layer.chars[from - 1]!.text) === 0) from--;
          const before = layer.chars.slice(from, start).map((c) => c.text).join('').replace(/[:\s]+$/g, '').trim();
          found.push({ page, rect: { x: u.x, y: u.y, width: u.width, height: Math.max(14, u.height) }, kind: 'text', leader: true, ...(/\p{L}{2}/u.test(before) ? { preLabel: before } : {}) });
        }
      }
      start = -1;
    }
  }

  // Labels: text on the same row to the left (or to the right for check squares), else just above.
  const labels = layer.lines.map((l) => ({ text: l.text.replace(/[_.…·]{2,}/g, '').replace(/[:\s]+$/g, '').trim(), rect: l.rect })).filter((l) => l.text.length > 0);
  const labelFor = (a: Omit<DetectedArea, 'id' | 'label'> & { preLabel?: string }): string | undefined => {
    if (a.preLabel) return a.preLabel;
    let best: { text: string; score: number } | undefined;
    const midY = a.rect.y + a.rect.height / 2;
    for (const l of labels) {
      const lMid = l.rect.y + l.rect.height / 2;
      const sameRow = Math.abs(lMid - midY) <= Math.max(8, a.rect.height * 0.6);
      let score = Infinity;
      if (sameRow && a.kind !== 'checkbox' && right(l.rect) <= a.rect.x + 4) score = a.rect.x - right(l.rect);
      else if (sameRow && a.kind === 'checkbox' && l.rect.x >= right(a.rect) - 2) score = l.rect.x - right(a.rect);
      else if (l.rect.y >= topOf(a.rect) - 2 && l.rect.y - topOf(a.rect) < 16 && l.rect.x < right(a.rect) && right(l.rect) > a.rect.x - 4) score = 40 + (l.rect.y - topOf(a.rect));
      else if (sameRow && a.kind !== 'checkbox' && l.rect.x < right(a.rect) && right(l.rect) > a.rect.x) score = 5; // label and underscores share one text object
      if (score < 220 && (!best || score < best.score)) best = { text: l.text, score };
    }
    return best?.text;
  };
  return found.sort((a, b) => topOf(b.rect) - topOf(a.rect) || a.rect.x - b.rect.x).map(({ preLabel: _pre, ...a }) => ({ ...a, label: labelFor({ ...a, preLabel: _pre }) }));
}

/** Forms: fill, reset, import/export, Cover & type and area detection (FR-FRM-01…03, 05…07, 09). */
export class FormService {
  constructor(private readonly deps: { newId: () => string }) {}

  fields(doc: PdfDocument): Promise<FormField[]> {
    return doc.listFormFields();
  }

  /** Sets one field. Typing in the same field coalesces into a single undo step. */
  fill(field: FormField, value: FieldValue): Command<void> {
    if (!isFillable(field)) throw new InvalidArgumentError(`"${field.name}" cannot be edited`, { reason: 'readOnly', field: field.name });
    const next = typeof value === 'string' && field.type === 'text' ? clampToField(field, value) : value;
    const make = (from: FieldValue, to: FieldValue): Command<void> & { fill: { id: string; to: FieldValue } } =>
      Object.assign(
        inverseCommand(
          label('cmd.fillField'),
          'form',
          ({ doc }) => doc.setFieldValue(field.id, to),
          ({ doc }) => doc.setFieldValue(field.id, from),
          { kind: 'form' },
          (later) => {
            const f = (later as { fill?: { id: string; to: FieldValue } }).fill;
            return f && f.id === field.id && field.type === 'text' ? make(from, f.to) : null;
          },
        ),
        { fill: { id: field.id, to } },
      );
    return make(currentValue(field), next);
  }

  /** Several fields as one undo step (Smart Fill, import). Unchanged values are skipped. */
  fillMany(items: Array<{ field: FormField; value: FieldValue }>, labelKey = 'cmd.fillFields'): Command | null {
    const commands = items.filter((i) => !sameValue(currentValue(i.field), i.value)).map((i) => this.fill(i.field, i.value));
    return commands.length ? new CompositeCommand(label(labelKey, { count: commands.length }), commands) : null;
  }
  clear(field: FormField): Command<void> {
    return this.fill(field, emptyValue(field));
  }
  /** Reset form: every fillable field back to empty. */
  reset(fields: FormField[]): Command | null {
    return this.fillMany(fields.filter(isFillable).map((field) => ({ field, value: emptyValue(field) })), 'cmd.resetForm');
  }

  exportData(fields: FormField[]): FormData {
    const out: FormData = { version: 1, fields: {} };
    for (const f of fields) if (f.type !== 'button' && f.type !== 'signature') out.fields[f.name] = currentValue(f);
    return out;
  }
  /** Applies exported data; unknown names and read-only fields are reported, not applied. */
  importData(fields: FormField[], data: unknown): { command: Command | null; skipped: string[] } {
    const d = data as Partial<FormData> | null;
    if (!d || d.version !== 1 || typeof d.fields !== 'object' || d.fields === null) throw new InvalidArgumentError('This is not a Folio form data file', { reason: 'badFormData' });
    const byName = new Map(fields.map((f) => [f.name, f]));
    const items: Array<{ field: FormField; value: FieldValue }> = [];
    const skipped: string[] = [];
    for (const [name, raw] of Object.entries(d.fields)) {
      const field = byName.get(name);
      const okType = typeof raw === 'string' || typeof raw === 'boolean' || (Array.isArray(raw) && raw.every((v) => typeof v === 'string'));
      const fits = field && isFillable(field) && okType && (field.type !== 'radio' || raw === 'Off' || field.widgets.some((w) => w.exportValue === raw)) && (!field.options || [raw].flat().every((v) => v === '' || field.options!.some((o) => o.label === v)));
      if (!fits || (field.type === 'radio' && raw === 'Off')) {
        if (!(field?.type === 'radio' && raw === 'Off')) skipped.push(name);
        continue;
      }
      items.push({ field, value: raw });
    }
    return { command: this.fillMany(items, 'cmd.importFormData'), skipped };
  }

  // ---- Cover & type (FR-FRM-06) --------------------------------------------------------------

  /** Detected areas of one page with stable ids. */
  async detect(doc: PdfDocument, page: PageIndex): Promise<DetectedArea[]> {
    const [objects, layer] = [await doc.listObjects(page), await doc.getTextLayer(page)];
    return detectAreas(page, objects, layer).map((a, k) => ({ ...a, id: `p${page + 1}-a${k + 1}` }));
  }

  /**
   * Text box for typing at a clicked point: snaps to a detected area under the point, otherwise to the
   * text line height around it, otherwise a default one-line box.
   */
  boxAt(p: Point, areas: DetectedArea[], layer: TextLayer, style: CoverTextStyle = DEFAULT_COVER_STYLE): { rect: Rect; fontSize: number; area?: DetectedArea } {
    const area = areas.find((a) => a.kind !== 'checkbox' && p.x >= a.rect.x && p.x <= right(a.rect) && p.y >= a.rect.y - 2 && p.y <= topOf(a.rect) + 2);
    if (area) return { rect: area.rect, fontSize: Math.min(style.fontSize, Math.max(7, area.rect.height * 0.7)), area };
    const line = layer.lines.find((l) => p.y >= l.rect.y - 2 && p.y <= topOf(l.rect) + 2);
    const fontSize = line ? Math.max(7, layer.runs[line.runs[0]!]!.fontSize) : style.fontSize;
    const height = fontSize * 1.45;
    return { rect: { x: p.x, y: (line ? line.rect.y : p.y - height / 2), width: 180, height: line ? Math.max(height, line.rect.height) : height }, fontSize };
  }

  /** Typed text for a non-fillable form: a border-less FreeText annotation that other viewers can still edit. */
  coverText(rect: Rect, text: string, style: Partial<CoverTextStyle> = {}): FreeTextAnnotation {
    const s = { ...DEFAULT_COVER_STYLE, ...style };
    // The box grows downwards (top edge kept) so wrapped lines are not clipped; width is the field's.
    const perLine = Math.max(1, Math.floor((rect.width - 4) / (s.fontSize * 0.6)));
    const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    const height = lines > 1 ? Math.max(rect.height, lines * s.fontSize * 1.3 + 4) : rect.height;
    const box = height > rect.height ? { ...rect, y: rect.y + rect.height - height, height } : rect;
    return { type: 'freetext', id: this.deps.newId(), rect: box, contents: text, fontFamily: s.fontFamily, fontSize: s.fontSize, textColor: s.color, align: 'left', borderWidth: 0 };
  }
  /** Ghost → text box in one click (FR-FRM-07). */
  fromArea(area: DetectedArea, text = '', style: Partial<CoverTextStyle> = {}): Annotation {
    const wanted = Math.min(style.fontSize ?? DEFAULT_COVER_STYLE.fontSize, Math.max(7, area.rect.height * 0.7));
    // A long value shrinks (down to 6 pt) instead of running past the end of the field and being clipped.
    const fits = text.length === 0 ? wanted : ((area.rect.width - 4) / (text.length * 0.6));
    const fontSize = Math.max(Math.min(6, wanted), Math.min(wanted, fits));
    return this.coverText(area.rect, text, { ...style, fontSize });
  }

  /** Flatten the form into page content (FR-FRM-05). */
  flatten(): Command<void> {
    return checkpointCommand(label('cmd.flatten.form'), 'form', ({ doc }) => doc.flattenForm(), { kind: 'all' });
  }
}
