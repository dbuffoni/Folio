import { InvalidArgumentError, throwIfAborted } from '@folio/core';
import type { ImageCodec, PageIndex, PdfDocument, PdfEngine, RasterImage } from '@folio/ports';

// FR-OPT-01 Reduce file size. Only image XObjects are touched; text and vector content are never
// rasterised (FR-OPT-09). The operation always works on a copy of the document, so it never enters the
// undo history and never changes the open file (FR-OPT-11 for signed files).

export type CompressPreset = 'light' | 'balanced' | 'strong' | 'custom';
export interface CompressSettings {
  /** Target resolution for colour images, in dots per inch. */
  colorDpi: number;
  /** Target resolution for grey-scale images. */
  grayDpi: number;
  /** JPEG quality, 0.3–0.95. */
  jpegQuality: number;
}
export const COMPRESS_PRESETS: Record<Exclude<CompressPreset, 'custom'>, CompressSettings> = {
  light: { colorDpi: 200, grayDpi: 200, jpegQuality: 0.85 },
  balanced: { colorDpi: 150, grayDpi: 150, jpegQuality: 0.7 },
  strong: { colorDpi: 96, grayDpi: 96, jpegQuality: 0.5 },
};
/** An image is re-encoded only when that saves more than this share of its stored size. */
export const MIN_IMAGE_SAVING = 0.1;
/** An image counts as "above target" only beyond this margin (resampling noise is not worth a rewrite). */
const DPI_MARGIN = 1.05;
/** The estimate looks at this many of the largest images. */
const SAMPLE = 8;

export interface ImageEntry {
  page: PageIndex;
  id: string;
  width: number;
  height: number;
  /**
   * Effective resolution of the image where it is drawn largest (the lowest value among its uses): that
   * use decides how many pixels the image must keep.
   */
  dpi: number;
  bytes: number;
  filters: string[];
  /** Same stored image drawn more than once. */
  uses: number;
  /** Every place the image is drawn, the first one included. */
  places: Array<{ page: PageIndex; id: string }>;
  /** Why the image is left alone in this release, if it is. */
  skip?: 'mask' | 'oneBit' | 'transparent' | 'tiny';
}
export interface CompressAnalysis {
  images: ImageEntry[];
  imageBytes: number;
  /** Saved size of a lossless-only rewrite, measured. */
  losslessBytes: number;
}
export interface CompressResult {
  /** Null when the result would not be smaller: nothing is written. */
  bytes: Uint8Array | null;
  before: number;
  after: number;
  /** Fraction saved, 0–1 (0 when nothing was gained). */
  saved: number;
  replaced: number;
  skipped: number;
  warnings: Array<'signed' | 'encrypted'>;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export function normalizeSettings(s: CompressSettings): CompressSettings {
  return {
    colorDpi: Math.round(clamp(s.colorDpi, 36, 600)),
    grayDpi: Math.round(clamp(s.grayDpi, 36, 600)),
    jpegQuality: Math.round(clamp(s.jpegQuality, 0.3, 0.95) * 100) / 100,
  };
}

/** Area-average resampling (antialiased) of an RGBA raster. Never upsamples. */
export function downsample(img: { width: number; height: number; data: Uint8ClampedArray }, width: number, height: number): RasterImage {
  const w = Math.max(1, Math.min(width, img.width));
  const h = Math.max(1, Math.min(height, img.height));
  if (w === img.width && h === img.height) return { width: w, height: h, data: img.data };
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          a += img.data[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}
const isGray = (img: RasterImage): boolean => {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - d[i + 1]!) > 2 || Math.abs(d[i + 1]! - d[i + 2]!) > 2) return false;
  return true;
};
const hasAlpha = (img: RasterImage): boolean => {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 255) return true;
  return false;
};

export class CompressService {
  constructor(private readonly deps: { engine: PdfEngine; images: ImageCodec }) {}

  /** Signed files are never overwritten (FR-OPT-11); a copy is allowed and its signatures show as invalidated. */
  canReplace(meta: { hasSignatures: boolean }): boolean {
    return !meta.hasSignatures;
  }

  /** Images of the document with their effective resolution (highest among identical images). */
  async images(doc: PdfDocument, signal?: AbortSignal): Promise<ImageEntry[]> {
    const groups = new Map<string, ImageEntry>();
    for (let p = 0; p < doc.pageCount; p++) {
      throwIfAborted(signal);
      for (const o of await doc.listObjects(p)) {
        if (o.type !== 'image' || !o.imageSize || !o.imageInfo) continue;
        // Width of the drawn image along its own x axis (matrix column), in inches.
        const drawn = Math.hypot(o.matrix[0], o.matrix[1]) || o.bounds.width;
        const dpi = drawn > 0 ? o.imageSize.width / (drawn / 72) : Infinity;
        const key = `${o.imageSize.width}x${o.imageSize.height}:${o.imageInfo.byteSize}:${o.imageInfo.filters.join(',')}`;
        const known = groups.get(key);
        if (known) {
          known.uses++;
          known.places.push({ page: p, id: o.id });
          known.dpi = Math.min(known.dpi, dpi);
          continue;
        }
        groups.set(key, {
          page: p,
          id: o.id,
          width: o.imageSize.width,
          height: o.imageSize.height,
          dpi,
          bytes: o.imageInfo.byteSize,
          filters: o.imageInfo.filters,
          uses: 1,
          places: [{ page: p, id: o.id }],
          skip: o.imageInfo.bitsPerPixel === 1 ? 'oneBit' : o.imageSize.width * o.imageSize.height < 64 * 64 ? 'tiny' : undefined,
        });
      }
    }
    return [...groups.values()];
  }

  /** Decides and encodes one image; null leaves it as it is. */
  private async plan(doc: PdfDocument, e: ImageEntry, s: CompressSettings): Promise<{ jpeg: Uint8Array; width: number; height: number; saving: number } | null> {
    if (e.skip) return null;
    const src = await doc.getImage(e.page, e.id);
    // Transparency (SMask) and masks are left untouched in this release.
    if (hasAlpha(src)) {
      e.skip = 'transparent';
      return null;
    }
    const target = isGray(src) ? s.grayDpi : s.colorDpi;
    const scale = e.dpi > target * DPI_MARGIN ? target / e.dpi : 1;
    const out = scale < 1 ? downsample(src, Math.round(src.width * scale), Math.round(src.height * scale)) : src;
    const jpeg = await this.deps.images.encode(out, 'jpeg', { quality: s.jpegQuality });
    // The stored image is shared by its uses; after replacing, each use carries its own copy.
    const saving = 1 - (jpeg.length * e.uses) / e.bytes;
    if (saving <= MIN_IMAGE_SAVING) return null;
    return { jpeg, width: out.width, height: out.height, saving };
  }

  /** Measured analysis: images and what a lossless-only rewrite saves. */
  async analyze(doc: PdfDocument, byteSize: number, signal?: AbortSignal): Promise<CompressAnalysis> {
    const images = await this.images(doc, signal);
    const lossless = (await doc.save({ compact: true })).length;
    return { images, imageBytes: images.reduce((n, i) => n + i.bytes, 0), losslessBytes: Math.min(lossless, byteSize) };
  }

  /**
   * Estimated size for settings: the lossless result, minus the saving measured by really encoding the
   * largest images and extrapolating to the rest (FR-OPT-01 step 2).
   */
  async estimate(doc: PdfDocument, analysis: CompressAnalysis, settings: CompressSettings, signal?: AbortSignal): Promise<number> {
    const s = normalizeSettings(settings);
    const eligible = analysis.images.filter((i) => !i.skip).sort((a, b) => b.bytes - a.bytes);
    const sample = eligible.slice(0, SAMPLE);
    let sampleBytes = 0;
    let sampleSaved = 0;
    for (const e of sample) {
      throwIfAborted(signal);
      const plan = await this.plan(doc, { ...e }, s);
      sampleBytes += e.bytes;
      if (plan) sampleSaved += e.bytes - plan.jpeg.length * e.uses;
    }
    const eligibleBytes = eligible.reduce((n, i) => n + i.bytes, 0);
    const ratio = sampleBytes > 0 ? sampleSaved / sampleBytes : 0;
    return Math.max(1, Math.round(analysis.losslessBytes - ratio * eligibleBytes));
  }

  /**
   * Compresses a copy of `doc`. Resolves with `bytes: null` when the result is not smaller. The
   * original document, its history and its file are never touched.
   */
  async run(
    doc: PdfDocument,
    settings: CompressSettings,
    opts: { originalBytes: number; password?: string; signal?: AbortSignal; progress?: (done: number, total: number) => void },
  ): Promise<CompressResult> {
    const s = normalizeSettings(settings);
    const meta = await doc.getMeta();
    const warnings: CompressResult['warnings'] = [];
    if (meta.hasSignatures) warnings.push('signed');
    if (meta.isEncrypted) warnings.push('encrypted');
    throwIfAborted(opts.signal);
    // The working copy: an encrypted file is reopened with the password the session already has.
    const copy = await this.deps.engine.open(await doc.save(), { password: opts.password });
    try {
      const images = await this.images(copy, opts.signal);
      let replaced = 0;
      let skipped = 0;
      for (const [n, e] of images.entries()) {
        throwIfAborted(opts.signal);
        opts.progress?.(n, images.length);
        const plan = await this.plan(copy, e, s);
        if (!plan) {
          skipped++;
          continue;
        }
        // Every use of the stored image gets the new data. PDFium shares one image between its uses, so
        // the places are the ones recorded before the first replacement.
        for (const place of e.places) await copy.replaceImage(place.page, place.id, { jpeg: plan.jpeg, width: plan.width, height: plan.height });
        replaced++;
      }
      opts.progress?.(images.length, images.length);
      throwIfAborted(opts.signal);
      const bytes = await copy.save({ compact: true });
      // Verify: same pages, first page renders.
      const check = await this.deps.engine.open(bytes, { password: opts.password });
      try {
        if (check.pageCount !== doc.pageCount) throw new InvalidArgumentError('The compressed file has a different page count');
        if (check.pageCount > 0) await check.render(0, { scale: 0.1 });
      } finally {
        check.dispose();
      }
      if (bytes.length >= opts.originalBytes) return { bytes: null, before: opts.originalBytes, after: opts.originalBytes, saved: 0, replaced, skipped, warnings };
      return { bytes, before: opts.originalBytes, after: bytes.length, saved: 1 - bytes.length / opts.originalBytes, replaced, skipped, warnings };
    } finally {
      copy.dispose();
    }
  }

  /** Suggested file name for the copy: `name-compressed.pdf`. */
  copyName(name: string): string {
    const m = /^(.*?)(\.pdf)?$/i.exec(name)!;
    return `${m[1]}-compressed.pdf`;
  }
}
