import { InvalidArgumentError, isFolioError, parsePageRanges, splitExt, throwIfAborted } from '@folio/core';
import type { ImageCodec, OutlineNode, PageIndex, PdfDocument, PdfEngine } from '@folio/ports';
import { ImageToPdfService, isImageName, type ImagePageOptions } from './image-to-pdf.ts';

export interface MergeSource {
  name: string;
  bytes: Uint8Array;
  /** Page range expression such as "1-3,7,10-"; empty = all pages. Ignored for images. */
  range?: string;
  password?: string;
  /** Modification time for "sort by date". */
  modified?: number;
}
export interface MergeOptions {
  /** One bookmark per source file, with the file's own outline nested under it (FR-MRG-02). */
  bookmarks: boolean;
  /** Keep AcroForm fields working; colliding names are renamed. false = fields become static content. */
  keepFormFields: boolean;
  image: Partial<ImagePageOptions>;
}
export const DEFAULT_MERGE: MergeOptions = { bookmarks: true, keepFormFields: true, image: {} };

export interface MergeItemInfo {
  name: string;
  kind: 'pdf' | 'image';
  /** Pages this item contributes with its current range. */
  pageCount: number;
  totalPages: number;
  /** Problem that excludes the item until fixed (inline warning chip in the dialog). */
  problem?: 'passwordRequired' | 'wrongPassword' | 'invalid' | 'empty' | 'badRange';
}

export function sortSources<T extends { name: string; modified?: number }>(items: readonly T[], by: 'name' | 'date'): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => (by === 'name' ? collator.compare(a.name, b.name) : (a.modified ?? 0) - (b.modified ?? 0) || collator.compare(a.name, b.name)));
}

function remapOutline(nodes: OutlineNode[], map: Map<PageIndex, PageIndex>): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    const children = remapOutline(n.children, map);
    if (n.target?.kind === 'page') {
      const page = map.get(n.target.page);
      // A bookmark whose page was not included survives only as a group for its included children.
      if (page === undefined) {
        if (children.length) out.push({ title: n.title, target: children[0]!.target, children });
        continue;
      }
      out.push({ title: n.title, target: { kind: 'page', page }, children });
    } else {
      out.push({ title: n.title, target: n.target, children });
    }
  }
  return out;
}

/** Merge PDFs and images (FR-MRG-01/02/03). Source bytes are never modified. */
export class MergeService {
  private readonly images: ImageToPdfService;
  constructor(private readonly deps: { engine: PdfEngine; images: ImageCodec }) {
    this.images = new ImageToPdfService(deps);
  }

  /** Inspects one source for the file list: page counts, range validity, password and corruption problems. */
  async inspect(source: MergeSource): Promise<MergeItemInfo> {
    if (isImageName(source.name)) {
      try {
        await this.deps.images.decode(source.bytes);
        return { name: source.name, kind: 'image', pageCount: 1, totalPages: 1 };
      } catch {
        return { name: source.name, kind: 'image', pageCount: 0, totalPages: 0, problem: 'invalid' };
      }
    }
    let doc: PdfDocument | undefined;
    try {
      doc = await this.deps.engine.open(source.bytes, { password: source.password });
      const total = doc.pageCount;
      if (total === 0) return { name: source.name, kind: 'pdf', pageCount: 0, totalPages: 0, problem: 'empty' };
      try {
        return { name: source.name, kind: 'pdf', pageCount: parsePageRanges(source.range ?? '', total).length, totalPages: total };
      } catch {
        return { name: source.name, kind: 'pdf', pageCount: 0, totalPages: total, problem: 'badRange' };
      }
    } catch (e) {
      const code = isFolioError(e) ? e.code : 'invalidPdf';
      const problem = code === 'passwordRequired' ? 'passwordRequired' : code === 'wrongPassword' ? 'wrongPassword' : 'invalid';
      return { name: source.name, kind: 'pdf', pageCount: 0, totalPages: 0, problem };
    } finally {
      doc?.dispose();
    }
  }

  /**
   * Builds the merged document. Throws on the first unusable source; call `inspect` first to exclude
   * problem items (the dialog does).
   */
  async merge(sources: MergeSource[], options: Partial<MergeOptions> = {}, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<PdfDocument> {
    const o = { ...DEFAULT_MERGE, ...options };
    if (sources.length === 0) throw new InvalidArgumentError('Nothing to merge');
    const out = await this.deps.engine.create();
    const outline: OutlineNode[] = [];
    try {
      for (let k = 0; k < sources.length; k++) {
        throwIfAborted(signal);
        const source = sources[k]!;
        const start = out.pageCount;
        const title = splitExt(source.name)[0];
        if (isImageName(source.name)) {
          await this.images.appendTo(out, [{ name: source.name, bytes: source.bytes }], o.image, signal);
          if (o.bookmarks) outline.push({ title, target: { kind: 'page', page: start }, children: [] });
        } else {
          const doc = await this.deps.engine.open(source.bytes, { password: source.password });
          try {
            const pages = parsePageRanges(source.range ?? '', doc.pageCount);
            if (pages.length === 0) throw new InvalidArgumentError(`"${source.name}" has no pages`, { name: source.name });
            if (!o.keepFormFields && (await doc.getMeta()).hasAcroForm) await doc.flattenForm();
            await out.importPages(doc, pages, start);
            if (o.bookmarks) {
              const map = new Map<PageIndex, PageIndex>();
              pages.forEach((p, n) => {
                if (!map.has(p)) map.set(p, start + n);
              });
              outline.push({ title, target: { kind: 'page', page: start }, children: remapOutline(await doc.getOutline(), map) });
            }
          } finally {
            doc.dispose();
          }
        }
        onProgress?.(k + 1, sources.length);
      }
      if (o.bookmarks) await out.setOutline(outline);
    } catch (e) {
      out.dispose();
      throw e;
    }
    return out;
  }
}
