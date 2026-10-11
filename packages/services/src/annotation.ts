import { InvalidArgumentError, center, inflate, toPdfDate, translate, unionAll, type Command } from '@folio/core';
import type { Annotation, AnnotationType, AnnotId, Color, MarkupAnnotation, PageIndex, PdfDocument, Point, Quad, Rect } from '@folio/ports';
import { inverseCommand, label } from './commands.ts';

export const HIGHLIGHT_COLORS: Record<string, Color> = {
  yellow: { r: 255, g: 213, b: 74 },
  green: { r: 124, g: 222, b: 132 },
  blue: { r: 120, g: 190, b: 255 },
  pink: { r: 255, g: 143, b: 196 },
  orange: { r: 255, g: 170, b: 80 },
  purple: { r: 190, g: 150, b: 255 },
};
export const DEFAULT_MARKUP_COLORS: Record<MarkupAnnotation['type'], Color> = {
  highlight: HIGHLIGHT_COLORS.yellow!,
  underline: { r: 211, g: 47, b: 47 },
  strikeout: { r: 211, g: 47, b: 47 },
  squiggly: { r: 22, g: 128, b: 60 },
};

export interface AnnotationRef {
  page: PageIndex;
  id: AnnotId;
}
export interface ListedAnnotation {
  page: PageIndex;
  annotation: Annotation;
}
export interface AnnotationFilter {
  types?: AnnotationType[];
  authors?: string[];
  pages?: PageIndex[];
  text?: string;
}

const quadBounds = (quads: Quad[]): Rect =>
  unionAll(
    quads.map((q) => {
      const xs = [q.p1.x, q.p2.x, q.p3.x, q.p4.x];
      const ys = [q.p1.y, q.p2.y, q.p3.y, q.p4.y];
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }),
  );

/** Moves every geometric part of an annotation by (dx, dy). */
export function moveAnnotation<T extends Annotation>(a: T, dx: number, dy: number): T {
  const pt = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  const out = { ...a, rect: translate(a.rect, dx, dy) } as Annotation;
  if ('quads' in out) out.quads = out.quads.map((q) => ({ p1: pt(q.p1), p2: pt(q.p2), p3: pt(q.p3), p4: pt(q.p4) }));
  if (out.type === 'line') {
    out.start = pt(out.start);
    out.end = pt(out.end);
  }
  if ('vertices' in out) out.vertices = out.vertices.map(pt);
  if (out.type === 'ink') out.paths = out.paths.map((p) => p.map(pt));
  return out as T;
}

/** Scales an annotation from its current rect to `to` (aspect is the caller's business). */
export function resizeAnnotation<T extends Annotation>(a: T, to: Rect): T {
  const from = a.rect;
  const sx = from.width ? to.width / from.width : 1;
  const sy = from.height ? to.height / from.height : 1;
  const pt = (p: Point): Point => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy });
  const out = { ...a, rect: { ...to } } as Annotation;
  if ('quads' in out) out.quads = out.quads.map((q) => ({ p1: pt(q.p1), p2: pt(q.p2), p3: pt(q.p3), p4: pt(q.p4) }));
  if (out.type === 'line') {
    out.start = pt(out.start);
    out.end = pt(out.end);
  }
  if ('vertices' in out) out.vertices = out.vertices.map(pt);
  if (out.type === 'ink') out.paths = out.paths.map((p) => p.map(pt));
  return out as T;
}

/** Shift constrains: lines snap to 45° steps, boxes become squares/circles (FR-ANN-04). */
export function constrainLine(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = Math.hypot(dx, dy);
  return { x: start.x + Math.cos(angle) * len, y: start.y + Math.sin(angle) * len };
}
export function constrainBox(anchor: Point, corner: Point): Point {
  const side = Math.max(Math.abs(corner.x - anchor.x), Math.abs(corner.y - anchor.y));
  return { x: anchor.x + Math.sign(corner.x - anchor.x || 1) * side, y: anchor.y + Math.sign(corner.y - anchor.y || 1) * side };
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
/** New rectangles for aligning several objects to their common bounds. */
export function alignRects(rects: Rect[], mode: AlignMode): Rect[] {
  if (rects.length < 2) return rects.map((r) => ({ ...r }));
  const all = unionAll(rects);
  return rects.map((r) => {
    switch (mode) {
      case 'left':
        return { ...r, x: all.x };
      case 'right':
        return { ...r, x: all.x + all.width - r.width };
      case 'center':
        return { ...r, x: all.x + (all.width - r.width) / 2 };
      case 'bottom':
        return { ...r, y: all.y };
      case 'top':
        return { ...r, y: all.y + all.height - r.height };
      case 'middle':
        return { ...r, y: all.y + (all.height - r.height) / 2 };
    }
  });
}
/** Equal gaps between objects along an axis; the outermost two stay put. */
export function distributeRects(rects: Rect[], axis: 'horizontal' | 'vertical'): Rect[] {
  if (rects.length < 3) return rects.map((r) => ({ ...r }));
  const pos = axis === 'horizontal' ? 'x' : 'y';
  const len = axis === 'horizontal' ? 'width' : 'height';
  const order = rects.map((r, i) => ({ r, i })).sort((a, b) => a.r[pos] - b.r[pos]);
  const first = order[0]!.r;
  const last = order[order.length - 1]!.r;
  const free = last[pos] + last[len] - first[pos] - order.reduce((n, o) => n + o.r[len], 0);
  const gap = free / (order.length - 1);
  const out = rects.map((r) => ({ ...r }));
  let cursor = first[pos];
  for (const o of order) {
    out[o.i]![pos] = cursor;
    cursor += o.r[len] + gap;
  }
  return out;
}

export interface SnapResult {
  dx: number;
  dy: number;
  /** Guide lines to draw, in page coordinates. */
  guides: Array<{ axis: 'x' | 'y'; at: number }>;
}
/** Snaps a moving rect's edges and centre to other objects and the page (FR-ANN-06 snapping guides). */
export function snapRect(moving: Rect, others: Rect[], page: Rect, threshold = 4): SnapResult {
  const targetsX = [page.x, page.x + page.width / 2, page.x + page.width];
  const targetsY = [page.y, page.y + page.height / 2, page.y + page.height];
  for (const o of others) {
    targetsX.push(o.x, o.x + o.width / 2, o.x + o.width);
    targetsY.push(o.y, o.y + o.height / 2, o.y + o.height);
  }
  const best = (edges: number[], targets: number[]): { delta: number; at: number } | null => {
    let found: { delta: number; at: number } | null = null;
    for (const e of edges) {
      for (const t of targets) {
        const d = t - e;
        if (Math.abs(d) <= threshold && (!found || Math.abs(d) < Math.abs(found.delta))) found = { delta: d, at: t };
      }
    }
    return found;
  };
  const sx = best([moving.x, moving.x + moving.width / 2, moving.x + moving.width], targetsX);
  const sy = best([moving.y, moving.y + moving.height / 2, moving.y + moving.height], targetsY);
  const guides: SnapResult['guides'] = [];
  if (sx) guides.push({ axis: 'x', at: sx.at });
  if (sy) guides.push({ axis: 'y', at: sy.at });
  return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0, guides };
}

const CLIP_KIND = 'folio/annotations';
interface ClipPayload {
  kind: typeof CLIP_KIND;
  version: 1;
  items: Annotation[];
}

/** Annotation operations (FR-ANN-01…04, 06…09, 11). Mutations are commands with real inverses. */
export class AnnotationService {
  constructor(private readonly deps: { author: () => string; now: () => Date; newId: () => string }) {}

  private stamp<T extends Annotation>(a: T, isNew: boolean): T {
    const now = toPdfDate(this.deps.now());
    return { ...a, author: a.author ?? (this.deps.author() || undefined), modified: now, created: isNew ? (a.created ?? now) : a.created };
  }

  /** Text markup over selected text (FR-ANN-01). */
  markup(type: MarkupAnnotation['type'], quads: Quad[], opts: { color?: Color; opacity?: number; contents?: string } = {}): MarkupAnnotation {
    if (quads.length === 0) throw new InvalidArgumentError('Select some text first', { reason: 'noSelection' });
    return {
      type,
      quads,
      rect: inflate(quadBounds(quads), type === 'highlight' ? 0 : 1),
      color: opts.color ?? DEFAULT_MARKUP_COLORS[type],
      opacity: opts.opacity ?? (type === 'highlight' ? 0.5 : 1),
      contents: opts.contents,
    };
  }

  /** Creates an annotation. The id is fixed up front so redo recreates the same annotation. */
  add(page: PageIndex, annotation: Annotation): Command<AnnotationRef> {
    const a = this.stamp({ ...annotation, id: annotation.id ?? this.deps.newId() }, true);
    return inverseCommand(
      label(`cmd.addAnnotation.${a.type}`),
      'annotation',
      async ({ doc }) => ({ page, id: await doc.upsertAnnotation(page, a) }),
      ({ doc }) => doc.removeAnnotation(page, a.id!),
      { kind: 'annotations', pages: [page] },
    );
  }
  addMany(items: Array<{ page: PageIndex; annotation: Annotation }>, labelKey = 'cmd.addAnnotations'): Command<AnnotationRef[]> {
    const prepared = items.map((it) => ({ page: it.page, a: this.stamp({ ...it.annotation, id: it.annotation.id ?? this.deps.newId() }, true) }));
    const pages = [...new Set(prepared.map((p) => p.page))];
    return inverseCommand(
      label(labelKey, { count: prepared.length }),
      'annotation',
      async ({ doc }) => {
        const refs: AnnotationRef[] = [];
        for (const p of prepared) refs.push({ page: p.page, id: await doc.upsertAnnotation(p.page, p.a) });
        return refs;
      },
      async ({ doc }) => {
        for (const p of [...prepared].reverse()) await doc.removeAnnotation(p.page, p.a.id!);
      },
      { kind: 'annotations', pages },
    );
  }

  /**
   * Changes an existing annotation (move, resize, restyle, edit text). `before` is the current state
   * as listed by the engine. Consecutive updates of the same annotation coalesce (drags, typing).
   */
  update(page: PageIndex, before: Annotation, after: Annotation): Command<void> {
    if (!before.id) throw new InvalidArgumentError('Annotation has no id');
    if (before.locked && after.locked !== false) throw new InvalidArgumentError('The annotation is locked', { reason: 'locked' });
    const id = before.id;
    const next = this.stamp({ ...after, id }, false);
    const make = (from: Annotation, to: Annotation): Command<void> & { update: { page: PageIndex; id: AnnotId; from: Annotation; to: Annotation } } =>
      Object.assign(
        inverseCommand(
          label('cmd.editAnnotation'),
          'annotation',
          async ({ doc }) => void (await doc.upsertAnnotation(page, to)),
          async ({ doc }) => void (await doc.upsertAnnotation(page, from)),
          { kind: 'annotations', pages: [page] },
          (later) => {
            const u = (later as { update?: { page: PageIndex; id: AnnotId; to: Annotation } }).update;
            return u && u.page === page && u.id === id ? make(from, u.to) : null;
          },
        ),
        { update: { page, id, from, to } },
      );
    return make(before, next);
  }

  remove(items: ListedAnnotation[]): Command<void> {
    if (items.length === 0) throw new InvalidArgumentError('Nothing selected');
    if (items.some((i) => i.annotation.locked)) throw new InvalidArgumentError('A locked annotation cannot be deleted', { reason: 'locked' });
    if (items.some((i) => i.annotation.type === 'stamp' || i.annotation.type === 'other')) {
      // Stamps and foreign annotations keep their appearance only inside the file: undo needs a checkpoint.
      return {
        label: label('cmd.deleteAnnotations', { count: items.length }),
        kind: 'annotation',
        undo: 'checkpoint',
        async apply(ctx) {
          for (const it of items) await ctx.doc.removeAnnotation(it.page, it.annotation.id!);
          ctx.invalidate({ kind: 'annotations', pages: [...new Set(items.map((i) => i.page))] });
        },
      };
    }
    return inverseCommand(
      label('cmd.deleteAnnotations', { count: items.length }),
      'annotation',
      async ({ doc }) => {
        for (const it of items) await doc.removeAnnotation(it.page, it.annotation.id!);
      },
      async ({ doc }) => {
        for (const it of items) await doc.upsertAnnotation(it.page, it.annotation);
      },
      { kind: 'annotations', pages: [...new Set(items.map((i) => i.page))] },
    );
  }

  /** Z-order (FR-ANN-06): bring to front / send to back / one step. `order` is the page's current order. */
  reorder(page: PageIndex, order: AnnotId[], id: AnnotId, where: 'front' | 'back' | 'forward' | 'backward'): Command<void> | null {
    const at = order.indexOf(id);
    if (at < 0) throw new InvalidArgumentError('Unknown annotation');
    const next = order.filter((x) => x !== id);
    const to = where === 'front' ? next.length : where === 'back' ? 0 : where === 'forward' ? Math.min(next.length, at + 1) : Math.max(0, at - 1);
    next.splice(to, 0, id);
    if (next.join() === order.join()) return null;
    return inverseCommand(
      label('cmd.reorderAnnotation'),
      'annotation',
      ({ doc }) => doc.reorderAnnotations(page, next),
      ({ doc }) => doc.reorderAnnotations(page, order),
      { kind: 'annotations', pages: [page] },
    );
  }

  /** All annotations of the document for the sidebar list (FR-ANN-07, FR-ANN-11). */
  async list(doc: PdfDocument, filter: AnnotationFilter = {}): Promise<ListedAnnotation[]> {
    const out: ListedAnnotation[] = [];
    const pages = filter.pages ?? Array.from({ length: doc.pageCount }, (_, i) => i);
    const needle = filter.text?.toLowerCase();
    for (const page of pages) {
      for (const annotation of await doc.listAnnotations(page)) {
        if (annotation.type === 'link') continue; // links are navigation, not comments
        if (filter.types && !filter.types.includes(annotation.type)) continue;
        if (filter.authors && !filter.authors.includes(annotation.author ?? '')) continue;
        if (needle && !`${annotation.contents ?? ''} ${annotation.author ?? ''}`.toLowerCase().includes(needle)) continue;
        out.push({ page, annotation });
      }
    }
    return out;
  }
  authors(items: ListedAnnotation[]): string[] {
    return [...new Set(items.map((i) => i.annotation.author ?? ''))].sort();
  }

  /** Topmost annotation under a point (hit test for the select tool). */
  hitTest(annotations: Annotation[], p: Point, tolerance = 3): Annotation | undefined {
    for (const a of [...annotations].reverse()) {
      if (a.hidden) continue;
      const r = inflate(a.rect, tolerance);
      if (p.x < r.x || p.x > r.x + r.width || p.y < r.y || p.y > r.y + r.height) continue;
      if (a.type === 'line') {
        // Distance from the segment, so the empty corners of the line's box do not grab clicks.
        const { start, end } = a;
        const len2 = (end.x - start.x) ** 2 + (end.y - start.y) ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((p.x - start.x) * (end.x - start.x) + (p.y - start.y) * (end.y - start.y)) / len2));
        const d = Math.hypot(p.x - (start.x + t * (end.x - start.x)), p.y - (start.y + t * (end.y - start.y)));
        if (d > tolerance + a.strokeWidth) continue;
      }
      return a;
    }
    return undefined;
  }

  /** Clipboard text for copy/paste, also across tabs (FR-ANN-06). Binary stamp images are base64-free: stamps paste via their library entry. */
  serialize(items: Annotation[]): string {
    const clean = items.filter((a) => a.type !== 'other' && !(a.type === 'stamp' && a.appearance?.kind === 'image')).map(({ id: _id, ...rest }) => rest as Annotation);
    return JSON.stringify({ kind: CLIP_KIND, version: 1, items: clean } satisfies ClipPayload);
  }
  /** Parses clipboard text; returns [] when it is not Folio annotation data. Pasted copies are offset so they are visible. */
  deserialize(text: string, offset: Point = { x: 12, y: -12 }): Annotation[] {
    let payload: ClipPayload;
    try {
      payload = JSON.parse(text) as ClipPayload;
    } catch {
      return [];
    }
    if (payload?.kind !== CLIP_KIND || payload.version !== 1 || !Array.isArray(payload.items)) return [];
    return payload.items.filter((a) => a && typeof a.type === 'string' && a.rect && typeof a.rect.x === 'number').map((a) => moveAnnotation({ ...a, id: undefined, locked: false }, offset.x, offset.y));
  }

  /** Default geometry helpers for click-to-place tools. */
  noteAt(p: Point, contents = ''): Annotation {
    return { type: 'text', rect: { x: p.x, y: p.y - 20, width: 20, height: 20 }, color: HIGHLIGHT_COLORS.yellow, contents };
  }
  centerOf(a: Annotation): Point {
    return center(a.rect);
  }
}
