import { init } from '@embedpdf/pdfium';
import { InvalidArgumentError } from '@folio/core';
import type { Color, PageIndex, PdfDocument, PdfEngine, RasterImage } from '@folio/ports';
import { MAX_BITMAP_SIDE, PdfiumDocument, type EngineShared } from './document.ts';
import { scope, type Pdfium } from './mem.ts';
import { FontRegistry, type FontData } from './fonts.ts';

export interface PdfiumEngineOptions {
  /** Contents of pdfium.wasm. */
  wasmBinary: ArrayBuffer | Uint8Array;
  /** Bundled font programs; without them added text uses the non-embedded PDF standard 14 fonts. */
  fonts?: FontData;
}

/** PdfEngine backed by PDFium compiled to WebAssembly. Runs in a Web Worker and in plain Node. */
export class PdfiumEngine implements PdfEngine {
  private docs = new Set<PdfiumDocument>();
  private disposed = false;
  private constructor(private readonly shared: EngineShared) {}

  static async create(opts: PdfiumEngineOptions): Promise<PdfiumEngine> {
    const wasm = opts.wasmBinary instanceof Uint8Array ? opts.wasmBinary.slice().buffer : opts.wasmBinary;
    const m = (await init({ wasmBinary: wasm as ArrayBuffer })) as unknown as Pdfium;
    m.PDFiumExt_Init();
    let docSeq = 0;
    let annotSeq = 0;
    const session = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    return new PdfiumEngine({
      m,
      fonts: new FontRegistry(m, opts.fonts ?? {}),
      nextDocId: () => `doc-${++docSeq}`,
      nextAnnotId: () => `folio-${session}-${(++annotSeq).toString(36)}`,
    });
  }

  private track(doc: PdfiumDocument): PdfiumDocument {
    this.docs.add(doc);
    const dispose = doc.dispose.bind(doc);
    doc.dispose = () => {
      this.docs.delete(doc);
      dispose();
    };
    return doc;
  }

  async open(data: Uint8Array, opts?: { password?: string }): Promise<PdfDocument> {
    this.alive();
    return this.track(PdfiumDocument.open(this.shared, data, opts?.password));
  }

  async create(): Promise<PdfDocument> {
    this.alive();
    return this.track(PdfiumDocument.createEmpty(this.shared));
  }

  async merge(parts: { doc: PdfDocument; pages: PageIndex[] }[]): Promise<PdfDocument> {
    this.alive();
    const out = await this.create();
    try {
      for (const part of parts) await out.importPages(part.doc, part.pages, out.pageCount);
    } catch (e) {
      out.dispose();
      throw e;
    }
    return out;
  }

  async rasterizeText(spec: { text: string; font: Uint8Array; fontSize: number; color: Color }): Promise<RasterImage> {
    this.alive();
    const m = this.shared.m;
    if (spec.text.trim() === '' || !(spec.fontSize > 0)) throw new InvalidArgumentError('Nothing to draw');
    const doc = m.FPDF_CreateNewDocument();
    try {
      return scope(m, (a) => {
        const font = m.FPDFText_LoadFont(doc, a.bytes(spec.font), spec.font.length, 2, true);
        if (!font) throw new InvalidArgumentError('The font could not be loaded');
        const text = m.FPDFPageObj_CreateTextObj(doc, font, spec.fontSize);
        m.FPDFText_SetText(text, a.utf16(spec.text));
        const b = a.alloc(16);
        m.FPDFPageObj_GetBounds(text, b, b + 4, b + 8, b + 12);
        const pad = Math.ceil(spec.fontSize * 0.2);
        const width = Math.max(1, Math.ceil(a.f32(b, 2) - a.f32(b, 0)) + 2 * pad);
        const height = Math.max(1, Math.ceil(a.f32(b, 3) - a.f32(b, 1)) + 2 * pad);
        if (width > MAX_BITMAP_SIDE || height > MAX_BITMAP_SIDE) throw new InvalidArgumentError('Text is too large');
        m.FPDFPageObj_SetFillColor(text, spec.color.r, spec.color.g, spec.color.b, 255);
        m.FPDFPageObj_SetMatrix(text, a.floats([1, 0, 0, 1, pad - a.f32(b, 0), pad - a.f32(b, 1)]));
        const page = m.FPDFPage_New(doc, 0, width, height);
        m.FPDFPage_InsertObject(page, text);
        const bitmap = m.FPDFBitmap_Create(width, height, 1);
        m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0);
        m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x10);
        const buf = m.FPDFBitmap_GetBuffer(bitmap);
        const stride = m.FPDFBitmap_GetStride(bitmap);
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) data.set(m.pdfium.HEAPU8.subarray(buf + y * stride, buf + y * stride + width * 4), y * width * 4);
        // PDFium renders premultiplied alpha on a transparent bitmap: un-premultiply for the port's contract.
        for (let i = 0; i < data.length; i += 4) {
          const al = data[i + 3]!;
          if (al > 0 && al < 255) {
            data[i] = Math.min(255, (data[i]! * 255) / al);
            data[i + 1] = Math.min(255, (data[i + 1]! * 255) / al);
            data[i + 2] = Math.min(255, (data[i + 2]! * 255) / al);
          }
        }
        m.FPDFBitmap_Destroy(bitmap);
        m.FPDF_ClosePage(page);
        m.FPDFFont_Close(font);
        return { width, height, data };
      });
    } finally {
      m.FPDF_CloseDocument(doc);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const doc of [...this.docs]) doc.dispose();
    this.disposed = true;
  }

  private alive(): void {
    if (this.disposed) throw new InvalidArgumentError('Engine is disposed');
  }
}
