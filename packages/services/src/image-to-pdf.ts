import { InvalidArgumentError, PAGE_SIZES, fitRect, throwIfAborted, type PageSizeName } from '@folio/core';
import type { ImageCodec, ImageSpec, PdfDocument, PdfEngine, Size } from '@folio/ports';

export interface ImagePageOptions {
  /** 'image' sizes each page to its picture (plus margins); otherwise a paper size. */
  pageSize: 'image' | PageSizeName;
  orientation: 'auto' | 'portrait' | 'landscape';
  /** fit = whole image visible, fill = page covered (cropped), original = pixel size at `dpi`. */
  fit: 'fit' | 'fill' | 'original';
  /** Margin in points on every side. */
  margin: number;
  /** Resolution assumed for 'original' and for 'image' page size. */
  dpi: number;
}
export const DEFAULT_IMAGE_PAGE: ImagePageOptions = { pageSize: 'A4', orientation: 'auto', fit: 'fit', margin: 36, dpi: 96 };
export const MARGIN_PRESETS = { none: 0, small: 18, normal: 36, large: 72 } as const;

export interface ImageInput {
  name: string;
  bytes: Uint8Array;
}
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'];
export const isImageName = (name: string): boolean => IMAGE_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e));

/** Page size and image rectangle for one picture. Pure layout, shared with previews. */
export function layoutImagePage(pixels: Size, o: ImagePageOptions): { page: Size; rect: { x: number; y: number; width: number; height: number } } {
  const natural = { width: (pixels.width * 72) / o.dpi, height: (pixels.height * 72) / o.dpi };
  if (o.pageSize === 'image') {
    return { page: { width: natural.width + 2 * o.margin, height: natural.height + 2 * o.margin }, rect: { x: o.margin, y: o.margin, ...natural } };
  }
  const base = PAGE_SIZES[o.pageSize];
  const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && pixels.width > pixels.height);
  const page = landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
  const margin = Math.min(o.margin, page.width / 2 - 1, page.height / 2 - 1);
  const frame = { x: margin, y: margin, width: page.width - 2 * margin, height: page.height - 2 * margin };
  const mode = o.fit === 'fit' ? 'contain' : o.fit === 'fill' ? 'cover' : 'original';
  return { page, rect: fitRect(natural, frame, mode) };
}

/** Images → one page each (FR-MRG-03, FR-OPT-03). */
export class ImageToPdfService {
  constructor(private readonly deps: { engine: PdfEngine; images: ImageCodec }) {}

  /** Appends one page per image to `doc`. JPEG data is embedded as is; other formats are re-encoded losslessly. */
  async appendTo(doc: PdfDocument, inputs: ImageInput[], options: Partial<ImagePageOptions> = {}, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void> {
    const o = { ...DEFAULT_IMAGE_PAGE, ...options };
    if (!(o.margin >= 0) || !(o.dpi > 0)) throw new InvalidArgumentError('Invalid image page options');
    for (let k = 0; k < inputs.length; k++) {
      throwIfAborted(signal);
      const input = inputs[k]!;
      let decoded;
      try {
        decoded = await this.deps.images.decode(input.bytes);
      } catch (e) {
        throw new InvalidArgumentError(`"${input.name}" is not a supported image`, { name: input.name, reason: 'badImage', detail: String(e) });
      }
      const { page, rect } = layoutImagePage(decoded, o);
      const at = doc.pageCount;
      await doc.insertBlank(at, page);
      const image: ImageSpec['image'] =
        decoded.format === 'jpeg' ? { jpeg: input.bytes, width: decoded.width, height: decoded.height } : { width: decoded.width, height: decoded.height, data: decoded.data };
      await doc.addImage(at, { image, rect });
      onProgress?.(k + 1, inputs.length);
    }
  }

  async create(inputs: ImageInput[], options: Partial<ImagePageOptions> = {}, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<PdfDocument> {
    if (inputs.length === 0) throw new InvalidArgumentError('No images selected');
    const doc = await this.deps.engine.create();
    try {
      await this.appendTo(doc, inputs, options, signal, onProgress);
    } catch (e) {
      doc.dispose();
      throw e;
    }
    return doc;
  }
}
