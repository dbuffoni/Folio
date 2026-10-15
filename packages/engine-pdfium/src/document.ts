import {
  CancelledError,
  InvalidArgumentError,
  InvalidPdfError,
  LimitExceededError,
  PasswordRequiredError,
  groupLines,
  normalizeRotation,
  pagesToSearch,
  rotatedSize,
  searchTextLayer,
  unionAll,
} from '@folio/core';
import type {
  Annotation,
  AnnotationType,
  AnnotId,
  AttachmentInfo,
  DocMeta,
  EditableMeta,
  FieldId,
  FieldValue,
  FontInfo,
  FormField,
  ImageSpec,
  LinkInfo,
  LinkTarget,
  Matrix,
  ObjId,
  OutlineEdit,
  OutlineNode,
  PageIndex,
  PageInfo,
  PageObject,
  PdfDocument,
  RasterImage,
  Rect,
  RectSpec,
  RenderOptions,
  SaveOptions,
  SearchHit,
  SearchQuery,
  Size,
  TextChar,
  TextEditResult,
  TextLayer,
  TextRun,
  TextSpec,
  TextStyle,
} from '@folio/ports';
import * as annots from './annotations.ts';
import * as forms from './forms.ts';
import { ensureFieldsArray, importWithForms } from './formrepair.ts';
import { getAscii, getUtf16, scope, type Arena, type Pdfium, type Ptr } from './mem.ts';
import * as objects from './objects.ts';
import type { FontRegistry } from './fonts.ts';

const FPDF_ERR_PASSWORD = 4;
const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const FPDF_INCREMENTAL = 1;
const FPDF_NO_INCREMENTAL = 2;
const PAGEOBJ_TEXT = 1;
const PAGEOBJ_IMAGE = 3;

/** Largest bitmap side the engine will allocate (SPEC §8.8). */
export const MAX_BITMAP_SIDE = 8192;

export interface EngineShared {
  m: Pdfium;
  fonts: FontRegistry;
  nextDocId(): string;
  /** Monotonic id source for annotation names. */
  nextAnnotId(): string;
}

/** Internal surface shared with annotations.ts / forms.ts / objects.ts. */
export interface DocInternals {
  readonly m: Pdfium;
  readonly shared: EngineShared;
  readonly doc: Ptr;
  readonly pageCount: number;
  page(i: PageIndex): Ptr;
  form(): Ptr;
  checkPage(i: PageIndex): void;
  /** Regenerates the content stream of a page after object edits and drops cached text. */
  commitPage(i: PageIndex): void;
  closePages(): void;
  /** Drops PDFium's cached form model so it is rebuilt from the document on next use. */
  resetForm(): void;
  objectIndexMap(i: PageIndex): Map<Ptr, number>;
}

export class PdfiumDocument implements PdfDocument, DocInternals {
  readonly id: string;
  readonly m: Pdfium;
  doc: Ptr = 0;
  private dataPtr: Ptr = 0;
  private formInfo: Ptr = 0;
  private formHandle: Ptr = 0;
  private pages = new Map<PageIndex, Ptr>();
  private password?: string;
  private disposed = false;
  private repaired = false;

  private constructor(readonly shared: EngineShared) {
    this.m = shared.m;
    this.id = shared.nextDocId();
  }

  static open(shared: EngineShared, data: Uint8Array, password?: string): PdfiumDocument {
    const d = new PdfiumDocument(shared);
    d.load(data, password);
    return d;
  }
  static createEmpty(shared: EngineShared): PdfiumDocument {
    const d = new PdfiumDocument(shared);
    d.doc = shared.m.FPDF_CreateNewDocument();
    if (!d.doc) throw new InvalidPdfError('FPDF_CreateNewDocument failed');
    return d;
  }

  private load(data: Uint8Array, password?: string): void {
    const m = this.m;
    if (data.length < 8) throw new InvalidPdfError('File is too small to be a PDF');
    const ptr = m.pdfium._malloc(data.length);
    if (!ptr) throw new LimitExceededError('memory', 'Could not allocate the document buffer');
    m.pdfium.HEAPU8.set(data, ptr);
    const doc = m.FPDF_LoadMemDocument(ptr, data.length, password ?? '');
    if (!doc) {
      const err = m.FPDF_GetLastError();
      m.pdfium._free(ptr);
      if (err === FPDF_ERR_PASSWORD)
        throw new PasswordRequiredError(password !== undefined && password !== '');
      throw new InvalidPdfError(`PDFium error ${err}`);
    }
    this.doc = doc;
    this.dataPtr = ptr;
    this.password = password;
    this.repaired = !m.FPDF_DocumentHasValidCrossReferenceTable(doc);
  }

  private unload(): void {
    const m = this.m;
    this.closePages();
    if (this.formHandle) {
      m.PDFiumExt_ExitFormFillEnvironment(this.formHandle);
      m.PDFiumExt_CloseFormFillInfo(this.formInfo);
      this.formHandle = 0;
      this.formInfo = 0;
    }
    if (this.doc) {
      this.shared.fonts.forget(this.doc);
      m.FPDF_CloseDocument(this.doc);
    }
    if (this.dataPtr) m.pdfium._free(this.dataPtr);
    this.doc = 0;
    this.dataPtr = 0;
  }

  // ---- internals ---------------------------------------------------------------------------

  private alive(): void {
    if (this.disposed) throw new InvalidArgumentError('Document is disposed');
  }
  checkPage(i: PageIndex): void {
    this.alive();
    if (!Number.isInteger(i) || i < 0 || i >= this.pageCount) {
      throw new InvalidArgumentError(`Page ${i} out of range`, { page: i, pageCount: this.pageCount });
    }
  }
  form(): Ptr {
    if (!this.formHandle) {
      this.formInfo = this.m.PDFiumExt_OpenFormFillInfo();
      this.formHandle = this.m.PDFiumExt_InitFormFillEnvironment(this.doc, this.formInfo);
    }
    return this.formHandle;
  }
  page(i: PageIndex): Ptr {
    this.checkPage(i);
    let p = this.pages.get(i);
    if (!p) {
      p = this.m.FPDF_LoadPage(this.doc, i);
      if (!p) throw new InvalidPdfError(`Page ${i + 1} could not be loaded`);
      this.m.FORM_OnAfterLoadPage(p, this.form());
      this.pages.set(i, p);
    }
    return p;
  }
  closePages(): void {
    for (const p of this.pages.values()) {
      if (this.formHandle) this.m.FORM_OnBeforeClosePage(p, this.formHandle);
      this.m.FPDF_ClosePage(p);
    }
    this.pages.clear();
  }
  resetForm(): void {
    this.closePages();
    if (this.formHandle) {
      this.m.PDFiumExt_ExitFormFillEnvironment(this.formHandle);
      this.m.PDFiumExt_CloseFormFillInfo(this.formInfo);
      this.formHandle = 0;
      this.formInfo = 0;
    }
  }
  commitPage(i: PageIndex): void {
    if (!this.m.FPDFPage_GenerateContent(this.page(i)))
      throw new InvalidPdfError('Could not regenerate page content');
  }
  objectIndexMap(i: PageIndex): Map<Ptr, number> {
    const page = this.page(i);
    const map = new Map<Ptr, number>();
    const n = this.m.FPDFPage_CountObjects(page);
    for (let k = 0; k < n; k++) map.set(this.m.FPDFPage_GetObject(page, k), k);
    return map;
  }

  // ---- document ----------------------------------------------------------------------------

  get pageCount(): number {
    return this.doc ? this.m.FPDF_GetPageCount(this.doc) : 0;
  }

  async getMeta(): Promise<DocMeta> {
    this.alive();
    const m = this.m;
    const text = (tag: string): string =>
      getUtf16(m, (buf, len) => m.FPDF_GetMetaText(this.doc, tag, buf, len));
    const version = scope(m, (a) => {
      const p = a.alloc(4);
      return m.FPDF_GetFileVersion(this.doc, p) ? a.i32(p) : 0;
    });
    const formType = m.FPDF_GetFormType(this.doc);
    return {
      title: text('Title'),
      author: text('Author'),
      subject: text('Subject'),
      keywords: text('Keywords'),
      creator: text('Creator'),
      producer: text('Producer'),
      creationDate: text('CreationDate'),
      modDate: text('ModDate'),
      pdfVersion: version ? `${Math.floor(version / 10)}.${version % 10}` : '',
      hasXfa: formType === 2 || formType === 3,
      hasAcroForm: formType !== 0,
      isEncrypted: !!m.EPDF_IsEncrypted(this.doc),
      hasSignatures: m.FPDF_GetSignatureCount(this.doc) > 0,
      wasRepaired: this.repaired,
    };
  }

  async setMetadata(meta: Partial<EditableMeta>): Promise<void> {
    this.alive();
    const tags: Record<keyof EditableMeta, string> = {
      title: 'Title',
      author: 'Author',
      subject: 'Subject',
      keywords: 'Keywords',
    };
    scope(this.m, (a) => {
      for (const key of Object.keys(tags) as (keyof EditableMeta)[]) {
        const value = meta[key];
        if (value === undefined) continue;
        if (!this.m.EPDF_SetMetaText(this.doc, tags[key], value === '' ? 0 : a.utf16(value))) {
          throw new InvalidPdfError(`Could not set metadata ${key}`);
        }
      }
    });
  }

  async clearMetadata(): Promise<void> {
    this.alive();
    const m = this.m;
    const keys = new Set([
      'Title',
      'Author',
      'Subject',
      'Keywords',
      'Creator',
      'Producer',
      'CreationDate',
      'ModDate',
    ]);
    const n = m.EPDF_GetMetaKeyCount(this.doc, false);
    for (let i = 0; i < n; i++)
      keys.add(getAscii(m, (buf, len) => m.EPDF_GetMetaKeyName(this.doc, i, false, buf, len)));
    for (const key of keys) if (key && key !== 'Trapped') m.EPDF_SetMetaText(this.doc, key, 0);
  }

  // ---- pages -------------------------------------------------------------------------------

  async getPageInfo(i: PageIndex): Promise<PageInfo> {
    this.checkPage(i);
    const m = this.m;
    const page = this.page(i);
    return scope(m, (a) => {
      const box = (fn: (page: Ptr, l: Ptr, b: Ptr, r: Ptr, t: Ptr) => boolean): Rect | null => {
        const p = a.alloc(16);
        if (!fn(page, p, p + 4, p + 8, p + 12)) return null;
        const [l, b, r, t] = [a.f32(p, 0), a.f32(p, 1), a.f32(p, 2), a.f32(p, 3)];
        return { x: Math.min(l, r), y: Math.min(b, t), width: Math.abs(r - l), height: Math.abs(t - b) };
      };
      const rotation = normalizeRotation(m.FPDFPage_GetRotation(page) * 90);
      const shown = rotatedSize(
        { width: m.FPDF_GetPageWidthF(page), height: m.FPDF_GetPageHeightF(page) },
        rotation,
      );
      const mediaBox = box(m.FPDFPage_GetMediaBox) ?? { x: 0, y: 0, ...shown };
      const cropBox = box(m.FPDFPage_GetCropBox) ?? mediaBox;
      const label = getUtf16(m, (buf, len) => m.FPDF_GetPageLabel(this.doc, i, buf, len));
      return { size: shown, rotation, mediaBox, cropBox, label: label || undefined };
    });
  }

  async insertBlank(at: PageIndex, size: Size): Promise<void> {
    this.alive();
    if (at < 0 || at > this.pageCount) throw new InvalidArgumentError(`Insert position ${at} out of range`);
    if (!(size.width > 0 && size.height > 0)) throw new InvalidArgumentError('Page size must be positive');
    this.closePages();
    const page = this.m.FPDFPage_New(this.doc, at, size.width, size.height);
    if (!page) throw new InvalidPdfError('Could not create page');
    this.m.FPDF_ClosePage(page);
  }

  hasFormFields(): boolean {
    return this.m.FPDF_GetFormType(this.doc) !== 0;
  }
  /** Full, non-incremental serialisation of the current state. */
  bytesNow(): Uint8Array {
    return this.write(FPDF_NO_INCREMENTAL);
  }
  private reload(bytes: Uint8Array): void {
    const password = this.password;
    this.unload();
    this.load(bytes, password);
  }

  async importPages(src: PdfDocument, pages: PageIndex[], at: PageIndex): Promise<void> {
    this.alive();
    if (!(src instanceof PdfiumDocument)) throw new InvalidArgumentError('Source document belongs to another engine');
    if (at < 0 || at > this.pageCount) throw new InvalidArgumentError(`Insert position ${at} out of range`);
    for (const p of pages) src.checkPage(p);
    if (pages.length === 0) return;
    if (src.hasFormFields()) {
      // PDFium drops the field tree of imported widgets: route form pages through the structural helper.
      try {
        const srcBytes = src === this ? this.bytesNow() : src.bytesNow();
        const { bytes } = await importWithForms(this.bytesNow(), srcBytes, pages, at);
        this.reload(bytes);
        return;
      } catch {
        // Encrypted or unusual sources: fall back to the plain import (pages kept, fields become static).
      }
    }
    this.closePages();
    const ok = scope(this.m, (a) => this.m.FPDF_ImportPagesByIndex(this.doc, src.doc, a.ints(pages), pages.length, at));
    if (!ok) throw new InvalidPdfError('Could not import pages');
  }

  async deletePages(pages: PageIndex[]): Promise<void> {
    const unique = [...new Set(pages)];
    for (const p of unique) this.checkPage(p);
    if (unique.length >= this.pageCount)
      throw new InvalidArgumentError('Cannot delete every page of a document');
    this.closePages();
    for (const p of unique.sort((a, b) => b - a)) this.m.FPDFPage_Delete(this.doc, p);
  }

  async movePages(pages: PageIndex[], to: PageIndex): Promise<void> {
    for (const p of pages) this.checkPage(p);
    if (new Set(pages).size !== pages.length) throw new InvalidArgumentError('Duplicate page in move');
    if (to < 0 || to > this.pageCount - pages.length)
      throw new InvalidArgumentError(`Move target ${to} out of range`);
    if (pages.length === 0) return;
    this.closePages();
    const ok = scope(this.m, (a) => this.m.FPDF_MovePages(this.doc, a.ints(pages), pages.length, to));
    if (!ok) throw new InvalidPdfError('Could not move pages');
  }

  async rotatePages(pages: PageIndex[], deg: 90 | 180 | 270): Promise<void> {
    if (deg !== 90 && deg !== 180 && deg !== 270) throw new InvalidArgumentError('Rotation must be 90, 180 or 270 degrees');
    for (const p of new Set(pages)) {
      const page = this.page(p);
      this.m.FPDFPage_SetRotation(page, (this.m.FPDFPage_GetRotation(page) + deg / 90) % 4);
    }
  }

  // ---- rendering ---------------------------------------------------------------------------

  async render(i: PageIndex, o: RenderOptions, signal?: AbortSignal): Promise<RasterImage> {
    this.checkPage(i);
    if (signal?.aborted) throw new CancelledError();
    if (!(o.scale > 0)) throw new InvalidArgumentError('Scale must be positive');
    const m = this.m;
    const page = this.page(i);
    const extra = (o.rotation ?? 0) / 90;
    const base = { width: m.FPDF_GetPageWidthF(page), height: m.FPDF_GetPageHeightF(page) };
    const full = extra % 2 === 1 ? { width: base.height, height: base.width } : base;
    const fullW = Math.max(1, Math.round(full.width * o.scale));
    const fullH = Math.max(1, Math.round(full.height * o.scale));
    const tile = o.rect ?? { x: 0, y: 0, width: fullW, height: fullH };
    const w = Math.round(tile.width);
    const h = Math.round(tile.height);
    if (w <= 0 || h <= 0) throw new InvalidArgumentError('Empty render rectangle');
    if (w > MAX_BITMAP_SIDE || h > MAX_BITMAP_SIDE) throw new LimitExceededError('bitmapSize', `${w}×${h}`);

    const bitmap = m.FPDFBitmap_Create(w, h, 1);
    if (!bitmap) throw new LimitExceededError('memory', 'Could not allocate the render bitmap');
    try {
      const bg = o.background ?? { r: 255, g: 255, b: 255, a: 1 };
      const argb = ((Math.round((bg.a ?? 1) * 255) << 24) | (bg.r << 16) | (bg.g << 8) | bg.b) >>> 0;
      m.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, argb);
      const flags = FPDF_REVERSE_BYTE_ORDER | (o.annotations === false ? 0 : FPDF_ANNOT);
      const sx = -Math.round(tile.x);
      const sy = -Math.round(tile.y);
      m.FPDF_RenderPageBitmap(bitmap, page, sx, sy, fullW, fullH, extra, flags);
      if (o.forms !== false) m.FPDF_FFLDraw(this.form(), bitmap, page, sx, sy, fullW, fullH, extra, flags);
      const buf = m.FPDFBitmap_GetBuffer(bitmap);
      const stride = m.FPDFBitmap_GetStride(bitmap);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++)
        data.set(m.pdfium.HEAPU8.subarray(buf + y * stride, buf + y * stride + w * 4), y * w * 4);
      return { width: w, height: h, data };
    } finally {
      m.FPDFBitmap_Destroy(bitmap);
    }
  }

  // ---- text --------------------------------------------------------------------------------

  private fontInfo(a: Arena, obj: Ptr): FontInfo {
    const m = this.m;
    const font = m.FPDFTextObj_GetFont(obj);
    if (!font)
      return {
        name: '',
        family: '',
        isEmbedded: false,
        isSubset: false,
        weight: 400,
        italic: false,
        flags: 0,
      };
    const raw = getAscii(m, (buf, len) => m.FPDFFont_GetBaseFontName(font, buf, len));
    const isSubset = /^[A-Z]{6}\+/.test(raw);
    const angle = a.alloc(4);
    const italicAngle = m.FPDFFont_GetItalicAngle(font, angle) ? a.i32(angle) : 0;
    const flags = m.FPDFFont_GetFlags(font);
    const weight = m.FPDFFont_GetWeight(font);
    return {
      name: isSubset ? raw.slice(7) : raw,
      family: getAscii(m, (buf, len) => m.FPDFFont_GetFamilyName(font, buf, len)),
      isEmbedded: m.FPDFFont_GetIsEmbedded(font) === 1,
      isSubset,
      weight: weight > 0 ? weight : /bold/i.test(raw) ? 700 : 400,
      italic: italicAngle !== 0 || (flags & 0x40) !== 0 || /italic|oblique/i.test(raw),
      flags: flags < 0 ? 0 : flags,
    };
  }

  async getTextLayer(i: PageIndex): Promise<TextLayer> {
    this.checkPage(i);
    const m = this.m;
    const page = this.page(i);
    const tp = m.FPDFText_LoadPage(page);
    if (!tp) return { page: i, text: '', chars: [], runs: [], lines: [], isScanned: this.looksScanned(i) };
    try {
      return scope(m, (a) => {
        const objIndex = this.objectIndexMap(i);
        const n = m.FPDFText_CountChars(tp);
        const d = a.alloc(32); // 4 doubles
        const rectF = a.alloc(16);
        const chars: TextChar[] = [];
        const runs: TextRun[] = [];
        let run: (TextRun & { obj: Ptr }) | null = null;
        const closeRun = (): void => {
          if (!run) return;
          const boxes = chars
            .slice(run.charStart, run.charStart + run.charCount)
            .map((c) => c.rect)
            .filter((r) => r.width > 0);
          run.rect = boxes.length ? unionAll(boxes) : run.rect;
          const { obj: _obj, ...clean } = run;
          runs.push(clean);
          run = null;
        };
        for (let k = 0; k < n; k++) {
          const code = m.FPDFText_GetUnicode(tp, k);
          const text = code === 0 ? '' : String.fromCodePoint(code);
          let rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
          if (m.FPDFText_GetLooseCharBox(tp, k, rectF)) {
            const [l, t, r, b] = [a.f32(rectF, 0), a.f32(rectF, 1), a.f32(rectF, 2), a.f32(rectF, 3)];
            rect = { x: Math.min(l, r), y: Math.min(b, t), width: Math.abs(r - l), height: Math.abs(t - b) };
          } else if (m.FPDFText_GetCharBox(tp, k, d, d + 8, d + 16, d + 24)) {
            const [l, r, b, t] = [a.f64(d, 0), a.f64(d, 1), a.f64(d, 2), a.f64(d, 3)];
            rect = { x: l, y: b, width: r - l, height: t - b };
          }
          let origin = { x: rect.x, y: rect.y };
          if (m.FPDFText_GetCharOrigin(tp, k, d, d + 8)) origin = { x: a.f64(d, 0), y: a.f64(d, 1) };
          chars.push({ text, rect, origin });

          const obj = m.FPDFText_GetTextObject(tp, k);
          if (!obj) {
            // Generated character: keep spaces that sit inside a run, end the run on anything else.
            const nextObj = k + 1 < n ? m.FPDFText_GetTextObject(tp, k + 1) : 0;
            if (run && text === ' ' && nextObj === run.obj) {
              run.text += text;
              run.charCount++;
            } else {
              closeRun();
            }
            continue;
          }
          if (!run || run.obj !== obj) {
            closeRun();
            const mat = a.alloc(24);
            m.FPDFPageObj_GetMatrix(obj, mat);
            const [ma, mb, mc, md] = [a.f32(mat, 0), a.f32(mat, 1), a.f32(mat, 2), a.f32(mat, 3)];
            const sizeP = a.alloc(4);
            const objSize: number = m.FPDFTextObj_GetFontSize(obj, sizeP)
              ? a.f32(sizeP)
              : m.FPDFText_GetFontSize(tp, k);
            const col = a.alloc(16);
            const hasColor = m.FPDFPageObj_GetFillColor(obj, col, col + 4, col + 8, col + 12);
            const index = objIndex.get(obj);
            run = {
              obj,
              objId: index === undefined ? undefined : objects.objId(index),
              text: '',
              rect,
              origin,
              angle: (Math.atan2(mb, ma) * 180) / Math.PI,
              font: this.fontInfo(a, obj),
              fontSize: objSize * (Math.hypot(mc, md) || 1),
              color: hasColor
                ? { r: a.u32(col, 0), g: a.u32(col, 1), b: a.u32(col, 2), a: a.u32(col, 3) / 255 }
                : { r: 0, g: 0, b: 0, a: 1 },
              charStart: k,
              charCount: 0,
            };
          }
          run.text += text;
          run.charCount++;
        }
        closeRun();
        return {
          page: i,
          text: chars.map((c) => c.text).join(''),
          chars,
          runs,
          lines: groupLines(runs),
          isScanned: runs.length === 0 && this.looksScanned(i),
        };
      });
    } finally {
      m.FPDFText_ClosePage(tp);
    }
  }

  /** A page with no text whose area is mostly covered by one image is treated as a scan. */
  private looksScanned(i: PageIndex): boolean {
    const m = this.m;
    const page = this.page(i);
    const pageArea = m.FPDF_GetPageWidthF(page) * m.FPDF_GetPageHeightF(page);
    return scope(m, (a) => {
      const p = a.alloc(16);
      const n = m.FPDFPage_CountObjects(page);
      for (let k = 0; k < n; k++) {
        const obj = m.FPDFPage_GetObject(page, k);
        const type = m.FPDFPageObj_GetType(obj);
        if (type === PAGEOBJ_TEXT) return false;
        if (type !== PAGEOBJ_IMAGE) continue;
        if (!m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12)) continue;
        const area = Math.abs(a.f32(p, 2) - a.f32(p, 0)) * Math.abs(a.f32(p, 3) - a.f32(p, 1));
        if (area >= pageArea * 0.5) return true;
      }
      return false;
    });
  }

  async *search(q: SearchQuery): AsyncIterable<SearchHit> {
    this.alive();
    if (q.text === '') return;
    for (const p of pagesToSearch(q, this.pageCount)) {
      this.checkPage(p);
      yield* searchTextLayer(await this.getTextLayer(p), q);
    }
  }

  // ---- outline, links, attachments ---------------------------------------------------------

  private destTarget(dest: Ptr): LinkTarget {
    const m = this.m;
    const page = m.FPDFDest_GetDestPageIndex(this.doc, dest);
    if (page < 0) return { kind: 'unsupported', reason: 'missing' };
    return scope(m, (a) => {
      const p = a.alloc(24);
      const ok = m.FPDFDest_GetLocationInPage(dest, p, p + 4, p + 8, p + 12, p + 16, p + 20);
      const target: LinkTarget = { kind: 'page', page };
      if (ok && (a.i32(p, 0) || a.i32(p, 1)))
        target.point = { x: a.i32(p, 0) ? a.f32(p, 3) : 0, y: a.i32(p, 1) ? a.f32(p, 4) : 0 };
      if (ok && a.i32(p, 2) && a.f32(p, 5) > 0) target.zoom = a.f32(p, 5);
      return target;
    });
  }
  private actionTarget(action: Ptr): LinkTarget {
    const m = this.m;
    switch (m.FPDFAction_GetType(action)) {
      case 1: {
        const dest = m.FPDFAction_GetDest(this.doc, action);
        return dest ? this.destTarget(dest) : { kind: 'unsupported', reason: 'unknown' };
      }
      case 2:
        return { kind: 'unsupported', reason: 'remote' };
      case 3: {
        const uri = getAscii(m, (buf, len) => m.FPDFAction_GetURIPath(this.doc, action, buf, len));
        // Only web and mail links are ever offered to the user; anything else (javascript:, file:) is inert.
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

  async getOutline(): Promise<OutlineNode[]> {
    this.alive();
    const m = this.m;
    const seen = new Set<Ptr>();
    const walk = (first: Ptr, depth: number): OutlineNode[] => {
      const out: OutlineNode[] = [];
      for (
        let bm = first;
        bm && !seen.has(bm) && depth < 64;
        bm = m.FPDFBookmark_GetNextSibling(this.doc, bm)
      ) {
        seen.add(bm);
        const dest = m.FPDFBookmark_GetDest(this.doc, bm);
        const action = dest ? 0 : m.FPDFBookmark_GetAction(bm);
        out.push({
          title: getUtf16(m, (buf, len) => m.FPDFBookmark_GetTitle(bm, buf, len)),
          target: dest ? this.destTarget(dest) : action ? this.actionTarget(action) : undefined,
          children: walk(m.FPDFBookmark_GetFirstChild(this.doc, bm), depth + 1),
        });
      }
      return out;
    };
    return walk(m.FPDFBookmark_GetFirstChild(this.doc, 0), 0);
  }

  async setOutline(nodes: OutlineNode[]): Promise<void> {
    this.alive();
    const m = this.m;
    m.EPDFBookmark_Clear(this.doc);
    scope(m, (a) => {
      const add = (parent: Ptr, list: OutlineNode[]): void => {
        for (const node of list) {
          const title = a.utf16(node.title);
          const bm = parent
            ? m.EPDFBookmark_AppendChild(this.doc, parent, title)
            : m.EPDFBookmark_Create(this.doc, title);
          if (!bm) throw new InvalidPdfError('Could not create bookmark');
          if (node.target?.kind === 'page' && node.target.page >= 0 && node.target.page < this.pageCount) {
            const page = this.page(node.target.page);
            const pt = node.target.point;
            const dest = m.EPDFDest_CreateXYZ(page, !!pt, pt?.x ?? 0, !!pt, pt?.y ?? 0, false, 0);
            if (dest) m.EPDFBookmark_SetDest(this.doc, bm, dest);
          } else if (node.target?.kind === 'uri') {
            const action = m.EPDFAction_CreateURI(this.doc, node.target.uri);
            if (action) m.EPDFBookmark_SetAction(this.doc, bm, action);
          }
          add(bm, node.children);
        }
      };
      add(0, nodes);
    });
  }

  async editOutline(edit: OutlineEdit): Promise<void> {
    this.alive();
    const m = this.m;
    const bad = (what: string): never => {
      throw new InvalidArgumentError(`No bookmark at ${what}`, { reason: 'badOutlinePath' });
    };
    /** Bookmark at `path`; the empty path is the invisible root (0). */
    const nodeAt = (path: number[]): Ptr => {
      let bm: Ptr = 0;
      for (const [depth, index] of path.entries()) {
        let cur = m.FPDFBookmark_GetFirstChild(this.doc, bm);
        for (let k = 0; cur && k < index; k++) cur = m.FPDFBookmark_GetNextSibling(this.doc, cur);
        if (!cur) return bad(path.slice(0, depth + 1).join('/'));
        bm = cur;
      }
      return bm;
    };
    const title = (value: string): string => {
      const t = value.trim();
      if (t === '' || t.length > 512) throw new InvalidArgumentError('Bookmark titles have 1 to 512 characters', { reason: 'badBookmarkTitle' });
      return t;
    };
    const setTarget = (bm: Ptr, target: LinkTarget | undefined): void => {
      if (target?.kind === 'page' && target.page >= 0 && target.page < this.pageCount) {
        const page = this.page(target.page);
        const pt = target.point;
        const zoom = target.zoom && target.zoom > 0 ? target.zoom : 0;
        const dest = m.EPDFDest_CreateXYZ(page, !!pt, pt?.x ?? 0, !!pt, pt?.y ?? 0, zoom > 0, zoom);
        if (dest) m.EPDFBookmark_SetDest(this.doc, bm, dest);
      } else if (target?.kind === 'uri') {
        const action = m.EPDFAction_CreateURI(this.doc, target.uri);
        if (action) m.EPDFBookmark_SetAction(this.doc, bm, action);
      }
    };
    /** Inserts as child `index` of `parent` (0 = the root); returns the new bookmark. */
    const insert = (parent: Ptr, index: number, text: string): Ptr =>
      scope(m, (a) => {
        let after: Ptr = 0;
        let cur = m.FPDFBookmark_GetFirstChild(this.doc, parent);
        for (let k = 0; cur && k < index; k++) {
          after = cur;
          cur = m.FPDFBookmark_GetNextSibling(this.doc, cur);
        }
        const bm = m.EPDFBookmark_InsertAfter(this.doc, parent, after, a.utf16(text));
        if (!bm) throw new InvalidPdfError('Could not create bookmark');
        return bm;
      });
    const childCount = (parent: Ptr): number => {
      let n = 0;
      for (let c = m.FPDFBookmark_GetFirstChild(this.doc, parent); c; c = m.FPDFBookmark_GetNextSibling(this.doc, c)) n++;
      return n;
    };
    const copyTree = (src: Ptr, parent: Ptr, index: number): void => {
      const bm = insert(parent, index, getUtf16(m, (b, l) => m.FPDFBookmark_GetTitle(src, b, l)));
      // PDFium cannot re-attach an existing action object, so a moved entry keeps its page/position/zoom or
      // web address; named, script and launch actions (never run by Folio) are not carried over a move.
      const dest = m.FPDFBookmark_GetDest(this.doc, src);
      const action = dest ? 0 : m.FPDFBookmark_GetAction(src);
      if (dest) setTarget(bm, this.destTarget(dest));
      else if (action) setTarget(bm, this.actionTarget(action));
      let k = 0;
      for (let c = m.FPDFBookmark_GetFirstChild(this.doc, src); c; c = m.FPDFBookmark_GetNextSibling(this.doc, c)) copyTree(c, bm, k++);
    };
    switch (edit.op) {
      case 'add': {
        const parent = nodeAt(edit.parent);
        const text = title(edit.title);
        if (edit.index < 0 || edit.index > childCount(parent)) bad(`${edit.parent.join('/')}[${edit.index}]`);
        setTarget(insert(parent, edit.index, text), edit.target);
        return;
      }
      case 'rename': {
        const bm = edit.path.length ? nodeAt(edit.path) : bad('root');
        const text = title(edit.title);
        if (!scope(m, (a) => m.EPDFBookmark_SetTitle(bm, a.utf16(text)))) throw new InvalidPdfError('Could not rename bookmark');
        return;
      }
      case 'remove': {
        const bm = edit.path.length ? nodeAt(edit.path) : bad('root');
        if (!m.EPDFBookmark_Delete(this.doc, bm)) throw new InvalidPdfError('Could not delete bookmark');
        return;
      }
      case 'setTarget': {
        const bm = edit.path.length ? nodeAt(edit.path) : bad('root');
        m.EPDFBookmark_ClearTarget(bm);
        setTarget(bm, edit.target);
        return;
      }
      case 'move': {
        const from = edit.path;
        if (from.length === 0) bad('root');
        const src = nodeAt(from);
        // Express the destination in the tree before the entry is taken out.
        const d = from.length - 1;
        const parent = [...edit.parent];
        let index = edit.index;
        if (parent.length > d && parent.slice(0, d).every((v, k) => v === from[k]) && parent[d]! >= from[d]!) parent[d]!++;
        else if (parent.length === d && parent.every((v, k) => v === from[k]) && index >= from[d]!) index++;
        if (from.every((v, k) => parent[k] === v)) throw new InvalidArgumentError('A bookmark cannot move into itself', { reason: 'badOutlinePath' });
        const target = nodeAt(parent);
        if (index < 0 || index > childCount(target)) bad(`${edit.parent.join('/')}[${edit.index}]`);
        copyTree(src, target, index);
        // The copy may have shifted the original within a list it was inserted into.
        const oldPath = [...from];
        const L = parent.length;
        if (L < oldPath.length && parent.every((v, k) => v === oldPath[k]) && index <= oldPath[L]!) oldPath[L]!++;
        if (!m.EPDFBookmark_Delete(this.doc, nodeAt(oldPath))) throw new InvalidPdfError('Could not move bookmark');
        return;
      }
    }
  }

  async getLinks(i: PageIndex): Promise<LinkInfo[]> {
    this.checkPage(i);
    const m = this.m;
    const page = this.page(i);
    return scope(m, (a) => {
      const pos = a.alloc(4);
      const linkP = a.alloc(4);
      const rectP = a.alloc(16);
      const out: LinkInfo[] = [];
      while (m.FPDFLink_Enumerate(page, pos, linkP)) {
        const link = a.u32(linkP);
        if (!link || !m.FPDFLink_GetAnnotRect(link, rectP)) continue;
        const [l, t, r, b] = [a.f32(rectP, 0), a.f32(rectP, 1), a.f32(rectP, 2), a.f32(rectP, 3)];
        const dest = m.FPDFLink_GetDest(this.doc, link);
        const action = dest ? 0 : m.FPDFLink_GetAction(link);
        out.push({
          rect: { x: Math.min(l, r), y: Math.min(b, t), width: Math.abs(r - l), height: Math.abs(t - b) },
          target: dest
            ? this.destTarget(dest)
            : action
              ? this.actionTarget(action)
              : { kind: 'unsupported', reason: 'unknown' },
        });
      }
      return out;
    });
  }

  async listAttachments(): Promise<AttachmentInfo[]> {
    this.alive();
    const m = this.m;
    const n = m.FPDFDoc_GetAttachmentCount(this.doc);
    const out: AttachmentInfo[] = [];
    for (let index = 0; index < n; index++) {
      const att = m.FPDFDoc_GetAttachment(this.doc, index);
      const size = scope(m, (a) => {
        const p = a.alloc(4);
        return m.FPDFAttachment_GetFile(att, 0, 0, p) ? a.u32(p) : 0;
      });
      out.push({ index, name: getUtf16(m, (buf, len) => m.FPDFAttachment_GetName(att, buf, len)), size });
    }
    return out;
  }

  async getAttachment(index: number): Promise<Uint8Array> {
    this.alive();
    const m = this.m;
    if (index < 0 || index >= m.FPDFDoc_GetAttachmentCount(this.doc))
      throw new InvalidArgumentError('No such attachment');
    const att = m.FPDFDoc_GetAttachment(this.doc, index);
    return scope(m, (a) => {
      const sizeP = a.alloc(4);
      if (!m.FPDFAttachment_GetFile(att, 0, 0, sizeP)) throw new InvalidPdfError('Attachment has no data');
      const size = a.u32(sizeP);
      const buf = a.alloc(size);
      m.FPDFAttachment_GetFile(att, buf, size, sizeP);
      return m.pdfium.HEAPU8.slice(buf, buf + size);
    });
  }

  // ---- annotations / forms / objects (implemented in sibling modules) ------------------------

  async listAnnotations(i: PageIndex): Promise<Annotation[]> {
    return annots.list(this, i);
  }
  async upsertAnnotation(i: PageIndex, a: Annotation): Promise<AnnotId> {
    await this.shared.fonts.ready;
    return annots.upsert(this, i, a);
  }
  async removeAnnotation(i: PageIndex, id: AnnotId): Promise<void> {
    annots.remove(this, i, id);
  }
  async reorderAnnotations(i: PageIndex, ids: AnnotId[]): Promise<void> {
    annots.reorder(this, i, ids);
  }
  async flattenAnnotations(pages?: PageIndex[], types?: AnnotationType[]): Promise<void> {
    annots.flatten(this, pages ?? Array.from({ length: this.pageCount }, (_, k) => k), types);
  }
  async listFormFields(): Promise<FormField[]> {
    this.alive();
    return forms.list(this);
  }
  async setFieldValue(id: FieldId, v: FieldValue): Promise<void> {
    this.alive();
    forms.setValue(this, id, v);
  }
  async renameField(id: FieldId, name: string): Promise<FieldId> {
    this.alive();
    return forms.rename(this, id, name);
  }
  async flattenForm(): Promise<void> {
    this.alive();
    forms.flatten(this);
  }
  async listObjects(i: PageIndex): Promise<PageObject[]> {
    return objects.list(this, i);
  }
  async replaceTextRun(i: PageIndex, objId: ObjId, text: string, style?: TextStyle): Promise<TextEditResult> {
    await this.shared.fonts.ready;
    return objects.replaceText(this, i, objId, text, style);
  }
  async addText(i: PageIndex, spec: TextSpec): Promise<ObjId> {
    await this.shared.fonts.ready;
    return objects.addText(this, i, spec);
  }
  async addImage(i: PageIndex, img: ImageSpec): Promise<ObjId> {
    return objects.addImage(this, i, img);
  }
  async getImage(i: PageIndex, id: ObjId): Promise<RasterImage> {
    return objects.getImage(this, i, id);
  }
  async replaceImage(i: PageIndex, id: ObjId, image: ImageSpec['image']): Promise<void> {
    objects.replaceImage(this, i, id, image);
  }
  async transformObject(i: PageIndex, id: ObjId, matrix: Matrix): Promise<void> {
    objects.transform(this, i, id, matrix);
  }
  async removeObject(i: PageIndex, id: ObjId): Promise<void> {
    objects.remove(this, i, id);
  }
  async addRect(i: PageIndex, spec: RectSpec): Promise<ObjId> {
    return objects.addRect(this, i, spec);
  }

  // ---- IO ----------------------------------------------------------------------------------

  private write(flags: number): Uint8Array {
    const m = this.m;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const cb = m.pdfium.addFunction((_self: number, data: number, size: number) => {
      chunks.push(m.pdfium.HEAPU8.slice(data, data + size));
      total += size;
      return 1;
    }, 'iiii');
    try {
      const ok = scope(m, (a) => {
        const fw = a.alloc(8); // FPDF_FILEWRITE { int version; WriteBlock* }
        m.pdfium.HEAP32[fw >> 2] = 1;
        m.pdfium.HEAP32[(fw >> 2) + 1] = cb;
        return m.FPDF_SaveAsCopy(this.doc, fw, flags);
      });
      if (!ok) throw new InvalidPdfError('PDFium could not write the document');
    } finally {
      m.pdfium.removeFunction(cb);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  async save(opts: SaveOptions = {}): Promise<Uint8Array> {
    this.alive();
    // A document created in memory has no original bytes to append to.
    const incremental = !!opts.incremental && this.dataPtr !== 0;
    if (incremental) return this.write(FPDF_INCREMENTAL);
    return ensureFieldsArray(this.write(FPDF_NO_INCREMENTAL));
  }

  async snapshot(): Promise<Uint8Array> {
    this.alive();
    // Signed files are snapshotted incrementally so the signed byte range survives undo/redo.
    const signed = this.dataPtr !== 0 && this.m.FPDF_GetSignatureCount(this.doc) > 0;
    return this.write(signed ? FPDF_INCREMENTAL : FPDF_NO_INCREMENTAL);
  }

  async restore(bytes: Uint8Array): Promise<void> {
    this.alive();
    this.reload(bytes);
  }

  dispose(): void {
    if (this.disposed) return;
    this.unload();
    this.disposed = true;
  }
}
