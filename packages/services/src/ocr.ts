import { CancelledError, InvalidArgumentError, IoError, applyToPoint, isFolioError, throwIfAborted, toHex, viewToPageMatrix, type Command } from '@folio/core';
import type {
  AiProvider,
  AppStorage,
  CryptoService,
  Downloader,
  ImageCodec,
  OcrEngine,
  OcrLanguageInfo,
  OcrLayerWord,
  OcrLine,
  OcrPageResult,
  PageIndex,
  PdfDocument,
} from '@folio/ports';
import { checkpointCommand, label } from './commands.ts';

// ---- language packs (FR-OCR-02) ----------------------------------------------------------------

/** One entry of the manifest bundled with the app. Only these URLs and hashes are ever accepted. */
export interface OcrLanguagePack extends OcrLanguageInfo {
  /** Fixed, versioned address; absent for languages that ship with the app. */
  url?: string;
  /** Lower-case hex SHA-256 of the file as served. */
  sha256: string;
}
const FAST = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0';
/** English and Italian are in the installer; the others come from a pinned tessdata_fast release. */
export const OCR_LANGUAGES: OcrLanguagePack[] = [
  { code: 'eng', name: 'English', size: 2_952_873, bundled: true, sha256: '' },
  { code: 'ita', name: 'Italiano', size: 1_660_998, bundled: true, sha256: '' },
  { code: 'deu', name: 'Deutsch', size: 1_525_436, bundled: false, url: `${FAST}/deu.traineddata`, sha256: '19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d' },
  { code: 'fra', name: 'Français', size: 1_130_365, bundled: false, url: `${FAST}/fra.traineddata`, sha256: 'ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca' },
  { code: 'spa', name: 'Español', size: 2_294_433, bundled: false, url: `${FAST}/spa.traineddata`, sha256: '6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464' },
  { code: 'por', name: 'Português', size: 1_982_756, bundled: false, url: `${FAST}/por.traineddata`, sha256: 'c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb' },
  { code: 'nld', name: 'Nederlands', size: 6_050_296, bundled: false, url: `${FAST}/nld.traineddata`, sha256: 'ced0e5e046a84c908a6aa7accbef9a232c4a5d9a8276691b81c6ee64d02963f6' },
  { code: 'pol', name: 'Polski', size: 4_765_518, bundled: false, url: `${FAST}/pol.traineddata`, sha256: 'c4476cdbc0e33d898d32345122b7be1cbf85ace15f920f06c7714756e1ef79b2' },
];
/** Hosts a pack may be downloaded from; the Rust side enforces the same list. */
export const OCR_DOWNLOAD_HOSTS = ['raw.githubusercontent.com'];

export const MAX_OCR_LANGUAGES = 3;
const KEY = (code: string): string => `ocr/lang/${code}.traineddata`;

/**
 * Where the data of each language comes from: bundled (same origin / installer), or downloaded after
 * confirmation and kept in the app storage, verified again on every load. Nothing downloads by itself.
 */
export class OcrLanguageRepo {
  constructor(
    private readonly deps: {
      storage: AppStorage;
      crypto: CryptoService;
      downloader?: Downloader;
      /** Reads the data of a language that ships with the app. */
      bundled: (code: string) => Promise<Uint8Array>;
      manifest?: OcrLanguagePack[];
    },
  ) {}
  private get manifest(): OcrLanguagePack[] {
    return this.deps.manifest ?? OCR_LANGUAGES;
  }
  pack(code: string): OcrLanguagePack | undefined {
    return this.manifest.find((p) => p.code === code);
  }
  private async verified(pack: OcrLanguagePack): Promise<Uint8Array | null> {
    const data = await this.deps.storage.read(KEY(pack.code));
    if (!data) return null;
    if (toHex(await this.deps.crypto.sha256(data)) !== pack.sha256) {
      // Damaged or replaced in the cache: never used, and removed so a fresh download is offered.
      await this.deps.storage.remove(KEY(pack.code));
      return null;
    }
    return data;
  }
  async isInstalled(code: string): Promise<boolean> {
    const pack = this.pack(code);
    if (!pack) return false;
    return pack.bundled || (await this.verified(pack)) !== null;
  }
  /** Every language with whether it can be used now. */
  async list(): Promise<Array<OcrLanguagePack & { installed: boolean }>> {
    return Promise.all(this.manifest.map(async (p) => ({ ...p, installed: await this.isInstalled(p.code) })));
  }
  /** Data for the engine. @throws InvalidArgumentError('ocrLanguageMissing') for a language not installed. */
  async data(code: string): Promise<Uint8Array> {
    const pack = this.pack(code);
    if (!pack) throw new InvalidArgumentError(`Unknown OCR language "${code}"`, { reason: 'ocrLanguageUnknown', code });
    if (pack.bundled) return this.deps.bundled(code);
    const data = await this.verified(pack);
    if (!data) throw new InvalidArgumentError(`The OCR language "${code}" is not installed`, { reason: 'ocrLanguageMissing', code });
    return data;
  }
  /**
   * Downloads a pack after the user confirmed its name and size. The file is checked against the bundled
   * hash before it is stored: a mismatch or a network error leaves nothing behind.
   */
  async install(code: string, opts: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {}): Promise<void> {
    const pack = this.pack(code);
    if (!pack || pack.bundled || !pack.url) throw new InvalidArgumentError(`Nothing to download for "${code}"`, { reason: 'ocrLanguageUnknown', code });
    const dl = this.deps.downloader;
    if (!dl) throw new InvalidArgumentError('Downloads are not available in this build', { reason: 'ocrNoDownloader' });
    const data = await dl.download({ url: pack.url, sha256: pack.sha256, maxBytes: Math.ceil(pack.size * 1.2) + 1024, signal: opts.signal, onProgress: opts.onProgress });
    // Defence in depth: the adapter verifies too, the repo never trusts it.
    if (toHex(await this.deps.crypto.sha256(data)) !== pack.sha256) throw new IoError('checksum');
    await this.deps.storage.write(KEY(code), data);
  }
  async remove(code: string): Promise<void> {
    const pack = this.pack(code);
    if (pack && !pack.bundled) await this.deps.storage.remove(KEY(code));
  }
  /** At most three, in the given order, each known; used by the dialog before running. */
  validate(codes: string[]): string[] {
    const list = [...new Set(codes)];
    const unknown = list.find((c) => !this.pack(c));
    if (unknown) throw new InvalidArgumentError(`Unknown OCR language "${unknown}"`, { reason: 'ocrLanguageUnknown', code: unknown });
    if (list.length === 0 || list.length > MAX_OCR_LANGUAGES) throw new InvalidArgumentError('Choose one to three OCR languages', { reason: 'ocrLanguages' });
    return list;
  }
  /** Languages the user asked for that still need a download (the dialog confirms them first). */
  async missing(codes: string[]): Promise<OcrLanguagePack[]> {
    const out: OcrLanguagePack[] = [];
    for (const c of codes) {
      const p = this.pack(c);
      if (p && !(await this.isInstalled(c))) out.push(p);
    }
    return out;
  }
}

/** UI language → OCR language: English by default, Italian suggested because it is bundled. */
export function defaultOcrLanguages(uiLanguage: string, last: string[] | undefined): string[] {
  if (last && last.length > 0) return last.slice(0, MAX_OCR_LANGUAGES);
  const map: Record<string, string> = { en: 'eng', it: 'ita', de: 'deu', fr: 'fra', es: 'spa', pt: 'por', nl: 'nld', pl: 'pol' };
  return [map[uiLanguage.split('-')[0]!.toLowerCase()] ?? 'eng'];
}

// ---- recognition and the invisible layer (FR-OCR-01, FR-OCR-03, FR-OCR-09) --------------------

/** Resolution pages are rendered at for recognition. */
export const OCR_DPI = 300;
/** Pages whose mean word confidence is below this offer "Retry with AI". */
export const LOW_OCR_CONFIDENCE = 70;
const MAX_SIDE = 8000;

export type OcrPageStatus = 'done' | 'skippedText' | 'skippedLayer' | 'empty' | 'failed' | 'cancelled';
export interface OcrPageOutcome {
  page: PageIndex;
  status: OcrPageStatus;
  words: number;
  /** Mean word confidence, 0–100 (the AI path reports its own). */
  confidence: number;
  /** Words that needed a base letter because the font lacks the glyph. */
  substituted: number;
  engine: 'local' | 'ai';
}
export interface OcrRun {
  outcomes: OcrPageOutcome[];
  cancelled: boolean;
}
export interface OcrOptions {
  pages: PageIndex[];
  languages: string[];
  engine: 'local' | 'ai';
  /** Replace the layer Folio made earlier (never third-party text). */
  redo?: boolean;
  signal?: AbortSignal;
  progress?: (done: number, total: number, page: PageIndex) => void;
}

/** Recognised lines of a page in user space, ready to write. */
export function layerWords(result: OcrPageResult | { lines: OcrLine[] }, info: Awaited<ReturnType<PdfDocument['getPageInfo']>>, pxPerPoint: number): OcrLayerWord[] {
  const toUser = viewToPageMatrix(info.size, info.rotation, 1);
  const out: OcrLayerWord[] = [];
  for (const line of result.lines) {
    for (const [n, w] of line.words.entries()) {
      const heightPt = (w.y1 - w.y0) / pxPerPoint;
      const next = line.words[n + 1];
      // Words are separate objects, so a trailing space keeps "two words" two words when the text is
      // searched or copied; the gap it leaves inside the word's box is what poppler uses to split words too.
      const widthPt = (w.x1 - w.x0) / pxPerPoint;
      if (!(heightPt > 0 && widthPt > 0) || w.text.trim() === '') continue;
      // Baseline start: left edge of the word box, a descender above its bottom edge, in the view shown.
      const p = applyToPoint(toUser, { x: w.x0 / pxPerPoint, y: w.y1 / pxPerPoint - heightPt * 0.2 });
      out.push({
        text: next ? `${w.text} ` : w.text,
        origin: { x: p.x + info.cropBox.x, y: p.y + info.cropBox.y },
        // A page shown rotated by r clockwise reads upright when its text runs at +r in user space.
        angle: info.rotation,
        width: widthPt,
        fontSize: Math.max(2, heightPt * 0.8),
      });
    }
  }
  return out;
}

/** Splits a transcribed line into words, sharing the line's width by character count. */
function wordsOfLine(text: string, box: [number, number, number, number], width: number, height: number, confidence: number): OcrLine {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1);
  const x0 = box[0] * width;
  const x1 = box[2] * width;
  const y0 = box[1] * height;
  const y1 = box[3] * height;
  let at = x0;
  const words = parts.map((p) => {
    const w = ((x1 - x0) * p.length) / total;
    const word = { text: p, x0: at, y0, x1: at + w, y1, confidence: confidence * 100 };
    at += w + ((x1 - x0) * 1) / total;
    return word;
  });
  return { text, words, x0, y0, x1, y1, confidence: confidence * 100 };
}

/** OCR: pages → recognition → invisible layer, as one undoable step (FR-OCR-01, FR-OCR-09). */
export class OcrService {
  constructor(private readonly deps: { engine?: OcrEngine; ai?: AiProvider; images: ImageCodec }) {}

  get localAvailable(): boolean {
    return !!this.deps.engine;
  }

  /** Which pages need work: pages with text of their own are skipped, pages with Folio's layer unless `redo`. */
  async plan(doc: PdfDocument, pages: PageIndex[], redo = false): Promise<{ todo: PageIndex[]; hasText: PageIndex[]; hasLayer: PageIndex[] }> {
    const todo: PageIndex[] = [];
    const hasText: PageIndex[] = [];
    const hasLayer: PageIndex[] = [];
    for (const p of pages) {
      const layer = await doc.hasOcrLayer(p);
      if (layer) {
        hasLayer.push(p);
        if (redo) todo.push(p);
        continue;
      }
      // Text objects that are not ours: an image-only page has none.
      const text = await doc.getTextLayer(p);
      if (!text.isScanned && text.runs.length > 0) hasText.push(p);
      else todo.push(p);
    }
    return { todo, hasText, hasLayer };
  }

  private async recognizeLocal(doc: PdfDocument, page: PageIndex, languages: string[], signal?: AbortSignal): Promise<{ result: OcrPageResult; pxPerPoint: number }> {
    if (!this.deps.engine) throw new InvalidArgumentError('Text recognition is not available in this build', { reason: 'ocrUnavailable' });
    const info = await doc.getPageInfo(page);
    const shown = info.rotation === 90 || info.rotation === 270 ? { width: info.size.height, height: info.size.width } : info.size;
    const pxPerPoint = Math.min(OCR_DPI / 72, MAX_SIDE / Math.max(shown.width, shown.height));
    const image = await doc.render(page, { scale: pxPerPoint, annotations: false, forms: false }, signal);
    return { result: await this.deps.engine.recognize(image, { languages, signal }), pxPerPoint };
  }
  private async recognizeAi(doc: PdfDocument, page: PageIndex, signal?: AbortSignal): Promise<{ result: OcrPageResult; pxPerPoint: number }> {
    const ai = this.deps.ai;
    if (!ai || !(await ai.isConfigured())) throw new InvalidArgumentError('AI is not set up', { reason: 'notConfigured' });
    const info = await doc.getPageInfo(page);
    const shown = info.rotation === 90 || info.rotation === 270 ? { width: info.size.height, height: info.size.width } : info.size;
    const pxPerPoint = Math.min(2, 1600 / Math.max(shown.width, shown.height));
    const image = await doc.render(page, { scale: pxPerPoint, annotations: false, forms: false }, signal);
    const jpeg = await this.deps.images.encode(image, 'jpeg', { quality: 0.85 });
    const out = await ai.recognizePage({ page, jpeg, width: image.width, height: image.height }, signal ?? new AbortController().signal);
    const lines = out.lines.map((l) => wordsOfLine(l.text, l.bbox, image.width, image.height, l.confidence));
    const all = lines.flatMap((l) => l.words);
    return {
      result: { width: image.width, height: image.height, lines, confidence: all.length ? all.reduce((n, w) => n + w.confidence, 0) / all.length : 0 },
      pxPerPoint,
    };
  }

  /**
   * Runs recognition inside one undoable command. Pages already finished stay when the run is cancelled
   * (and the step still undoes them all); a page is written whole or not at all. `onDone` receives the
   * outcome of every page, also when the command is later undone.
   */
  command(doc: PdfDocument, opts: OcrOptions, onDone: (run: OcrRun) => void): Command<OcrRun> {
    return checkpointCommand(
      label('cmd.ocr', { count: opts.pages.length }),
      'content',
      async ({ doc: target }) => {
        const run = await this.run(target, opts);
        if (run.cancelled && !run.outcomes.some((o) => o.status === 'done')) throw new CancelledError();
        onDone(run);
        return run;
      },
      { kind: 'all' },
    ) as Command<OcrRun>;
  }

  async run(doc: PdfDocument, opts: OcrOptions): Promise<OcrRun> {
    const { todo, hasText, hasLayer } = await this.plan(doc, opts.pages, !!opts.redo);
    const outcomes: OcrPageOutcome[] = [];
    const empty = (page: PageIndex, status: OcrPageStatus): OcrPageOutcome => ({ page, status, words: 0, confidence: 0, substituted: 0, engine: opts.engine });
    for (const p of hasText) outcomes.push(empty(p, 'skippedText'));
    for (const p of hasLayer) if (!todo.includes(p)) outcomes.push(empty(p, 'skippedLayer'));
    let cancelled = false;
    for (const [n, page] of todo.entries()) {
      if (opts.signal?.aborted) {
        cancelled = true;
        break;
      }
      opts.progress?.(n, todo.length, page);
      try {
        throwIfAborted(opts.signal);
        const { result, pxPerPoint } = opts.engine === 'ai' ? await this.recognizeAi(doc, page, opts.signal) : await this.recognizeLocal(doc, page, opts.languages, opts.signal);
        throwIfAborted(opts.signal);
        const info = await doc.getPageInfo(page);
        const words = layerWords(result, info, pxPerPoint);
        if (opts.redo) await doc.removeOcrLayer(page);
        const written = words.length ? await doc.addOcrLayer(page, words) : { written: 0, substituted: 0 };
        outcomes.push({ page, status: written.written ? 'done' : 'empty', words: written.written, confidence: result.confidence, substituted: written.substituted, engine: opts.engine });
      } catch (e) {
        if (isFolioError(e) && e.code === 'cancelled') {
          cancelled = true;
          break;
        }
        // One bad page does not lose the others: it is reported and the run goes on.
        outcomes.push(empty(page, 'failed'));
        if (!(isFolioError(e) && (e.code === 'ai' || e.code === 'network' || e.code === 'limitExceeded'))) throw e;
      }
    }
    opts.progress?.(todo.length, todo.length, todo[todo.length - 1] ?? 0);
    return { outcomes: outcomes.sort((a, b) => a.page - b.page), cancelled };
  }

  /** Pages the local engine was unsure about: offered "Retry with AI" (FR OCR with AI). */
  lowConfidence(run: OcrRun): PageIndex[] {
    return run.outcomes.filter((o) => o.engine === 'local' && o.status === 'done' && o.confidence < LOW_OCR_CONFIDENCE).map((o) => o.page);
  }
}
