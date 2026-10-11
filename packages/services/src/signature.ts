import { InvalidArgumentError, clamp } from '@folio/core';
import type { Color, ImageCodec, PdfEngine, Point, RasterImage, Rect, Size, StampAppearance, StampPath } from '@folio/ports';

export type SignatureKind = 'signature' | 'initials';
export type SignatureSource = 'drawn' | 'typed' | 'image';
export const INK_COLORS: Record<string, Color> = { black: { r: 17, g: 17, b: 17 }, blue: { r: 29, g: 78, b: 216 } };

/** What the creation dialog hands to the library (SPEC §9 `signatures`). */
export interface SignatureDraft {
  kind: SignatureKind;
  source: SignatureSource;
  /** Vector form for drawn signatures. */
  svg?: string;
  /** Transparent raster used for previews and, for typed/image signatures, for placement. */
  raster: RasterImage;
  /** Natural size in points. */
  width: number;
  height: number;
}

export const HANDWRITING_FONTS = ['Caveat', 'DancingScript', 'Pacifico', 'Sacramento', 'GreatVibes', 'Kalam', 'Allura', 'Parisienne'] as const;
export type HandwritingFont = (typeof HANDWRITING_FONTS)[number];

// ---- drawn -----------------------------------------------------------------------------------

/** Ramer–Douglas–Peucker simplification. */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points.slice();
  let maxDist = 0;
  let index = 0;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const d = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x) / len;
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= tolerance) return [a, b];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}

/** Catmull-Rom spline through the points, as cubic Bézier segments. */
function toBezier(points: Point[]): StampPath['segments'] {
  const segs: StampPath['segments'] = [{ op: 'M', x: points[0]!.x, y: points[0]!.y }];
  if (points.length === 2) {
    segs.push({ op: 'L', x: points[1]!.x, y: points[1]!.y });
    return segs;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    segs.push({ op: 'C', x1: p1.x + (p2.x - p0.x) / 6, y1: p1.y + (p2.y - p0.y) / 6, x2: p2.x - (p3.x - p1.x) / 6, y2: p2.y - (p3.y - p1.y) / 6, x: p2.x, y: p2.y });
  }
  return segs;
}

export interface VectorSignature {
  width: number;
  height: number;
  paths: StampPath[];
}

/**
 * Smooth vector paths from raw pointer strokes (FR-STM-02). Input is in pad space (y down, any unit);
 * output is cropped to the ink and uses y up, ready for a vector stamp appearance.
 */
export function vectorFromStrokes(strokes: Point[][], opts: { color?: Color; strokeWidth?: number; tolerance?: number } = {}): VectorSignature {
  const usable = strokes.filter((s) => s.length >= 2);
  if (usable.length === 0) throw new InvalidArgumentError('Draw your signature first', { reason: 'emptySignature' });
  const strokeWidth = opts.strokeWidth ?? 2;
  const all = usable.flat();
  const minX = Math.min(...all.map((p) => p.x)) - strokeWidth;
  const minY = Math.min(...all.map((p) => p.y)) - strokeWidth;
  const width = Math.max(...all.map((p) => p.x)) + strokeWidth - minX;
  const height = Math.max(...all.map((p) => p.y)) + strokeWidth - minY;
  const paths = usable.map((stroke) => {
    const pts = simplify(stroke, opts.tolerance ?? 0.6).map((p) => ({ x: p.x - minX, y: height - (p.y - minY) }));
    return { segments: toBezier(pts), stroke: opts.color ?? INK_COLORS.black!, strokeWidth };
  });
  return { width, height, paths };
}

const n = (v: number): string => (Math.round(v * 100) / 100).toString();
/** SVG (y down) for storage and previews. */
export function vectorToSvg(v: VectorSignature): string {
  const paths = v.paths
    .map((p) => {
      const d = p.segments
        .map((s) => (s.op === 'Z' ? 'Z' : s.op === 'C' ? `C${n(s.x1)} ${n(v.height - s.y1)} ${n(s.x2)} ${n(v.height - s.y2)} ${n(s.x)} ${n(v.height - s.y)}` : `${s.op}${n(s.x)} ${n(v.height - s.y)}`))
        .join('');
      const c = p.stroke ?? { r: 0, g: 0, b: 0 };
      return `<path d="${d}" fill="none" stroke="rgb(${c.r},${c.g},${c.b})" stroke-width="${n(p.strokeWidth ?? 1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(v.width)} ${n(v.height)}" width="${n(v.width)}" height="${n(v.height)}">${paths}</svg>`;
}
/** Parses SVG produced by `vectorToSvg` back into paths. Returns null for anything else. */
export function svgToVector(svg: string): VectorSignature | null {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) return null;
  const width = Number(vb[1]);
  const height = Number(vb[2]);
  const paths: StampPath[] = [];
  for (const m of svg.matchAll(/<path d="([^"]+)"[^>]*stroke="rgb\((\d+),(\d+),(\d+)\)"[^>]*stroke-width="([\d.]+)"/g)) {
    const segments: StampPath['segments'] = [];
    for (const c of m[1]!.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
      const v = c[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (c[1] === 'Z') segments.push({ op: 'Z' });
      else if (c[1] === 'C' && v.length === 6) segments.push({ op: 'C', x1: v[0]!, y1: height - v[1]!, x2: v[2]!, y2: height - v[3]!, x: v[4]!, y: height - v[5]! });
      else if ((c[1] === 'M' || c[1] === 'L') && v.length === 2) segments.push({ op: c[1], x: v[0]!, y: height - v[1]! });
      else return null;
    }
    paths.push({ segments, stroke: { r: Number(m[2]), g: Number(m[3]), b: Number(m[4]) }, strokeWidth: Number(m[5]) });
  }
  return paths.length ? { width, height, paths } : null;
}

/** Simple scanline rasteriser for previews of vector signatures (round pens along flattened curves). */
export function rasterizeVector(v: VectorSignature, scale = 3): RasterImage {
  const width = Math.max(1, Math.ceil(v.width * scale));
  const height = Math.max(1, Math.ceil(v.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const dab = (cx: number, cy: number, r: number, c: Color): void => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
        const cover = clamp(r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy), 0, 1);
        const o = (y * width + x) * 4;
        if (cover * 255 > data[o + 3]!) {
          data[o] = c.r;
          data[o + 1] = c.g;
          data[o + 2] = c.b;
          data[o + 3] = cover * 255;
        }
      }
    }
  };
  for (const path of v.paths) {
    const c = path.stroke ?? path.fill ?? { r: 0, g: 0, b: 0 };
    const r = ((path.strokeWidth ?? 1) * scale) / 2;
    let cur: Point | null = null;
    const lineTo = (to: Point): void => {
      if (!cur) return;
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - cur.x, to.y - cur.y) * scale));
      for (let k = 0; k <= steps; k++) dab((cur.x + ((to.x - cur.x) * k) / steps) * scale, (v.height - (cur.y + ((to.y - cur.y) * k) / steps)) * scale, r, c);
      cur = to;
    };
    for (const s of path.segments) {
      if (s.op === 'M') cur = { x: s.x, y: s.y };
      else if (s.op === 'L') lineTo({ x: s.x, y: s.y });
      else if (s.op === 'C' && cur) {
        const p0: Point = cur;
        for (let k = 1; k <= 16; k++) {
          const t = k / 16;
          const u = 1 - t;
          lineTo({
            x: u ** 3 * p0.x + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t ** 3 * s.x,
            y: u ** 3 * p0.y + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t ** 3 * s.y,
          });
        }
      }
    }
  }
  return { width, height, data };
}

// ---- image -----------------------------------------------------------------------------------

/**
 * Makes paper transparent (FR-STM-02): pixels brighter than `threshold` (0–255) disappear, darker
 * ones keep their colour with alpha rising with darkness so pen edges stay smooth.
 */
export function removeBackground(img: RasterImage, threshold = 200): RasterImage {
  const data = new Uint8ClampedArray(img.data.length);
  const t = clamp(threshold, 1, 255);
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    const alpha = lum >= t ? 0 : Math.min(1, ((t - lum) / t) * 2.2) * (img.data[i + 3]! / 255);
    data[i] = img.data[i]!;
    data[i + 1] = img.data[i + 1]!;
    data[i + 2] = img.data[i + 2]!;
    data[i + 3] = alpha * 255;
  }
  return { width: img.width, height: img.height, data };
}
/** Bounding box of pixels with alpha above `minAlpha`, or null for an empty image. */
export function contentBounds(img: RasterImage, minAlpha = 16): { x: number; y: number; width: number; height: number } | null {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > minAlpha) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
export function cropRaster(img: RasterImage, r: { x: number; y: number; width: number; height: number }): RasterImage {
  const x = clamp(Math.round(r.x), 0, img.width - 1);
  const y = clamp(Math.round(r.y), 0, img.height - 1);
  const width = clamp(Math.round(r.width), 1, img.width - x);
  const height = clamp(Math.round(r.height), 1, img.height - y);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) data.set(img.data.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + width) * 4), row * width * 4);
  return { width, height, data };
}
export function cropToContent(img: RasterImage, pad = 2): RasterImage {
  const b = contentBounds(img);
  if (!b) throw new InvalidArgumentError('The image has no visible ink', { reason: 'emptySignature' });
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return cropRaster(img, { x, y, width: Math.min(img.width - x, b.width + 2 * pad), height: Math.min(img.height - y, b.height + 2 * pad) });
}

/** Default placed height of a signature in points; width follows the aspect ratio. */
export const SIGNATURE_HEIGHT = { signature: 48, initials: 32 } as const;
function naturalSize(pixels: Size, kind: SignatureKind): Size {
  const height = SIGNATURE_HEIGHT[kind];
  return { width: Math.min(260, (pixels.width / pixels.height) * height), height };
}

export class SignatureService {
  constructor(private readonly deps: { engine: PdfEngine; images: ImageCodec; font: (name: HandwritingFont) => Promise<Uint8Array> }) {}

  /** Draw tab. */
  fromStrokes(strokes: Point[][], kind: SignatureKind, color: Color = INK_COLORS.black!, strokeWidth = 2): SignatureDraft {
    const vector = vectorFromStrokes(strokes, { color, strokeWidth });
    const size = naturalSize(vector, kind);
    return { kind, source: 'drawn', svg: vectorToSvg(vector), raster: rasterizeVector(vector, 3), ...size };
  }
  /** Type tab: the name rendered in one of the bundled handwriting fonts. */
  async fromText(text: string, font: HandwritingFont, kind: SignatureKind, color: Color = INK_COLORS.blue!): Promise<SignatureDraft> {
    if (text.trim() === '') throw new InvalidArgumentError('Type your name first', { reason: 'emptySignature' });
    const raster = cropToContent(await this.deps.engine.rasterizeText({ text: text.trim(), font: await this.deps.font(font), fontSize: 144, color }), 4);
    return { kind, source: 'typed', raster, ...naturalSize(raster, kind) };
  }
  /** Image tab: decode, optional manual crop, background removal by threshold, trim to the ink. */
  async fromImage(bytes: Uint8Array, kind: SignatureKind, opts: { threshold?: number; crop?: { x: number; y: number; width: number; height: number } } = {}): Promise<SignatureDraft> {
    let decoded: RasterImage;
    try {
      decoded = await this.deps.images.decode(bytes);
    } catch (e) {
      throw new InvalidArgumentError('That file is not a PNG or JPEG image', { reason: 'badImage', detail: String(e) });
    }
    const cropped = opts.crop ? cropRaster(decoded, opts.crop) : decoded;
    const raster = cropToContent(removeBackground(cropped, opts.threshold ?? 200));
    return { kind, source: 'image', raster, ...naturalSize(raster, kind) };
  }

  /** Appearance to place on a page: vector when available, raster otherwise. */
  appearance(sig: { svg?: string | null; raster: RasterImage }): StampAppearance {
    const vector = sig.svg ? svgToVector(sig.svg) : null;
    return vector ? { kind: 'vector', ...vector } : { kind: 'image', image: sig.raster };
  }
}

/** Rect for dropping something of `size` centred on `at`, kept inside the page (ghost placement). */
export function placeAt(at: Point, size: Size, page: Size): Rect {
  const width = Math.min(size.width, page.width);
  const height = Math.min(size.height, page.height);
  return { x: clamp(at.x - width / 2, 0, page.width - width), y: clamp(at.y - height / 2, 0, page.height - height), width, height };
}
/** Resize keeping the aspect ratio (signatures and image stamps). `anchor` is the fixed corner. */
export function resizeLocked(rect: Rect, anchor: Point, corner: Point, minSize = 8): Rect {
  const aspect = rect.width / rect.height;
  let width = Math.max(minSize, Math.abs(corner.x - anchor.x));
  let height = width / aspect;
  if (height < Math.abs(corner.y - anchor.y)) {
    height = Math.max(minSize, Math.abs(corner.y - anchor.y));
    width = height * aspect;
  }
  return { x: corner.x >= anchor.x ? anchor.x : anchor.x - width, y: corner.y >= anchor.y ? anchor.y : anchor.y - height, width, height };
}
