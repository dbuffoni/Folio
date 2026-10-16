import type { RasterImage } from './engine.ts';

/** One recognised word; the box is in pixels of the image that was recognised (origin top-left). */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0–100. */
  confidence: number;
}
export interface OcrLine {
  text: string;
  words: OcrWord[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}
export interface OcrPageResult {
  /** Size of the recognised image in pixels. */
  width: number;
  height: number;
  lines: OcrLine[];
  /** Mean word confidence, 0–100; 0 when nothing was recognised. */
  confidence: number;
}

/**
 * Optical character recognition that runs on this device (FR-OCR-01, FR-OCR-03). Behind a port so the
 * services never know which engine (Tesseract compiled to WebAssembly today) or which thread it runs on.
 */
export interface OcrEngine {
  /**
   * @param languages Tesseract codes in priority order, e.g. `["eng", "ita"]` (at most three).
   * @throws CancelledError when `signal` aborts, LimitExceededError for an image that is too large.
   */
  recognize(image: RasterImage, opts: { languages: string[]; signal?: AbortSignal }): Promise<OcrPageResult>;
  dispose(): Promise<void>;
}

/** A language the user can pick; `bundled` ones ship with the app, the others are downloaded on request. */
export interface OcrLanguageInfo {
  /** Tesseract code: `eng`, `ita`, `deu`… */
  code: string;
  name: string;
  /** Size of the data in bytes (shown before downloading). */
  size: number;
  bundled: boolean;
}

/** Downloads a file from a host on a fixed allow-list and verifies it (FR-OCR-02). */
export interface Downloader {
  /**
   * @throws NetworkError (offline, HTTP error), InvalidArgumentError (host not allowed),
   *   IoError('checksum') when the SHA-256 differs from `sha256`: nothing is returned or kept.
   */
  download(req: {
    url: string;
    sha256: string;
    maxBytes: number;
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
  }): Promise<Uint8Array>;
}
