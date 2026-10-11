import { zipSync } from 'fflate';
import { InvalidArgumentError, UnsupportedFeatureError, rotatedSize, splitExt, throwIfAborted, type Command } from '@folio/core';
import type { ImageCodec, ImageFormat, PageIndex, PdfDocument, RasterImage, Rect } from '@folio/ports';
import { checkpointCommand, label } from './commands.ts';

export interface ImageExportOptions {
  format: ImageFormat;
  /** 72–600 */
  dpi: number;
  /** 0–1, JPEG and WebP only. */
  quality?: number;
}
export interface ExportedImage {
  name: string;
  bytes: Uint8Array;
  page: PageIndex;
  width: number;
  height: number;
}
const EXT: Record<ImageFormat, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' };

/** Pixel size of a page at `dpi`; also used for the size estimate in the export dialog. */
export async function exportPixelSize(doc: PdfDocument, page: PageIndex, dpi: number): Promise<{ width: number; height: number }> {
  const info = await doc.getPageInfo(page);
  const shown = rotatedSize(info.size, info.rotation);
  return { width: Math.max(1, Math.round((shown.width * dpi) / 72)), height: Math.max(1, Math.round((shown.height * dpi) / 72)) };
}

/** Pages → images, snapshots and flatten actions (FR-OPT-02/04/06). */
export class ExportService {
  constructor(private readonly images: ImageCodec) {}

  private check(o: ImageExportOptions): void {
    if (!(o.dpi >= 72 && o.dpi <= 600)) throw new InvalidArgumentError('Resolution must be between 72 and 600 DPI', { reason: 'dpi' });
    if (!this.images.supports(o.format)) throw new UnsupportedFeatureError('imageFormat', o.format);
    if (o.quality !== undefined && !(o.quality > 0 && o.quality <= 1)) throw new InvalidArgumentError('Quality must be between 0 and 1');
  }

  /** FR-OPT-02: renders the selected pages. Names are `<base>_p<page>.<ext>`, zero-padded. */
  async exportPages(doc: PdfDocument, pages: PageIndex[], o: ImageExportOptions, baseName: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<ExportedImage[]> {
    this.check(o);
    if (pages.length === 0) throw new InvalidArgumentError('No pages selected');
    const pad = String(doc.pageCount).length;
    const stem = splitExt(baseName)[0];
    const out: ExportedImage[] = [];
    for (let k = 0; k < pages.length; k++) {
      throwIfAborted(signal);
      const page = pages[k]!;
      const raster = await doc.render(page, { scale: o.dpi / 72 }, signal);
      const bytes = await this.images.encode(raster, o.format, { quality: o.quality });
      out.push({ name: `${stem}_p${String(page + 1).padStart(pad, '0')}${EXT[o.format]}`, bytes, page, width: raster.width, height: raster.height });
      onProgress?.(k + 1, pages.length);
    }
    return out;
  }

  /** Bundles exported images into one ZIP (stored, images are already compressed). */
  zip(images: ExportedImage[]): Uint8Array {
    const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (const img of images) entries[img.name] = [img.bytes, { level: 0 }];
    return zipSync(entries);
  }

  /** FR-OPT-04 snapshot: an area of a page (PDF user space) as an image, for the clipboard. */
  async snapshot(doc: PdfDocument, page: PageIndex, area: Rect, dpi = 144): Promise<RasterImage> {
    if (!(area.width > 0 && area.height > 0)) throw new InvalidArgumentError('Select an area first');
    const info = await doc.getPageInfo(page);
    if (info.rotation !== 0) {
      // Rotated pages: render whole, then crop in view space via the bounding box of the rotated area.
      const scale = dpi / 72;
      const full = await doc.render(page, { scale });
      const { pageToViewMatrix, applyToRect } = await import('@folio/core');
      const v = applyToRect(pageToViewMatrix(info.size, info.rotation, scale), area);
      return crop(full, v);
    }
    const scale = dpi / 72;
    const rect = { x: Math.round(area.x * scale), y: Math.round((info.size.height - area.y - area.height) * scale), width: Math.round(area.width * scale), height: Math.round(area.height * scale) };
    return doc.render(page, { scale, rect });
  }
  async snapshotPng(doc: PdfDocument, page: PageIndex, area: Rect, dpi = 144): Promise<Uint8Array> {
    return this.images.encode(await this.snapshot(doc, page, area, dpi), 'png');
  }

  /** FR-OPT-06 / FR-ANN-09 / FR-FRM-05: flatten annotations, form, or both, as one undoable step. */
  flatten(what: 'annotations' | 'form' | 'both', pages?: PageIndex[]): Command<void> {
    return checkpointCommand(label(`cmd.flatten.${what}`), 'content', async ({ doc }) => {
      if (what !== 'annotations') await doc.flattenForm();
      if (what !== 'form') await doc.flattenAnnotations(pages);
    });
  }

  /** "Export a flattened copy": the open document is left untouched. */
  async flattenedCopy(doc: PdfDocument, engine: { open(data: Uint8Array): Promise<PdfDocument> }, what: 'annotations' | 'form' | 'both' = 'both'): Promise<Uint8Array> {
    const copy = await engine.open(await doc.snapshot());
    try {
      if (what !== 'annotations') await copy.flattenForm();
      if (what !== 'form') await copy.flattenAnnotations();
      return await copy.save();
    } finally {
      copy.dispose();
    }
  }
}

export function crop(img: RasterImage, r: { x: number; y: number; width: number; height: number }): RasterImage {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const width = Math.max(1, Math.min(img.width - x0, Math.round(r.width)));
  const height = Math.max(1, Math.min(img.height - y0, Math.round(r.height)));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + width) * 4), y * width * 4);
  return { width, height, data };
}
