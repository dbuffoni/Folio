import {
  InvalidArgumentError,
  InvalidPdfError,
  center,
  multiply,
  rectToRect,
  rotation,
  applyToPoint,
} from '@folio/core';
import type {
  Annotation,
  AnnotationBase,
  AnnotId,
  Color,
  LineEnding,
  LinkTarget,
  Matrix,
  PageIndex,
  Point,
  Quad,
  Rect,
  StampAnnotation,
  StandardFontFamily,
} from '@folio/ports';
import type { DocInternals } from './document.ts';
import { getAscii, getUtf16, scope, type Arena, type Pdfium, type Ptr } from './mem.ts';
import { bitmapFromRaster } from './objects.ts';

const SUBTYPE = {
  text: 1,
  link: 2,
  freetext: 3,
  line: 4,
  square: 5,
  circle: 6,
  polygon: 7,
  polyline: 8,
  highlight: 9,
  underline: 10,
  squiggly: 11,
  strikeout: 12,
  stamp: 13,
  ink: 15,
} as const;
const POPUP = 16;
const WIDGET = 20;
const SUBTYPE_NAME: Record<number, Annotation['type']> = Object.fromEntries(
  Object.entries(SUBTYPE).map(([k, v]) => [v, k as Annotation['type']]),
);
const FOREIGN_NAMES: Record<number, string> = {
  14: 'Caret',
  17: 'FileAttachment',
  18: 'Sound',
  19: 'Movie',
  21: 'Screen',
  22: 'PrinterMark',
  23: 'TrapNet',
  24: 'Watermark',
  25: '3D',
  26: 'RichMedia',
  27: 'XFAWidget',
  28: 'Redact',
};
const LINE_ENDINGS: LineEnding[] = [
  'none',
  'square',
  'circle',
  'diamond',
  'openArrow',
  'closedArrow',
  'butt',
  'openArrow',
  'closedArrow',
  'slash',
];
const ENDING_CODE: Record<LineEnding, number> = {
  none: 0,
  square: 1,
  circle: 2,
  diamond: 3,
  openArrow: 4,
  closedArrow: 5,
  butt: 6,
  slash: 9,
};
const BORDER_SOLID = 1;
const BORDER_DASHED = 2;
const FLAG_HIDDEN = 0x02;
const FLAG_PRINT = 0x04;
const FLAG_LOCKED = 0x80;
const COLOR = 0;
const INTERIOR = 1;
const STD_FONT: Record<StandardFontFamily, number> = { mono: 0, sans: 4, serif: 8 };
const FONT_FAMILY = (code: number): StandardFontFamily =>
  code <= 3 ? 'mono' : code <= 7 ? 'sans' : code <= 11 ? 'serif' : 'sans';

// ---- small helpers ---------------------------------------------------------------------------

const fsRect = (a: Arena, r: Rect): Ptr => a.floats([r.x, r.y + r.height, r.x + r.width, r.y]); // left, top, right, bottom
function readRect(m: Pdfium, a: Arena, annot: Ptr): Rect {
  const p = a.alloc(16);
  if (!m.FPDFAnnot_GetRect(annot, p)) return { x: 0, y: 0, width: 0, height: 0 };
  const [l, t, r, b] = [a.f32(p, 0), a.f32(p, 1), a.f32(p, 2), a.f32(p, 3)];
  return { x: Math.min(l, r), y: Math.min(b, t), width: Math.abs(r - l), height: Math.abs(t - b) };
}
const getStr = (m: Pdfium, annot: Ptr, key: string): string =>
  getUtf16(m, (buf, len) => m.FPDFAnnot_GetStringValue(annot, key, buf, len));
function setStr(m: Pdfium, a: Arena, annot: Ptr, key: string, value: string | undefined): void {
  if (value !== undefined) m.FPDFAnnot_SetStringValue(annot, key, a.utf16(value));
}
function readColor(m: Pdfium, a: Arena, annot: Ptr, type: number): Color | undefined {
  const p = a.alloc(12);
  return m.EPDFAnnot_GetColor(annot, type, p, p + 4, p + 8)
    ? { r: a.u32(p, 0), g: a.u32(p, 1), b: a.u32(p, 2) }
    : undefined;
}
function setColor(m: Pdfium, annot: Ptr, type: number, c: Color | undefined): void {
  if (c) m.EPDFAnnot_SetColor(annot, type, c.r, c.g, c.b);
  else m.EPDFAnnot_ClearColor(annot, type);
}
const alpha = (c: Color): number => Math.round((c.a ?? 1) * 255);

/** Public id of an annotation: its /NM when present, otherwise a positional fallback. */
function idOf(m: Pdfium, annot: Ptr, index: number): AnnotId {
  const nm = getStr(m, annot, 'NM');
  if (nm) return nm;
  const obj = m.EPDFAnnot_GetObjectNumber(annot);
  return obj > 0 ? `#obj${obj}` : `#idx${index}`;
}

/** Opens the annotation with the given id. Caller closes it. */
function find(d: DocInternals, page: Ptr, id: AnnotId): { annot: Ptr; index: number } | null {
  const m = d.m;
  const n = m.FPDFPage_GetAnnotCount(page);
  for (let k = 0; k < n; k++) {
    const annot = m.FPDFPage_GetAnnot(page, k);
    if (!annot) continue;
    if (idOf(m, annot, k) === id) return { annot, index: k };
    m.FPDFPage_CloseAnnot(annot);
  }
  return null;
}

// ---- read ------------------------------------------------------------------------------------

function linkTarget(d: DocInternals, annot: Ptr): LinkTarget {
  const m = d.m;
  const link = m.FPDFAnnot_GetLink(annot);
  if (!link) return { kind: 'unsupported', reason: 'unknown' };
  const dest = m.FPDFLink_GetDest(d.doc, link);
  if (dest) {
    const page = m.FPDFDest_GetDestPageIndex(d.doc, dest);
    return page >= 0 ? { kind: 'page', page } : { kind: 'unsupported', reason: 'unknown' };
  }
  const action = m.FPDFLink_GetAction(link);
  if (!action) return { kind: 'unsupported', reason: 'unknown' };
  switch (m.FPDFAction_GetType(action)) {
    case 1: {
      const dst = m.FPDFAction_GetDest(d.doc, action);
      const page = dst ? m.FPDFDest_GetDestPageIndex(d.doc, dst) : -1;
      return page >= 0 ? { kind: 'page', page } : { kind: 'unsupported', reason: 'unknown' };
    }
    case 2:
      return { kind: 'unsupported', reason: 'remote' };
    case 3: {
      const uri = getAscii(m, (buf, len) => m.FPDFAction_GetURIPath(d.doc, action, buf, len));
      return /^(https?:|mailto:)/i.test(uri)
        ? { kind: 'uri', uri }
        : { kind: 'unsupported', reason: /^javascript:/i.test(uri) ? 'javascript' : 'unknown' };
    }
    case 4:
      return { kind: 'unsupported', reason: 'launch' };
    default:
      return { kind: 'unsupported', reason: 'unknown' };
  }
}

function readPoints(m: Pdfium, a: Arena, count: number, fill: (buf: Ptr, n: number) => void): Point[] {
  if (count <= 0) return [];
  const buf = a.alloc(count * 8);
  fill(buf, count);
  return Array.from({ length: count }, (_, k) => ({ x: a.f32(buf, k * 2), y: a.f32(buf, k * 2 + 1) }));
}

function read(d: DocInternals, a: Arena, annot: Ptr, index: number): Annotation | null {
  const m = d.m;
  const subtype = m.FPDFAnnot_GetSubtype(annot);
  if (subtype === POPUP || subtype === WIDGET) return null;
  const flags = m.FPDFAnnot_GetFlags(annot);
  const opP = a.alloc(4);
  const base: AnnotationBase = {
    id: idOf(m, annot, index),
    rect: readRect(m, a, annot),
    color: readColor(m, a, annot, COLOR),
    opacity: m.EPDFAnnot_GetOpacity(annot, opP) ? a.u32(opP) / 255 : 1,
    author: getStr(m, annot, 'T') || undefined,
    contents: getStr(m, annot, 'Contents') || undefined,
    created: getStr(m, annot, 'CreationDate') || undefined,
    modified: getStr(m, annot, 'M') || undefined,
    locked: (flags & FLAG_LOCKED) !== 0,
    hidden: (flags & FLAG_HIDDEN) !== 0,
  };
  const widthP = a.alloc(4);
  const style = m.EPDFAnnot_GetBorderStyle(annot, widthP);
  const strokeWidth = a.f32(widthP) || 1;
  const strokeStyle = style === BORDER_DASHED ? 'dashed' : 'solid';
  const fillColor = readColor(m, a, annot, INTERIOR);
  const type = SUBTYPE_NAME[subtype];
  switch (type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const n = m.FPDFAnnot_CountAttachmentPoints(annot);
      const q = a.alloc(32);
      const quads: Quad[] = [];
      for (let k = 0; k < n; k++) {
        if (!m.FPDFAnnot_GetAttachmentPoints(annot, k, q)) continue;
        const f = (j: number): number => a.f32(q, j);
        quads.push({
          p1: { x: f(0), y: f(1) },
          p2: { x: f(2), y: f(3) },
          p3: { x: f(4), y: f(5) },
          p4: { x: f(6), y: f(7) },
        });
      }
      return { ...base, type, quads };
    }
    case 'text':
      return { ...base, type };
    case 'freetext': {
      const p = a.alloc(20);
      const ok = m.EPDFAnnot_GetDefaultAppearance(annot, p, p + 4, p + 8, p + 12, p + 16);
      const align = m.EPDFAnnot_GetTextAlignment(annot);
      return {
        ...base,
        type,
        color: undefined,
        fontFamily: ok ? FONT_FAMILY(a.i32(p, 0)) : 'sans',
        fontSize: ok ? a.f32(p, 1) : 12,
        textColor: ok ? { r: a.u32(p, 2), g: a.u32(p, 3), b: a.u32(p, 4) } : { r: 0, g: 0, b: 0 },
        align: align === 1 ? 'center' : align === 2 ? 'right' : 'left',
        backgroundColor: base.color,
        borderColor: style !== 0 && a.f32(widthP) > 0 ? fillColor : undefined,
        borderWidth: a.f32(widthP),
      };
    }
    case 'line': {
      const p = a.alloc(16);
      m.FPDFAnnot_GetLine(annot, p, p + 8);
      const e = a.alloc(8);
      const ok = m.EPDFAnnot_GetLineEndings(annot, e, e + 4);
      return {
        ...base,
        type,
        start: { x: a.f32(p, 0), y: a.f32(p, 1) },
        end: { x: a.f32(p, 2), y: a.f32(p, 3) },
        startEnding: ok ? (LINE_ENDINGS[a.i32(e, 0)] ?? 'none') : 'none',
        endEnding: ok ? (LINE_ENDINGS[a.i32(e, 1)] ?? 'none') : 'none',
        strokeWidth,
        strokeStyle,
        fillColor,
      };
    }
    case 'square':
    case 'circle':
      return { ...base, type, strokeWidth, strokeStyle, fillColor };
    case 'polyline':
    case 'polygon': {
      const n = m.FPDFAnnot_GetVertices(annot, 0, 0);
      const vertices = readPoints(m, a, n, (buf, c) => m.FPDFAnnot_GetVertices(annot, buf, c));
      return { ...base, type, vertices, strokeWidth, strokeStyle, fillColor };
    }
    case 'ink': {
      const paths: Point[][] = [];
      const n = m.FPDFAnnot_GetInkListCount(annot);
      for (let k = 0; k < n; k++) {
        const c = m.FPDFAnnot_GetInkListPath(annot, k, 0, 0);
        paths.push(readPoints(m, a, c, (buf, cnt) => m.FPDFAnnot_GetInkListPath(annot, k, buf, cnt)));
      }
      return { ...base, type, paths, strokeWidth };
    }
    case 'stamp':
      return { ...base, type, name: getStr(m, annot, 'Subj') || undefined };
    case 'link':
      return { ...base, type, target: linkTarget(d, annot) };
    default:
      return { ...base, type: 'other', subtype: FOREIGN_NAMES[subtype] ?? `Subtype${subtype}` };
  }
}

export function list(d: DocInternals, i: PageIndex): Annotation[] {
  d.checkPage(i);
  const m = d.m;
  const page = d.page(i);
  const out: Annotation[] = [];
  const n = m.FPDFPage_GetAnnotCount(page);
  for (let k = 0; k < n; k++) {
    const annot = m.FPDFPage_GetAnnot(page, k);
    if (!annot) continue;
    try {
      const a = scope(m, (arena) => read(d, arena, annot, k));
      if (a) out.push(a);
    } finally {
      m.FPDFPage_CloseAnnot(annot);
    }
  }
  return out;
}

// ---- stamp appearance ------------------------------------------------------------------------

function stampMatrix(box: { width: number; height: number }, rect: Rect, angle: number): Matrix {
  // Content box → annotation rect; the rotated content is scaled to stay inside the rect.
  const rad = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const k = Math.min(
    rect.width / (box.width * cos + box.height * sin || 1),
    rect.height / (box.width * sin + box.height * cos || 1),
  );
  const w = box.width * k;
  const h = box.height * k;
  const c = center(rect);
  const placed = rectToRect(
    { x: 0, y: 0, width: box.width, height: box.height },
    { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h },
  );
  return angle ? multiply(placed, rotation(angle, c)) : placed;
}

function clearObjects(m: Pdfium, annot: Ptr): void {
  for (let k = m.FPDFAnnot_GetObjectCount(annot) - 1; k >= 0; k--) m.FPDFAnnot_RemoveObject(annot, k);
}

function buildStamp(d: DocInternals, a: Arena, annot: Ptr, s: StampAnnotation): void {
  const m = d.m;
  const ap = s.appearance;
  if (!ap) return;
  clearObjects(m, annot);
  const angle = s.rotation ?? 0;
  const opacity = s.opacity ?? 1;
  const append = (obj: Ptr): void => {
    if (!m.FPDFAnnot_AppendObject(annot, obj)) {
      m.FPDFPageObj_Destroy(obj);
      throw new InvalidPdfError('Could not build stamp appearance');
    }
  };
  if (ap.kind === 'image') {
    const img = m.FPDFPageObj_NewImageObj(d.doc);
    let raster = ap.image;
    if (opacity < 1) {
      const data = new Uint8ClampedArray(raster.data);
      for (let k = 3; k < data.length; k += 4) data[k] = data[k]! * opacity;
      raster = { ...raster, data };
    }
    const bmp = bitmapFromRaster(m, raster);
    m.FPDFImageObj_SetBitmap(0, 0, img, bmp);
    m.FPDFBitmap_Destroy(bmp);
    // The unit image square is the content box.
    const box = { width: ap.image.width, height: ap.image.height };
    // Unit image square → content box → annotation rect.
    m.FPDFPageObj_SetMatrix(img, a.floats(multiply([box.width, 0, 0, box.height, 0, 0], stampMatrix(box, s.rect, angle))));
    append(img);
    return;
  }
  if (ap.kind === 'vector') {
    const mat = stampMatrix(ap, s.rect, angle);
    const scale = Math.hypot(mat[0], mat[1]);
    for (const path of ap.paths) {
      let obj = 0;
      for (const seg of path.segments) {
        if (seg.op === 'Z') {
          if (obj) m.FPDFPath_Close(obj);
          continue;
        }
        const p = applyToPoint(mat, seg);
        if (seg.op === 'M') {
          if (!obj) obj = m.FPDFPageObj_CreateNewPath(p.x, p.y);
          else m.FPDFPath_MoveTo(obj, p.x, p.y);
        } else if (!obj) {
          continue;
        } else if (seg.op === 'L') {
          m.FPDFPath_LineTo(obj, p.x, p.y);
        } else if (seg.op === 'C') {
          const c1 = applyToPoint(mat, { x: seg.x1, y: seg.y1 });
          const c2 = applyToPoint(mat, { x: seg.x2, y: seg.y2 });
          m.FPDFPath_BezierTo(obj, c1.x, c1.y, c2.x, c2.y, p.x, p.y);
        }
      }
      if (!obj) continue;
      if (path.stroke) {
        m.FPDFPageObj_SetStrokeColor(
          obj,
          path.stroke.r,
          path.stroke.g,
          path.stroke.b,
          Math.round(alpha(path.stroke) * opacity),
        );
        m.FPDFPageObj_SetStrokeWidth(obj, (path.strokeWidth ?? 1) * scale);
        m.FPDFPageObj_SetLineCap(obj, 1);
        m.FPDFPageObj_SetLineJoin(obj, 1);
      }
      if (path.fill)
        m.FPDFPageObj_SetFillColor(
          obj,
          path.fill.r,
          path.fill.g,
          path.fill.b,
          Math.round(alpha(path.fill) * opacity),
        );
      m.FPDFPath_SetDrawMode(obj, path.fill ? 1 : 0, !!path.stroke);
      append(obj);
    }
    return;
  }
  // Text stamp: optional rounded-looking frame plus centred text, laid out in a 0..W × 0..H box.
  const font = d.shared.fonts.load(d.doc, ap.fontFamily, ap.bold === false ? 'regular' : 'bold');
  const size = 100;
  const text = m.FPDFPageObj_CreateTextObj(d.doc, font, size);
  m.FPDFText_SetText(text, a.utf16(ap.text));
  const b = a.alloc(16);
  m.FPDFPageObj_GetBounds(text, b, b + 4, b + 8, b + 12);
  const tw = Math.max(1, a.f32(b, 2) - a.f32(b, 0));
  const padX = ap.border ? size * 0.45 : 0;
  const padY = ap.border ? size * 0.3 : 0;
  const line = size * 0.09;
  const box = { width: tw + 2 * padX, height: size * 0.74 + 2 * padY };
  const mat = stampMatrix(box, s.rect, angle);
  const col = ap.color;
  const al = Math.round(alpha(col) * opacity);
  m.FPDFPageObj_SetFillColor(text, col.r, col.g, col.b, al);
  m.FPDFPageObj_SetMatrix(text, a.floats(multiply([1, 0, 0, 1, padX - a.f32(b, 0), padY], mat)));
  if (ap.border) {
    const inset = line / 2;
    const corners = [
      { x: inset, y: inset },
      { x: box.width - inset, y: inset },
      { x: box.width - inset, y: box.height - inset },
      { x: inset, y: box.height - inset },
    ].map((p) => applyToPoint(mat, p));
    const frame = m.FPDFPageObj_CreateNewPath(corners[0]!.x, corners[0]!.y);
    for (const p of corners.slice(1)) m.FPDFPath_LineTo(frame, p.x, p.y);
    m.FPDFPath_Close(frame);
    m.FPDFPageObj_SetStrokeColor(frame, col.r, col.g, col.b, al);
    m.FPDFPageObj_SetStrokeWidth(frame, line * Math.hypot(mat[0], mat[1]));
    m.FPDFPageObj_SetLineJoin(frame, 1);
    m.FPDFPath_SetDrawMode(frame, 0, true);
    append(frame);
  }
  append(text);
}

// ---- write -----------------------------------------------------------------------------------

function writeCommon(d: DocInternals, a: Arena, annot: Ptr, an: Annotation, isNew: boolean): void {
  const m = d.m;
  m.FPDFAnnot_SetRect(annot, fsRect(a, an.rect));
  setStr(m, a, annot, 'Contents', an.contents ?? (isNew ? undefined : ''));
  setStr(m, a, annot, 'T', an.author);
  setStr(m, a, annot, 'M', an.modified);
  setStr(m, a, annot, 'CreationDate', an.created);
  let flags = (m.FPDFAnnot_GetFlags(annot) | FLAG_PRINT) & ~(FLAG_HIDDEN | FLAG_LOCKED);
  if (an.hidden) flags |= FLAG_HIDDEN;
  if (an.locked) flags |= FLAG_LOCKED;
  m.FPDFAnnot_SetFlags(annot, flags);
  if (an.type !== 'stamp' && an.type !== 'freetext') {
    if (an.color) setColor(m, annot, COLOR, an.color);
    m.EPDFAnnot_SetOpacity(annot, Math.round(Math.min(1, Math.max(0, an.opacity ?? 1)) * 255));
  }
}

function writeStroke(
  m: Pdfium,
  a: Arena,
  annot: Ptr,
  s: { strokeWidth: number; strokeStyle?: 'solid' | 'dashed'; fillColor?: Color },
): void {
  const dashed = s.strokeStyle === 'dashed';
  m.EPDFAnnot_SetBorderStyle(annot, dashed ? BORDER_DASHED : BORDER_SOLID, s.strokeWidth);
  if (dashed) m.EPDFAnnot_SetBorderDashPattern(annot, a.floats([s.strokeWidth * 3, s.strokeWidth * 2]), 2);
  if ('fillColor' in s) setColor(m, annot, INTERIOR, s.fillColor);
}

function writeSpecific(d: DocInternals, a: Arena, annot: Ptr, an: Annotation): void {
  const m = d.m;
  switch (an.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const have = m.FPDFAnnot_CountAttachmentPoints(annot);
      an.quads.forEach((q, k) => {
        const p = a.floats([q.p1.x, q.p1.y, q.p2.x, q.p2.y, q.p3.x, q.p3.y, q.p4.x, q.p4.y]);
        if (k < have) m.FPDFAnnot_SetAttachmentPoints(annot, k, p);
        else m.FPDFAnnot_AppendAttachmentPoints(annot, p);
      });
      break;
    }
    case 'text':
      break;
    case 'freetext': {
      m.EPDFAnnot_SetDefaultAppearance(
        annot,
        STD_FONT[an.fontFamily],
        an.fontSize,
        an.textColor.r,
        an.textColor.g,
        an.textColor.b,
      );
      m.EPDFAnnot_SetTextAlignment(annot, an.align === 'center' ? 1 : an.align === 'right' ? 2 : 0);
      setColor(m, annot, COLOR, an.backgroundColor);
      const width = an.borderColor ? (an.borderWidth ?? 1) : 0;
      m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, width);
      setColor(m, annot, INTERIOR, an.borderColor);
      m.EPDFAnnot_SetOpacity(annot, Math.round(Math.min(1, Math.max(0, an.opacity ?? 1)) * 255));
      break;
    }
    case 'line':
      m.EPDFAnnot_SetLine(annot, a.floats([an.start.x, an.start.y]), a.floats([an.end.x, an.end.y]));
      m.EPDFAnnot_SetLineEndings(annot, ENDING_CODE[an.startEnding], ENDING_CODE[an.endEnding]);
      writeStroke(m, a, annot, an);
      break;
    case 'square':
    case 'circle':
      writeStroke(m, a, annot, an);
      break;
    case 'polyline':
    case 'polygon':
      m.EPDFAnnot_SetVertices(annot, a.floats(an.vertices.flatMap((p) => [p.x, p.y])), an.vertices.length);
      writeStroke(m, a, annot, an);
      break;
    case 'ink':
      m.FPDFAnnot_RemoveInkList(annot);
      for (const path of an.paths)
        m.FPDFAnnot_AddInkStroke(annot, a.floats(path.flatMap((p) => [p.x, p.y])), path.length);
      m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, an.strokeWidth);
      break;
    case 'stamp':
      setStr(m, a, annot, 'Subj', an.name);
      buildStamp(d, a, annot, an);
      break;
    case 'link':
      if (an.target.kind === 'uri') m.FPDFAnnot_SetURI(annot, a.utf8(an.target.uri));
      break;
    case 'other':
      break;
  }
}

export function upsert(d: DocInternals, i: PageIndex, an: Annotation): AnnotId {
  d.checkPage(i);
  const m = d.m;
  const page = d.page(i);
  if (!(an.rect.width >= 0 && an.rect.height >= 0))
    throw new InvalidArgumentError('Invalid annotation rectangle');
  let existing = an.id ? find(d, page, an.id) : null;
  if (existing) {
    const subtype = m.FPDFAnnot_GetSubtype(existing.annot);
    const sameType = an.type === 'other' ? !(subtype in SUBTYPE_NAME) : SUBTYPE[an.type] === subtype;
    const fewerQuads = 'quads' in an && an.quads.length < m.FPDFAnnot_CountAttachmentPoints(existing.annot);
    if (!sameType) {
      m.FPDFPage_CloseAnnot(existing.annot);
      throw new InvalidArgumentError('The annotation type cannot be changed');
    }
    if (fewerQuads) {
      // Attachment points cannot be removed in place: recreate the annotation under the same id.
      m.FPDFPage_CloseAnnot(existing.annot);
      m.FPDFPage_RemoveAnnot(page, existing.index);
      existing = null;
    }
  }
  if (!existing && an.type === 'other')
    throw new InvalidArgumentError('Foreign annotations cannot be created');
  if (!existing && an.type === 'stamp' && !an.appearance)
    throw new InvalidArgumentError('A new stamp needs an appearance');

  const annot = existing?.annot ?? m.FPDFPage_CreateAnnot(page, SUBTYPE[an.type as keyof typeof SUBTYPE]);
  if (!annot) throw new InvalidPdfError('Could not create annotation');
  try {
    return scope(m, (a) => {
      let id = existing ? idOf(m, annot, existing.index) : (an.id ?? d.shared.nextAnnotId());
      if (id.startsWith('#')) id = d.shared.nextAnnotId(); // promote a positional id to a real /NM
      setStr(m, a, annot, 'NM', id);
      writeCommon(d, a, annot, an, !existing);
      writeSpecific(d, a, annot, an);
      // Stamps carry their own objects; foreign and link annotations keep the appearance they came with.
      if (an.type !== 'stamp' && an.type !== 'other' && an.type !== 'link') {
        if (!m.EPDFAnnot_GenerateAppearance(annot))
          throw new InvalidPdfError(`Could not generate ${an.type} appearance`);
      }
      return id;
    });
  } finally {
    m.FPDFPage_CloseAnnot(annot);
  }
}

export function remove(d: DocInternals, i: PageIndex, id: AnnotId): void {
  d.checkPage(i);
  const page = d.page(i);
  const found = find(d, page, id);
  if (!found) throw new InvalidArgumentError(`No annotation ${id} on page ${i + 1}`);
  d.m.FPDFPage_CloseAnnot(found.annot);
  if (!d.m.FPDFPage_RemoveAnnot(page, found.index)) throw new InvalidPdfError('Could not remove annotation');
}

/** Puts the listed annotations in the given back-to-front order (others keep their place). */
export function reorder(d: DocInternals, i: PageIndex, ids: AnnotId[]): void {
  d.checkPage(i);
  const m = d.m;
  const page = d.page(i);
  const slots: number[] = [];
  for (const id of ids) {
    const found = find(d, page, id);
    if (!found) throw new InvalidArgumentError(`No annotation ${id} on page ${i + 1}`);
    m.FPDFPage_CloseAnnot(found.annot);
    slots.push(found.index);
  }
  const targets = [...slots].sort((x, y) => x - y);
  // Move one at a time into the sorted slots; ids are re-resolved because indexes shift.
  ids.forEach((id, k) => {
    const found = find(d, page, id)!;
    m.FPDFPage_CloseAnnot(found.annot);
    if (found.index !== targets[k])
      scope(m, (a) => m.EPDFPage_MoveAnnots(page, a.ints([found.index]), 1, targets[k]!));
  });
}

export function flatten(d: DocInternals, pages: PageIndex[]): void {
  const m = d.m;
  for (const i of pages) {
    d.checkPage(i);
    const page = d.page(i);
    let changed = false;
    for (let k = m.FPDFPage_GetAnnotCount(page) - 1; k >= 0; k--) {
      const annot = m.FPDFPage_GetAnnot(page, k);
      if (!annot) continue;
      const subtype = m.FPDFAnnot_GetSubtype(annot);
      const skip =
        subtype === WIDGET ||
        subtype === SUBTYPE.link ||
        subtype === POPUP ||
        (m.FPDFAnnot_GetFlags(annot) & FLAG_HIDDEN) !== 0;
      const done = !skip && m.EPDFAnnot_Flatten(page, annot);
      m.FPDFPage_CloseAnnot(annot);
      changed ||= done;
    }
    // Popups of flattened notes have nothing left to point at.
    for (let k = m.FPDFPage_GetAnnotCount(page) - 1; changed && k >= 0; k--) {
      const annot = m.FPDFPage_GetAnnot(page, k);
      const isPopup = annot && m.FPDFAnnot_GetSubtype(annot) === POPUP;
      if (annot) m.FPDFPage_CloseAnnot(annot);
      if (isPopup) m.FPDFPage_RemoveAnnot(page, k);
    }
    if (changed) d.commitPage(i);
  }
}
