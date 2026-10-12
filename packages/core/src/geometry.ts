import type { Matrix, Point, Quad, Rect, Rotation, Size } from '@folio/ports';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}
/** Rectangle from two arbitrary corners; width/height are never negative. */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
export function rectFromLTRB(left: number, top: number, right: number, bottom: number): Rect {
  return rectFromPoints({ x: left, y: bottom }, { x: right, y: top });
}
export const right = (r: Rect): number => r.x + r.width;
export const top = (r: Rect): number => r.y + r.height;
export const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
export const area = (r: Rect): number => r.width * r.height;
export const isEmptyRect = (r: Rect): boolean => r.width <= 0 || r.height <= 0;

export function containsPoint(r: Rect, p: Point, tolerance = 0): boolean {
  return p.x >= r.x - tolerance && p.x <= right(r) + tolerance && p.y >= r.y - tolerance && p.y <= top(r) + tolerance;
}
export function containsRect(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    right(inner) <= right(outer) + tolerance &&
    top(inner) <= top(outer) + tolerance
  );
}
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(right(a), right(b));
  const t = Math.min(top(a), top(b));
  return r > x && t > y ? { x, y, width: r - x, height: t - y } : null;
}
export const intersects = (a: Rect, b: Rect): boolean => intersect(a, b) !== null;
export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(top(a), top(b)) - y };
}
export function unionAll(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return rects.reduce(union);
}
export function inflate(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: Math.max(0, r.width + 2 * dx), height: Math.max(0, r.height + 2 * dy) };
}
export function translate(r: Rect, dx: number, dy: number): Rect {
  return { ...r, x: r.x + dx, y: r.y + dy };
}
/** Keeps `r` inside `bounds`, shrinking it if it is larger. */
export function clampRect(r: Rect, bounds: Rect): Rect {
  const width = Math.min(r.width, bounds.width);
  const height = Math.min(r.height, bounds.height);
  const x = Math.min(Math.max(r.x, bounds.x), right(bounds) - width);
  const y = Math.min(Math.max(r.y, bounds.y), top(bounds) - height);
  return { x, y, width, height };
}
export function rectsAlmostEqual(a: Rect, b: Rect, eps = 0.01): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.width - b.width) <= eps && Math.abs(a.height - b.height) <= eps;
}
export function quadFromRect(r: Rect): Quad {
  return {
    p1: { x: r.x, y: top(r) },
    p2: { x: right(r), y: top(r) },
    p3: { x: r.x, y: r.y },
    p4: { x: right(r), y: r.y },
  };
}
export function quadBounds(q: Quad): Rect {
  const xs = [q.p1.x, q.p2.x, q.p3.x, q.p4.x];
  const ys = [q.p1.y, q.p2.y, q.p3.y, q.p4.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

// ---- matrices ------------------------------------------------------------------------------

/** Result of applying `m1` first, then `m2`. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}
export function applyToPoint(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}
/** Bounding box of the transformed rectangle. */
export function applyToRect(m: Matrix, r: Rect): Rect {
  const pts = [
    applyToPoint(m, { x: r.x, y: r.y }),
    applyToPoint(m, { x: right(r), y: r.y }),
    applyToPoint(m, { x: r.x, y: top(r) }),
    applyToPoint(m, { x: right(r), y: top(r) }),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new RangeError('Matrix is not invertible');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
export const translation = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy];
export const scaling = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0];
/** Counter-clockwise rotation by `deg` around `about` (default origin). */
export function rotation(deg: number, about: Point = { x: 0, y: 0 }): Matrix {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return multiply(multiply(translation(-about.x, -about.y), [cos, sin, -sin, cos, 0, 0]), translation(about.x, about.y));
}
/** Matrix mapping rectangle `from` onto rectangle `to`. */
export function rectToRect(from: Rect, to: Rect): Matrix {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return [sx, 0, 0, sy, to.x - from.x * sx, to.y - from.y * sy];
}

// ---- page ↔ view ---------------------------------------------------------------------------

export function normalizeRotation(deg: number): Rotation {
  return ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;
}
/** Size of a page as displayed (after rotation), in points. */
export function rotatedSize(size: Size, rot: Rotation): Size {
  return rot === 90 || rot === 270 ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}
/**
 * Matrix from PDF user space (origin bottom-left, y up, unrotated) to view space
 * (origin top-left, y down, page rotated clockwise by `rot`, scaled by `scale` px/pt).
 */
export function pageToViewMatrix(size: Size, rot: Rotation, scale: number): Matrix {
  const { width: w, height: h } = size;
  let m: Matrix;
  switch (rot) {
    case 0:
      m = [1, 0, 0, -1, 0, h];
      break;
    case 90:
      m = [0, 1, 1, 0, 0, 0];
      break;
    case 180:
      m = [-1, 0, 0, 1, w, 0];
      break;
    case 270:
      m = [0, -1, -1, 0, h, w];
      break;
  }
  return multiply(m, scaling(scale));
}
export function viewToPageMatrix(size: Size, rot: Rotation, scale: number): Matrix {
  return invert(pageToViewMatrix(size, rot, scale));
}

// ---- layout helpers ------------------------------------------------------------------------

export type FitMode = 'contain' | 'cover' | 'original';
/** Places a box of `content` size inside `frame` (aspect preserved), centred. */
export function fitRect(content: Size, frame: Rect, mode: FitMode): Rect {
  let scale = 1;
  if (mode !== 'original') {
    const sx = frame.width / content.width;
    const sy = frame.height / content.height;
    scale = mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  }
  const width = content.width * scale;
  const height = content.height * scale;
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
}

export const MM_PER_PT = 25.4 / 72;
export const ptToMm = (pt: number): number => pt * MM_PER_PT;
export const mmToPt = (mm: number): number => mm / MM_PER_PT;
export const ptToIn = (pt: number): number => pt / 72;
export const inToPt = (inch: number): number => inch * 72;

export const PAGE_SIZES = {
  A3: { width: 841.89, height: 1190.55 },
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
} as const satisfies Record<string, Size>;
export type PageSizeName = keyof typeof PAGE_SIZES;

/** Human name of a page size ("A4", "Letter") or "210 × 297 mm" style text parts. */
export function describePageSize(size: Size): { name?: PageSizeName; landscape: boolean } {
  const landscape = size.width > size.height;
  const w = Math.min(size.width, size.height);
  const h = Math.max(size.width, size.height);
  for (const [name, s] of Object.entries(PAGE_SIZES)) {
    if (Math.abs(s.width - w) < 1.5 && Math.abs(s.height - h) < 1.5) return { name: name as PageSizeName, landscape };
  }
  return { landscape };
}

/**
 * Box for a typed text annotation: wide enough for the longest paragraph (up to 400 pt), tall enough for
 * every wrapped line, keeps the top edge of the box the user drew and stays inside `page`.
 * Character widths are over-estimated on purpose: clipped text is lost, spare room is not.
 */
export function fitTextBox(text: string, fontSize: number, anchor: Rect, page: Rect): Rect {
  const charWidth = fontSize * 0.6;
  const pad = 12;
  const minWidth = Math.min(page.width, fontSize * 6 + pad);
  const paragraphs = text.split('\n');
  const longest = Math.max(...paragraphs.map((l) => l.length), 1);
  const wanted = Math.max(anchor.width, Math.min(400, longest * charWidth + pad));
  const width = Math.max(minWidth, Math.min(wanted, page.width));
  const perLine = Math.max(1, Math.floor((width - pad) / charWidth));
  const lines = paragraphs.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const height = Math.min(page.height, Math.max(anchor.height, lines * fontSize * 1.3 + 6));
  const top = anchor.y + anchor.height;
  return clampRect({ x: anchor.x, y: top - height, width, height }, page);
}
