// Golden-image tooling: deterministic compare with tolerance, diff output for review.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pixelmatch from 'pixelmatch';
import type { RasterImage } from '@folio/ports';
import { decodePng, encodePng } from './oracles.ts';

export interface DiffResult {
  /** Fraction of pixels that differ (0–1). */
  ratio: number;
  diffPixels: number;
  sameSize: boolean;
  diff?: RasterImage;
}

/** Nearest-neighbour resample so renders from tools that round page sizes differently can be compared. */
export function resize(img: RasterImage, width: number, height: number): RasterImage {
  if (img.width === width && img.height === height) return img;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
      data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Composites onto white so transparent renders compare equal to opaque ones. */
export function flattenOnWhite(img: RasterImage): RasterImage {
  const data = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = img.data[i + 3]! / 255;
    data[i] = img.data[i]! * a + 255 * (1 - a);
    data[i + 1] = img.data[i + 1]! * a + 255 * (1 - a);
    data[i + 2] = img.data[i + 2]! * a + 255 * (1 - a);
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

export function diffImages(a: RasterImage, b: RasterImage, opts: { threshold?: number } = {}): DiffResult {
  const sameSize = Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
  if (!sameSize) return { ratio: 1, diffPixels: a.width * a.height, sameSize };
  const left = flattenOnWhite(a);
  const right = flattenOnWhite(resize(b, a.width, a.height));
  const diff = new Uint8ClampedArray(a.width * a.height * 4);
  const diffPixels = pixelmatch(left.data, right.data, diff, a.width, a.height, { threshold: opts.threshold ?? 0.2, includeAA: false });
  return { ratio: diffPixels / (a.width * a.height), diffPixels, sameSize, diff: { width: a.width, height: a.height, data: diff } };
}

/** Share of pixels that are not (near) white — a cheap "something was drawn here" probe. */
export function inkRatio(img: RasterImage, region?: { x: number; y: number; width: number; height: number }): number {
  const r = region ?? { x: 0, y: 0, width: img.width, height: img.height };
  let ink = 0;
  let total = 0;
  for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(img.height, Math.ceil(r.y + r.height)); y++) {
    for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(img.width, Math.ceil(r.x + r.width)); x++) {
      const o = (y * img.width + x) * 4;
      total++;
      if (img.data[o + 3]! > 16 && (img.data[o]! < 240 || img.data[o + 1]! < 240 || img.data[o + 2]! < 240)) ink++;
    }
  }
  return total ? ink / total : 0;
}
/** Average colour of a region. */
export function meanColor(img: RasterImage, region: { x: number; y: number; width: number; height: number }): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(img.height, Math.ceil(region.y + region.height)); y++) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(img.width, Math.ceil(region.x + region.width)); x++) {
      const o = (y * img.width + x) * 4;
      r += img.data[o]!;
      g += img.data[o + 1]!;
      b += img.data[o + 2]!;
      n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 255, g: 255, b: 255 };
}

/**
 * Compares against a stored golden PNG. With FOLIO_UPDATE_GOLDENS=1 (the explicit review step) the
 * golden is (re)written instead. A failing comparison writes `<golden>.actual.png` and `.diff.png`.
 */
export async function compareGolden(actual: RasterImage, goldenPath: string, tolerance = 0.002): Promise<{ pass: boolean; ratio: number; created: boolean }> {
  const update = process.env.FOLIO_UPDATE_GOLDENS === '1';
  let golden: RasterImage | null = null;
  try {
    golden = decodePng(await readFile(goldenPath));
  } catch {
    golden = null;
  }
  if (!golden || update) {
    if (!update && process.env.CI) return { pass: false, ratio: 1, created: false };
    await mkdir(dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, encodePng(flattenOnWhite(actual)));
    return { pass: true, ratio: 0, created: true };
  }
  const d = diffImages(golden, actual);
  const pass = d.sameSize && d.ratio <= tolerance;
  if (!pass) {
    const base = goldenPath.replace(/\.png$/, '');
    await mkdir(`${dirname(goldenPath)}/__diff__`, { recursive: true });
    const out = `${dirname(goldenPath)}/__diff__/${base.split('/').pop()}`;
    await writeFile(`${out}.actual.png`, encodePng(actual));
    if (d.diff) await writeFile(`${out}.diff.png`, encodePng(d.diff));
  }
  return { pass, ratio: d.ratio, created: false };
}
