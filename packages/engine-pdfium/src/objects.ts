import {
  InvalidArgumentError,
  InvalidPdfError,
  UnsupportedFeatureError,
  multiply,
  rotation,
  center,
} from '@folio/core';
import type {
  Color,
  ImageSpec,
  Matrix,
  ObjId,
  OcrLayerWord,
  PageIndex,
  PageObject,
  PageObjectType,
  RasterImage,
  Rect,
  RectSpec,
  TextEditResult,
  TextSpec,
  TextStyle,
} from '@folio/ports';
import type { DocInternals } from './document.ts';
import { nearestFamily, variantOf } from './fonts.ts';
import { getAscii, getUtf16, scope, type Arena, type Pdfium, type Ptr } from './mem.ts';

const TYPES: Record<number, PageObjectType> = { 1: 'text', 2: 'path', 3: 'image', 4: 'shading', 5: 'form' };
const FPDFBitmap_BGRA = 4;

export const objId = (index: number): ObjId => `o${index}`;
export function objIndex(id: ObjId): number {
  const m = /^o(\d+)$/.exec(id);
  if (!m) throw new InvalidArgumentError(`Invalid object id "${id}"`);
  return Number(m[1]);
}

function getObject(
  d: DocInternals,
  i: PageIndex,
  id: ObjId,
  type?: number,
): { page: Ptr; obj: Ptr; index: number } {
  const page = d.page(i);
  const index = objIndex(id);
  if (index >= d.m.FPDFPage_CountObjects(page))
    throw new InvalidArgumentError(`No object ${id} on page ${i + 1}`);
  const obj = d.m.FPDFPage_GetObject(page, index);
  if (!obj) throw new InvalidArgumentError(`No object ${id} on page ${i + 1}`);
  if (type !== undefined && d.m.FPDFPageObj_GetType(obj) !== type) {
    throw new InvalidArgumentError(`Object ${id} is not a ${TYPES[type]} object`);
  }
  return { page, obj, index };
}

function bounds(m: Pdfium, a: Arena, obj: Ptr): Rect {
  const p = a.alloc(16);
  if (!m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12)) return { x: 0, y: 0, width: 0, height: 0 };
  const [l, b, r, t] = [a.f32(p, 0), a.f32(p, 1), a.f32(p, 2), a.f32(p, 3)];
  return { x: l, y: b, width: r - l, height: t - b };
}
function matrixOf(m: Pdfium, a: Arena, obj: Ptr): Matrix {
  const p = a.alloc(24);
  if (!m.FPDFPageObj_GetMatrix(obj, p)) return [1, 0, 0, 1, 0, 0];
  return [a.f32(p, 0), a.f32(p, 1), a.f32(p, 2), a.f32(p, 3), a.f32(p, 4), a.f32(p, 5)];
}
function setMatrix(m: Pdfium, a: Arena, obj: Ptr, mat: Matrix): void {
  m.FPDFPageObj_SetMatrix(obj, a.floats(mat));
}
function colorOf(m: Pdfium, a: Arena, obj: Ptr, stroke: boolean): Color | undefined {
  const p = a.alloc(16);
  const ok = stroke
    ? m.FPDFPageObj_GetStrokeColor(obj, p, p + 4, p + 8, p + 12)
    : m.FPDFPageObj_GetFillColor(obj, p, p + 4, p + 8, p + 12);
  return ok ? { r: a.u32(p, 0), g: a.u32(p, 1), b: a.u32(p, 2), a: a.u32(p, 3) / 255 } : undefined;
}
const alpha = (c: Color): number => Math.round((c.a ?? 1) * 255);

function objectText(m: Pdfium, obj: Ptr, textPage: Ptr): string {
  return getUtf16(m, (buf, len) => m.FPDFTextObj_GetText(obj, textPage, buf, len));
}

/** Storage facts about an image object: bits per pixel, stored size and filter chain. */
function imageInfo(m: Pdfium, a: Arena, obj: Ptr, page: Ptr): NonNullable<PageObject['imageInfo']> {
  // FPDF_IMAGEOBJ_METADATA: width, height, h_dpi, v_dpi, bits_per_pixel, colorspace, marked_content_id.
  const meta = a.alloc(28);
  const bitsPerPixel = m.FPDFImageObj_GetImageMetadata(obj, page, meta) ? a.u32(meta, 4) : 0;
  const byteSize = Math.max(0, m.FPDFImageObj_GetImageDataRaw(obj, 0, 0));
  const filters: string[] = [];
  const n = Math.max(0, m.FPDFImageObj_GetImageFilterCount(obj));
  for (let k = 0; k < n; k++) filters.push(getAscii(m, (buf, len) => m.FPDFImageObj_GetImageFilter(obj, k, buf, len)));
  return { bitsPerPixel, byteSize, filters };
}

export function list(d: DocInternals, i: PageIndex): PageObject[] {
  d.checkPage(i);
  const m = d.m;
  const page = d.page(i);
  const tp = m.FPDFText_LoadPage(page);
  try {
    return scope(m, (a) => {
      const out: PageObject[] = [];
      const n = m.FPDFPage_CountObjects(page);
      for (let k = 0; k < n; k++) {
        const obj = m.FPDFPage_GetObject(page, k);
        const typeNum = m.FPDFPageObj_GetType(obj);
        const o: PageObject = {
          id: objId(k),
          type: TYPES[typeNum] ?? 'path',
          bounds: bounds(m, a, obj),
          matrix: matrixOf(m, a, obj),
          fillColor: colorOf(m, a, obj, false),
          strokeColor: colorOf(m, a, obj, true),
        };
        if (typeNum === 1 && tp) o.text = objectText(m, obj, tp);
        if (typeNum === 3) {
          const p = a.alloc(8);
          if (m.FPDFImageObj_GetImagePixelSize(obj, p, p + 4))
            o.imageSize = { width: a.u32(p, 0), height: a.u32(p, 1) };
          o.imageInfo = imageInfo(m, a, obj, page);
        }
        out.push(o);
      }
      return out;
    });
  } finally {
    if (tp) m.FPDFText_ClosePage(tp);
  }
}

// ---- text ------------------------------------------------------------------------------------

function rawFontName(m: Pdfium, font: Ptr): string {
  return getAscii(m, (buf, len) => m.FPDFFont_GetBaseFontName(font, buf, len));
}

/**
 * Characters already drawn with the given (subset) font. A subset font program contains exactly the
 * glyphs the document uses, so this set is the font's safe repertoire (SPEC §8.7 step 4).
 */
function usedChars(d: DocInternals, fontName: string, around: PageIndex): Set<string> {
  const m = d.m;
  const used = new Set<string>();
  const pages = [around];
  for (let k = 1; pages.length < Math.min(d.pageCount, 40); k++) {
    if (around - k >= 0) pages.push(around - k);
    if (around + k < d.pageCount) pages.push(around + k);
    if (around - k < 0 && around + k >= d.pageCount) break;
  }
  for (const p of pages) {
    const page = d.page(p);
    const tp = m.FPDFText_LoadPage(page);
    if (!tp) continue;
    const n = m.FPDFPage_CountObjects(page);
    for (let k = 0; k < n; k++) {
      const obj = m.FPDFPage_GetObject(page, k);
      if (m.FPDFPageObj_GetType(obj) !== 1) continue;
      const font = m.FPDFTextObj_GetFont(obj);
      if (!font || rawFontName(m, font) !== fontName) continue;
      for (const ch of objectText(m, obj, tp)) used.add(ch);
    }
    m.FPDFText_ClosePage(tp);
  }
  return used;
}

function setText(m: Pdfium, a: Arena, obj: Ptr, text: string): void {
  if (!m.FPDFText_SetText(obj, a.utf16(text))) throw new InvalidPdfError('Could not set text');
}
function readBack(d: DocInternals, i: PageIndex, obj: Ptr): string {
  const tp = d.m.FPDFText_LoadPage(d.page(i));
  if (!tp) return '';
  try {
    return objectText(d.m, obj, tp);
  } finally {
    d.m.FPDFText_ClosePage(tp);
  }
}
const visible = (s: string): string => s.replace(/\s+/g, '');

export function replaceText(
  d: DocInternals,
  i: PageIndex,
  id: ObjId,
  text: string,
  style?: TextStyle,
): TextEditResult {
  const m = d.m;
  const { page, obj, index } = getObject(d, i, id, 1);
  return scope(m, (a) => {
    const mat = matrixOf(m, a, obj);
    if (Math.abs(Math.atan2(mat[1], mat[0])) > 0.01) throw new UnsupportedFeatureError('rotatedText');
    const font = m.FPDFTextObj_GetFont(obj);
    const raw = font ? rawFontName(m, font) : '';
    const isSubset = /^[A-Z]{6}\+/.test(raw);
    const cleanName = isSubset ? raw.slice(7) : raw;
    const tp0 = m.FPDFText_LoadPage(page);
    const oldText = tp0 ? objectText(m, obj, tp0) : '';
    if (tp0) m.FPDFText_ClosePage(tp0);

    const wantsOtherFont =
      style?.fontFamily !== undefined || style?.bold !== undefined || style?.italic !== undefined;
    let reuse = !!font && !wantsOtherFont;
    // Embedded programs may be subsets even without the conventional tag, so the same rule covers them all.
    if (reuse && (isSubset || m.FPDFFont_GetIsEmbedded(font) === 1)) {
      const have = usedChars(d, raw, i);
      reuse = [...text].every((ch) => /\s/.test(ch) || have.has(ch));
    }

    const warnings: TextEditResult['warnings'] = [];
    let target = obj;
    let fontResult: TextEditResult['font'] = { kind: 'reused', fontName: cleanName };

    if (reuse) {
      setText(m, a, obj, text);
      d.commitPage(i);
      // Fonts with a custom encoding can silently drop characters: verify, and fall back if so.
      if (visible(readBack(d, i, obj)) !== visible(text)) {
        setText(m, a, obj, oldText);
        reuse = false;
      }
    }
    if (!reuse) {
      const sizeP = a.alloc(4);
      const size = style?.fontSize ?? (m.FPDFTextObj_GetFontSize(obj, sizeP) ? a.f32(sizeP) : 12);
      const flags = font ? m.FPDFFont_GetFlags(font) : 0;
      const family =
        style?.fontFamily ?? nearestFamily({ name: cleanName, family: '', flags: flags < 0 ? 0 : flags });
      const bold =
        style?.bold ??
        (/bold|black|heavy/i.test(cleanName) || (font ? m.FPDFFont_GetWeight(font) >= 600 : false));
      const italic = style?.italic ?? /italic|oblique/i.test(cleanName);
      const variant = variantOf(bold, italic);
      const newFont = d.shared.fonts.load(d.doc, family, variant);
      const created = m.FPDFPageObj_CreateTextObj(d.doc, newFont, size);
      if (!created) throw new InvalidPdfError('Could not create text object');
      setText(m, a, created, text);
      // When an explicit size is requested the matrix keeps position/orientation; scale stays as it was.
      setMatrix(m, a, created, mat);
      const fill = colorOf(m, a, obj, false) ?? { r: 0, g: 0, b: 0, a: 1 };
      m.FPDFPageObj_SetFillColor(created, fill.r, fill.g, fill.b, alpha(fill));
      m.FPDFTextObj_SetTextRenderMode(created, Math.max(0, m.FPDFTextObj_GetTextRenderMode(obj)));
      if (!m.FPDFPage_InsertObjectAtIndex(page, created, index)) {
        m.FPDFPageObj_Destroy(created);
        throw new InvalidPdfError('Could not insert text object');
      }
      // The original glyph object is removed from the content stream, not hidden (FR-EDT-02).
      if (!m.FPDFPage_RemoveObject(page, obj))
        throw new InvalidPdfError('Could not remove the original text');
      m.FPDFPageObj_Destroy(obj);
      target = created;
      fontResult = { kind: 'substituted', from: cleanName, to: d.shared.fonts.displayName(family, variant) };
      d.commitPage(i);
      // Text extraction maps a missing glyph back to its character, so the font itself is asked as well.
      if (visible(readBack(d, i, target)) !== visible(text) || !d.shared.fonts.covers(family, variant, text))
        warnings.push('missingGlyph');
    }

    if (style?.color)
      m.FPDFPageObj_SetFillColor(target, style.color.r, style.color.g, style.color.b, alpha(style.color));
    if (reuse && style?.fontSize) {
      // Reused fonts keep their object; a size change is applied by scaling the text matrix.
      const sizeP = a.alloc(4);
      const cur = m.FPDFTextObj_GetFontSize(target, sizeP) ? a.f32(sizeP) : style.fontSize;
      const k = style.fontSize / (cur * (Math.hypot(mat[2], mat[3]) || 1));
      setMatrix(m, a, target, [mat[0] * k, mat[1] * k, mat[2] * k, mat[3] * k, mat[4], mat[5]]);
    }
    if (style?.color || (reuse && style?.fontSize)) d.commitPage(i);
    const map = d.objectIndexMap(i);
    return {
      objId: objId(map.get(target) ?? index),
      font: fontResult,
      width: bounds(m, a, target).width,
      warnings,
    };
  });
}

export function addText(d: DocInternals, i: PageIndex, spec: TextSpec): ObjId {
  const m = d.m;
  const page = d.page(i);
  if (spec.text === '') throw new InvalidArgumentError('Text is empty');
  return scope(m, (a) => {
    const font = d.shared.fonts.load(d.doc, spec.fontFamily ?? 'sans', variantOf(spec.bold, spec.italic));
    const obj = m.FPDFPageObj_CreateTextObj(d.doc, font, spec.fontSize ?? 12);
    if (!obj) throw new InvalidPdfError('Could not create text object');
    setText(m, a, obj, spec.text);
    const c = spec.color ?? { r: 0, g: 0, b: 0 };
    m.FPDFPageObj_SetFillColor(obj, c.r, c.g, c.b, alpha(c));
    setMatrix(m, a, obj, multiply(rotation(spec.angle ?? 0), [1, 0, 0, 1, spec.origin.x, spec.origin.y]));
    m.FPDFPage_InsertObject(page, obj);
    d.commitPage(i);
    return objId(m.FPDFPage_CountObjects(page) - 1);
  });
}

// ---- OCR layer (FR-OCR-01, FR-OCR-09) ---------------------------------------------------------

/** Name of the marked-content tag that identifies the layer Folio wrote. */
export const OCR_MARK = 'Folio:OCR';
/** FPDFPageObjMark_GetName fills a UTF-16 buffer and reports the length through an out parameter. */
function scopeLen(m: Pdfium, mark: Ptr, buf: Ptr, len: number): number {
  return scope(m, (a) => {
    const out = a.alloc(4);
    const ok = m.FPDFPageObjMark_GetName(mark, buf, len, out);
    return ok ? a.u32(out) : 0;
  });
}
function markName(m: Pdfium, mark: Ptr): string {
  return getUtf16(m, (buf, len) => scopeLen(m, mark, buf, len));
}
function isOcr(m: Pdfium, obj: Ptr): boolean {
  const n = m.FPDFPageObj_CountMarks(obj);
  for (let k = 0; k < n; k++) {
    const mark = m.FPDFPageObj_GetMark(obj, k);
    if (mark && markName(m, mark) === OCR_MARK) return true;
  }
  return false;
}

/** Base letter for characters the bundled font does not have (é → e), or the character itself. */
function foldGlyphs(text: string, covers: (t: string) => boolean): { text: string; substituted: boolean } {
  if (covers(text)) return { text, substituted: false };
  const folded = [...text]
    .map((ch) => (covers(ch) ? ch : ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
    .join('')
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '?');
  return { text: folded, substituted: true };
}

export function addOcrLayer(d: DocInternals, i: PageIndex, words: OcrLayerWord[]): { written: number; substituted: number } {
  const m = d.m;
  const page = d.page(i);
  const font = d.shared.fonts.load(d.doc, 'sans', 'regular');
  const covers = (t: string): boolean => d.shared.fonts.covers('sans', 'regular', t);
  let written = 0;
  let substituted = 0;
  scope(m, (a) => {
    for (const w of words) {
      if (!(w.width > 0 && w.fontSize > 0) || w.text.trim() === '') continue;
      const folded = foldGlyphs(w.text, covers);
      if (folded.text.trim() === '') continue;
      const obj = m.FPDFPageObj_CreateTextObj(d.doc, font, w.fontSize);
      if (!obj) throw new InvalidPdfError('Could not create text object');
      setText(m, a, obj, folded.text);
      m.FPDFTextObj_SetTextRenderMode(obj, 3); // invisible: the scan image stays exactly as it was
      // Stretch along the baseline to the word's width, so selection and search boxes match the image.
      const natural = bounds(m, a, obj).width;
      const sx = natural > 0 ? w.width / natural : 1;
      setMatrix(m, a, obj, multiply(multiply([sx, 0, 0, 1, 0, 0], rotation(w.angle)), [1, 0, 0, 1, w.origin.x, w.origin.y]));
      m.FPDFPageObj_AddMark(obj, OCR_MARK);
      m.FPDFPage_InsertObject(page, obj);
      written++;
      if (folded.substituted) substituted++;
    }
  });
  if (written > 0) d.commitPage(i);
  return { written, substituted };
}

/** Objects of the page that belong to Folio's OCR layer, highest index first (safe to remove in order). */
function ocrObjects(d: DocInternals, i: PageIndex): Ptr[] {
  const m = d.m;
  const page = d.page(i);
  const out: Ptr[] = [];
  for (let k = m.FPDFPage_CountObjects(page) - 1; k >= 0; k--) {
    const obj = m.FPDFPage_GetObject(page, k);
    if (m.FPDFPageObj_GetType(obj) === 1 && isOcr(m, obj)) out.push(obj);
  }
  return out;
}
export function removeOcrLayer(d: DocInternals, i: PageIndex): number {
  const m = d.m;
  const page = d.page(i);
  const objs = ocrObjects(d, i);
  for (const obj of objs) {
    if (m.FPDFPage_RemoveObject(page, obj)) m.FPDFPageObj_Destroy(obj);
  }
  if (objs.length) d.commitPage(i);
  return objs.length;
}
export function hasOcrLayer(d: DocInternals, i: PageIndex): boolean {
  d.checkPage(i);
  return ocrObjects(d, i).length > 0;
}

// ---- images ----------------------------------------------------------------------------------

/** Creates a PDFium BGRA bitmap from an RGBA raster. Caller destroys it. */
export function bitmapFromRaster(m: Pdfium, img: RasterImage): Ptr {
  const bmp = m.FPDFBitmap_CreateEx(img.width, img.height, FPDFBitmap_BGRA, 0, 0);
  if (!bmp) throw new InvalidPdfError('Could not allocate bitmap');
  const buf = m.FPDFBitmap_GetBuffer(bmp);
  const stride = m.FPDFBitmap_GetStride(bmp);
  const heap = m.pdfium.HEAPU8;
  for (let y = 0; y < img.height; y++) {
    let o = buf + y * stride;
    let s = y * img.width * 4;
    for (let x = 0; x < img.width; x++, o += 4, s += 4) {
      heap[o] = img.data[s + 2]!;
      heap[o + 1] = img.data[s + 1]!;
      heap[o + 2] = img.data[s]!;
      heap[o + 3] = img.data[s + 3]!;
    }
  }
  return bmp;
}
export function rasterFromBitmap(m: Pdfium, bmp: Ptr): RasterImage {
  const width = m.FPDFBitmap_GetWidth(bmp);
  const height = m.FPDFBitmap_GetHeight(bmp);
  const stride = m.FPDFBitmap_GetStride(bmp);
  const format = m.FPDFBitmap_GetFormat(bmp); // 1 gray, 2 BGR, 3 BGRx, 4 BGRA
  const buf = m.FPDFBitmap_GetBuffer(bmp);
  const heap = m.pdfium.HEAPU8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    let s = buf + y * stride;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      if (format === 1) {
        data[o] = data[o + 1] = data[o + 2] = heap[s]!;
        data[o + 3] = 255;
        s += 1;
      } else {
        data[o] = heap[s + 2]!;
        data[o + 1] = heap[s + 1]!;
        data[o + 2] = heap[s]!;
        data[o + 3] = format === 4 ? heap[s + 3]! : 255;
        s += format === 2 ? 3 : 4;
      }
    }
  }
  return { width, height, data };
}

function setImageData(d: DocInternals, a: Arena, obj: Ptr, image: ImageSpec['image']): void {
  const m = d.m;
  if ('jpeg' in image) {
    if (!m.EPDFImageObj_SetJpeg(0, 0, obj, a.bytes(image.jpeg), image.jpeg.length))
      throw new InvalidPdfError('Could not embed JPEG image');
    return;
  }
  const bmp = bitmapFromRaster(m, image);
  try {
    if (!m.FPDFImageObj_SetBitmap(0, 0, obj, bmp)) throw new InvalidPdfError('Could not embed image');
  } finally {
    m.FPDFBitmap_Destroy(bmp);
  }
}

/** Matrix placing the unit image square onto `rect`, rotated by `angle` around the rect centre. */
export function imageMatrix(rect: Rect, angle = 0): Matrix {
  const base: Matrix = [rect.width, 0, 0, rect.height, rect.x, rect.y];
  return angle ? multiply(base, rotation(angle, center(rect))) : base;
}

export function addImage(d: DocInternals, i: PageIndex, spec: ImageSpec): ObjId {
  const m = d.m;
  const page = d.page(i);
  if (!(spec.rect.width > 0 && spec.rect.height > 0))
    throw new InvalidArgumentError('Image rectangle is empty');
  return scope(m, (a) => {
    const obj = m.FPDFPageObj_NewImageObj(d.doc);
    if (!obj) throw new InvalidPdfError('Could not create image object');
    try {
      setImageData(d, a, obj, spec.image);
    } catch (e) {
      m.FPDFPageObj_Destroy(obj);
      throw e;
    }
    setMatrix(m, a, obj, imageMatrix(spec.rect, spec.angle));
    m.FPDFPage_InsertObject(page, obj);
    d.commitPage(i);
    return objId(m.FPDFPage_CountObjects(page) - 1);
  });
}

export function getImage(d: DocInternals, i: PageIndex, id: ObjId): RasterImage {
  const m = d.m;
  const { obj } = getObject(d, i, id, 3);
  // The decoded source bitmap (not the page-transformed rendering) so extract-to-file keeps native resolution.
  const bmp = m.FPDFImageObj_GetBitmap(obj);
  if (!bmp) throw new InvalidPdfError('Could not decode image');
  try {
    return rasterFromBitmap(m, bmp);
  } finally {
    m.FPDFBitmap_Destroy(bmp);
  }
}

export function replaceImage(d: DocInternals, i: PageIndex, id: ObjId, image: ImageSpec['image']): void {
  const { obj } = getObject(d, i, id, 3);
  scope(d.m, (a) => setImageData(d, a, obj, image));
  d.commitPage(i);
}

// ---- generic ---------------------------------------------------------------------------------

export function transform(d: DocInternals, i: PageIndex, id: ObjId, mat: Matrix): void {
  const { obj } = getObject(d, i, id);
  d.m.FPDFPageObj_Transform(obj, mat[0], mat[1], mat[2], mat[3], mat[4], mat[5]);
  d.commitPage(i);
}

export function remove(d: DocInternals, i: PageIndex, id: ObjId): void {
  const { page, obj } = getObject(d, i, id);
  if (!d.m.FPDFPage_RemoveObject(page, obj)) throw new InvalidPdfError('Could not remove object');
  d.m.FPDFPageObj_Destroy(obj);
  d.commitPage(i);
}

export function addRect(d: DocInternals, i: PageIndex, spec: RectSpec): ObjId {
  const m = d.m;
  const page = d.page(i);
  const r = spec.rect;
  if (!(r.width > 0 && r.height > 0)) throw new InvalidArgumentError('Rectangle is empty');
  const obj = m.FPDFPageObj_CreateNewRect(r.x, r.y, r.width, r.height);
  if (!obj) throw new InvalidPdfError('Could not create rectangle');
  if (spec.fill) m.FPDFPageObj_SetFillColor(obj, spec.fill.r, spec.fill.g, spec.fill.b, alpha(spec.fill));
  if (spec.stroke) {
    m.FPDFPageObj_SetStrokeColor(obj, spec.stroke.r, spec.stroke.g, spec.stroke.b, alpha(spec.stroke));
    m.FPDFPageObj_SetStrokeWidth(obj, spec.strokeWidth ?? 1);
  }
  m.FPDFPath_SetDrawMode(obj, spec.fill ? 1 : 0, !!spec.stroke);
  m.FPDFPage_InsertObject(page, obj);
  d.commitPage(i);
  return objId(m.FPDFPage_CountObjects(page) - 1);
}
