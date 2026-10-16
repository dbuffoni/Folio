// OcrEngine adapter: Tesseract compiled to WebAssembly through tesseract.js (FR-OCR-01, FR-OCR-03).
// The worker, the core and the language data are supplied by the caller, so nothing is ever fetched
// from a third-party CDN (the tesseract.js default) and no network call happens by default.
import { CancelledError, InvalidArgumentError, LimitExceededError } from '@folio/core';
import type { OcrEngine, OcrLine, OcrPageResult, OcrWord, RasterImage } from '@folio/ports';
import { createWorker, type Worker } from 'tesseract.js';

export interface TesseractOptions {
  /** Traineddata of a Tesseract language code ("eng"); gzip is detected and expanded by the worker. */
  languageData(code: string): Promise<Uint8Array>;
  /** Encodes a raster as PNG (the worker takes encoded images). */
  encode(image: RasterImage): Promise<Uint8Array>;
  /**
   * Makes the data of a language readable by the worker through tesseract.js' cache (a file in `cachePath`
   * on Node, an IndexedDB entry in the browser). The worker is never given a URL to fetch from.
   */
  stageLanguage(code: string, data: Uint8Array): Promise<void>;
  /** Directory the Node worker reads staged data from; ignored in the browser. */
  cachePath?: string;
  /** URL or path of the tesseract.js worker script; the library default is a CDN and is never used. */
  workerPath?: string;
  /** URL or directory holding the `tesseract-core-*.wasm.js` files. */
  corePath?: string;
  /** Largest side of an image the worker is given. */
  maxSide?: number;
}

/** Languages per run: more than three degrade accuracy and speed (FR-OCR-06). */
export const MAX_LANGUAGES = 3;
const CODE = /^[a-z]{3}(_[a-z]+)?$/i;

interface RawWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface RawLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  words: RawWord[];
}
interface RawPage {
  blocks?: Array<{ paragraphs: Array<{ lines: RawLine[] }> }> | null;
}

export class TesseractOcrEngine implements OcrEngine {
  private worker: Worker | null = null;
  private key = '';
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly opts: TesseractOptions) {}

  private async workerFor(languages: string[]): Promise<Worker> {
    const key = languages.join('+');
    if (this.worker && this.key === key) return this.worker;
    await this.stop();
    // Staged data is found in the cache, so the worker never goes to the network for it.
    for (const code of languages) await this.opts.stageLanguage(code, await this.opts.languageData(code));
    const { workerPath, corePath, cachePath } = this.opts;
    const worker = await createWorker(languages, 1, {
      ...(workerPath ? { workerPath } : {}),
      ...(corePath ? { corePath } : {}),
      ...(cachePath ? { cachePath } : {}),
      cacheMethod: 'readOnly',
      // A worker loaded from its own URL: no blob workers, which the desktop CSP does not allow.
      workerBlobURL: false,
      gzip: false,
      logger: () => undefined,
      errorHandler: () => undefined,
    });
    this.worker = worker;
    this.key = key;
    return worker;
  }
  private async stop(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.key = '';
    if (w) await w.terminate().catch(() => undefined);
  }

  async recognize(image: RasterImage, opts: { languages: string[]; signal?: AbortSignal }): Promise<OcrPageResult> {
    const languages = [...new Set(opts.languages)];
    if (languages.length === 0 || languages.length > MAX_LANGUAGES || !languages.every((c) => CODE.test(c)))
      throw new InvalidArgumentError('Choose one to three OCR languages', { reason: 'ocrLanguages' });
    const side = Math.max(image.width, image.height);
    if (side > (this.opts.maxSide ?? 10_000)) throw new LimitExceededError('bitmapSize', `${image.width}×${image.height}`);
    // One page at a time: the worker is a single WebAssembly instance.
    const run = this.queue.then(() => this.runOne(image, languages, opts.signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runOne(image: RasterImage, languages: string[], signal?: AbortSignal): Promise<OcrPageResult> {
    if (signal?.aborted) throw new CancelledError();
    const worker = await this.workerFor(languages);
    const png = await this.opts.encode(image);
    // tesseract.js cannot cancel a running job: abort ends the worker, the next page starts a new one.
    const onAbort = (): void => void this.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const out = await worker.recognize(png as unknown as Buffer, {}, { blocks: true });
      if (signal?.aborted) throw new CancelledError();
      return toResult(out.data as unknown as RawPage, image);
    } catch (e) {
      if (signal?.aborted) throw new CancelledError();
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async dispose(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.stop();
  }
}

function toResult(data: RawPage, image: RasterImage): OcrPageResult {
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? [])
    for (const para of block.paragraphs ?? [])
      for (const l of para.lines ?? []) {
        const words: OcrWord[] = (l.words ?? [])
          .filter((w) => w.text.trim() !== '')
          .map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, confidence: w.confidence }));
        if (words.length === 0) continue;
        lines.push({ text: words.map((w) => w.text).join(' '), words, x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1, confidence: l.confidence });
      }
  const all = lines.flatMap((l) => l.words);
  const confidence = all.length ? all.reduce((n, w) => n + w.confidence, 0) / all.length : 0;
  return { width: image.width, height: image.height, lines, confidence };
}
