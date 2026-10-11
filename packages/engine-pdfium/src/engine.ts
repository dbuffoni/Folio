import { init } from '@embedpdf/pdfium';
import { InvalidArgumentError } from '@folio/core';
import type { PageIndex, PdfDocument, PdfEngine } from '@folio/ports';
import { PdfiumDocument, type EngineShared } from './document.ts';
import type { Pdfium } from './mem.ts';
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const doc of [...this.docs]) doc.dispose();
    this.disposed = true;
  }

  private alive(): void {
    if (this.disposed) throw new InvalidArgumentError('Engine is disposed');
  }
}
