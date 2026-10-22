import { bboxToUserRect, intersect, isFolioError, AiError, InvalidArgumentError, LimitExceededError, NetworkError } from '@folio/core';
import type { AiProvider, FormAnalysisRequest, FormFieldType, ImageCodec, OcrEngine, PageIndex, PdfDocument, Rect } from '@folio/ports';
import { detectAreas, type DetectedArea } from './form.ts';
import { blankShapes, detectScanAreas } from './scan-fields.ts';
import { ocrTextLayer, scanShapeObjects } from './scan-ocr.ts';

/** A field Folio proposes to create (FR-FRM-08 "Detect fields"). */
export interface FieldProposal {
  /** `p{page}-d{n}`, 1-based page. */
  id: string;
  page: PageIndex;
  /** PDF user space. */
  rect: Rect;
  type: Extract<FormFieldType, 'text' | 'checkbox'>;
  multiline?: boolean;
  /** Comb cells, when the area is a row of equal boxes. */
  cells?: number;
  /** Printed line the text should stand on (ruled lines and leaders). */
  lineY?: number;
  label?: string;
  confidence: number;
  source: 'local' | 'ai';
  /** Low-confidence proposals start unticked. */
  accepted: boolean;
}
export type DetectionNotice =
  /** A scanned page and no way to see it: draw the fields by hand. */
  | 'scanNeedsAi'
  | 'aiFailed'
  | 'visionOff'
  /** A scan read from its image alone: shapes were found, not understood. */
  | 'scanLocal'
  /** A scan read with OCR on this device: lines, boxes and the words that name them (informational). */
  | 'scanOcr'
  /** Nothing that looks like a field was found. */
  | 'none';
/** What the on-device OCR needs to read a picture-only page. */
export interface OcrDetectOptions {
  /** Tesseract codes in priority order (the user's OCR languages). */
  languages: string[];
  signal?: AbortSignal;
}
export interface DetectionResult {
  proposals: FieldProposal[];
  usedAi: boolean;
  notice?: DetectionNotice;
}

/** Proposals with a confidence below this start unticked. */
export const LOW_CONFIDENCE = 0.6;
/** Detected fields keep the 0.8 confidence cap of Smart Fill. */
export const CONFIDENCE_CAP = 0.8;
const OVERLAP = 0.5;
/** Shapes read from an image are plausible, not certain. */
const SCAN_CONFIDENCE = 0.65;
/** Resolution a scan is read at for detection: enough for 10 pt print, quick enough to wait for. */
const DETECT_DPI = 200;
const DETECT_MAX_SIDE = 3000;

const area = (r: Rect): number => r.width * r.height;
function overlapRatio(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  return i ? area(i) / Math.min(area(a), area(b)) : 0;
}

/**
 * One way to find fields: local detection on vector pages, the vision model on scans or on request.
 * Smart Fill and the Edit form toolbar both call this (FR-FRM-15).
 */
export class FieldDetectionService {
  /** Areas found on scans by OCR, per document and page: a page is read once per session. */
  private readonly read = new WeakMap<PdfDocument, Map<PageIndex, Omit<DetectedArea, 'id'>[]>>();

  constructor(private readonly deps: { ai?: AiProvider; images?: ImageCodec; ocr?: OcrEngine }) {}

  /** Whether picture-only pages can be read on this device. */
  get ocrAvailable(): boolean {
    return !!this.deps.ocr;
  }
  /** Drops what was read from `doc` (its pages changed). */
  forgetScans(doc: PdfDocument): void {
    this.read.delete(doc);
  }

  /** A page that is only a picture: no text of its own, or the invisible layer Folio wrote over a scan. */
  async isPicturePage(doc: PdfDocument, page: PageIndex): Promise<boolean> {
    return (await doc.getTextLayer(page)).isScanned || (await doc.hasOcrLayer(page));
  }

  /**
   * Fields of a picture-only page, located as on a native one (FR-FRM-15): the page is read with OCR (once per
   * page and session; no change to the file) and the lines, dotted runs and boxes found in the image are
   * paired with the words that name them by the same code that serves vector pages. Null when the page
   * cannot be read this way (turned pages, OCR unavailable, language data missing); the caller then falls back
   * to the shapes alone. Without `opts` only an earlier reading is returned.
   * @throws CancelledError when `opts.signal` aborts
   */
  async detectScanOcr(doc: PdfDocument, page: PageIndex, opts?: OcrDetectOptions): Promise<Omit<DetectedArea, 'id'>[] | null> {
    const cached = this.read.get(doc)?.get(page);
    if (cached) return cached;
    if (!this.deps.ocr || !opts?.languages.length) return null;
    const info = await doc.getPageInfo(page);
    if (info.rotation !== 0) return null;
    const pxPerPoint = Math.min(DETECT_DPI / 72, DETECT_MAX_SIDE / Math.max(info.size.width, info.size.height));
    const img = await doc.render(page, { scale: pxPerPoint, annotations: false, forms: false }, opts.signal);
    const seen = detectScanAreas(img, pxPerPoint, 0);
    let layer;
    let shapes;
    try {
      if (await doc.hasOcrLayer(page)) {
        // A page that already carries Folio's invisible layer is not read again; its lines stay shapes.
        layer = await doc.getTextLayer(page);
        shapes = scanShapeObjects(seen, img, info);
      } else {
        const read = await this.deps.ocr.recognize(blankShapes(img, seen, pxPerPoint), { languages: opts.languages, signal: opts.signal });
        // Printed lines become typed leaders in the layer; boxes and squares stay shapes.
        const leaders = seen.filter((a) => a.line !== undefined).map((a) => ({ x0: a.x, x1: a.x + a.width, y: a.line! }));
        layer = ocrTextLayer(read, info, page, leaders, pxPerPoint);
        shapes = scanShapeObjects(seen.filter((a) => a.line === undefined), img, info);
      }
    } catch (e) {
      if (isFolioError(e) && e.code === 'cancelled') throw e;
      if (e instanceof InvalidArgumentError || e instanceof LimitExceededError) return null;
      throw e;
    }
    const areas = detectAreas(page, shapes, layer);
    let byPage = this.read.get(doc);
    if (!byPage) this.read.set(doc, (byPage = new Map()));
    byPage.set(page, areas);
    return areas;
  }

  /** Local detection only: no network, never needs an image. */
  async detectLocal(doc: PdfDocument, page: PageIndex): Promise<FieldProposal[]> {
    const [objects, layer] = [await doc.listObjects(page), await doc.getTextLayer(page)];
    return this.proposals(page, detectAreas(page, objects, layer), () => CONFIDENCE_CAP);
  }

  /** Detected areas as proposals; `confidence` may depend on whether a label was found. */
  private proposals(page: PageIndex, areas: Omit<DetectedArea, 'id'>[], confidence: (a: Omit<DetectedArea, 'id'>) => number): FieldProposal[] {
    return areas.map((a, k) => ({
      id: `p${page + 1}-d${k + 1}`,
      page,
      rect: a.rect,
      type: a.kind === 'checkbox' ? 'checkbox' : 'text',
      ...(a.kind === 'comb' ? { cells: a.cells } : {}),
      ...(a.lineY !== undefined ? { lineY: a.lineY } : {}),
      label: a.label,
      confidence: confidence(a),
      source: 'local' as const,
      accepted: true,
    }));
  }

  /**
   * Local detection on a scan (FR-FRM-15): underlines, empty boxes and small squares in the page image.
   * Without a text layer nothing names them, so proposals carry no label.
   */
  async detectScanLocal(doc: PdfDocument, page: PageIndex): Promise<FieldProposal[]> {
    const info = await doc.getPageInfo(page);
    const shown = info.rotation === 90 || info.rotation === 270 ? { width: info.size.height, height: info.size.width } : info.size;
    const scale = Math.min(2, 2200 / Math.max(shown.width, shown.height));
    const img = await doc.render(page, { scale });
    const result: FieldProposal[] = [];
    for (const a of detectScanAreas(img, scale, info.rotation)) {
      const rect = bboxToUserRect([a.x / img.width, a.y / img.height, (a.x + a.width) / img.width, (a.y + a.height) / img.height], info);
      if (rect.width < 4 || rect.height < 3) continue;
      result.push({ id: '', page, rect, type: a.kind, ...(a.dividers ? { cells: a.dividers.length - 1 } : {}), confidence: SCAN_CONFIDENCE, source: 'local', accepted: true });
    }
    return result;
  }

  /** Merges proposals: overlapping ones keep the more confident (local wins ties). */
  merge(list: FieldProposal[]): FieldProposal[] {
    const sorted = [...list].sort((a, b) => b.confidence - a.confidence || Number(a.source === 'ai') - Number(b.source === 'ai'));
    const kept: FieldProposal[] = [];
    for (const p of sorted) if (!kept.some((k) => k.page === p.page && overlapRatio(k.rect, p.rect) > OVERLAP)) kept.push(p);
    return kept
      .sort((a, b) => a.page - b.page || b.rect.y + b.rect.height - (a.rect.y + a.rect.height) || a.rect.x - b.rect.x)
      .map((p, k) => ({ ...p, id: `p${p.page + 1}-d${k + 1}` }));
  }

  /**
   * Detects on `pages`. Scanned pages (no text, covered by an image) go to the AI when `useAi` and it is
   * configured; vector pages use local detection unless `forceAi`. Without AI a scan yields the notice
   * "Detecting fields on a scan needs AI with the page image" and drawing by hand stays available.
   */
  async detect(
    doc: PdfDocument,
    pages: PageIndex[],
    opts: { useAi: boolean; forceAi?: boolean; signal?: AbortSignal; ocr?: OcrDetectOptions; progress?: (done: number, total: number) => void },
  ): Promise<DetectionResult> {
    const found: FieldProposal[] = [];
    let notice: DetectionNotice | undefined;
    let usedAi = false;
    const aiReady = opts.useAi && !!this.deps.ai && !!this.deps.images && (await this.deps.ai.isConfigured());
    const ocrReady = !!opts.ocr && this.ocrAvailable;
    const aiPages: PageIndex[] = [];
    const scans: PageIndex[] = [];
    if (ocrReady) for (const page of pages) if (await this.isPicturePage(doc, page)) scans.push(page);
    let read = 0;
    for (const page of pages) {
      const scanned = (await doc.getTextLayer(page)).isScanned;
      // A scan with OCR available is read on this device first; the vision model only improves on it, on request.
      if (ocrReady && scans.includes(page)) {
        opts.progress?.(read++, scans.length);
        const areas = await this.detectScanOcr(doc, page, opts.ocr);
        if (areas) {
          found.push(...this.proposals(page, areas, (a) => (a.label ? CONFIDENCE_CAP : SCAN_CONFIDENCE)));
          // Words found next to the shapes: read. Shapes alone (nothing legible around them) stay a guess.
          if (areas.length) notice = areas.some((a) => a.label) ? 'scanOcr' : 'scanLocal';
        } else {
          const shapes = await this.detectScanLocal(doc, page);
          found.push(...shapes);
          notice = shapes.length ? 'scanLocal' : 'scanNeedsAi';
        }
        if (opts.forceAi && aiReady) aiPages.push(page);
        continue;
      }
      if (scanned || opts.forceAi) {
        if (aiReady) aiPages.push(page);
        else if (scanned) {
          const shapes = await this.detectScanLocal(doc, page);
          found.push(...shapes);
          notice = shapes.length ? 'scanLocal' : 'scanNeedsAi';
        }
        if (!scanned) found.push(...(await this.detectLocal(doc, page)));
      } else found.push(...(await this.detectLocal(doc, page)));
    }
    if (scans.length) opts.progress?.(scans.length, scans.length);
    if (aiPages.length) {
      try {
        found.push(...(await this.detectWithAi(doc, aiPages, opts.signal)));
        usedAi = true;
      } catch (e) {
        if (isFolioError(e) && e.code === 'cancelled') throw e;
        if (e instanceof AiError || e instanceof NetworkError) notice = 'aiFailed';
        else throw e;
      }
    }
    const proposals = this.merge(found);
    if (proposals.length === 0 && !notice) notice = 'none';
    return { proposals, usedAi, notice };
  }

  /** The vision request: page image and text only, no profile keys, no values (FR-AIF-06). */
  async detectWithAi(doc: PdfDocument, pages: PageIndex[], signal?: AbortSignal): Promise<FieldProposal[]> {
    const ai = this.deps.ai!;
    const req: FormAnalysisRequest = { mode: 'mapping_only', pages: [], candidates: [], profileKeys: [], images: [] };
    for (const p of pages) {
      const info = await doc.getPageInfo(p);
      const shown = info.rotation === 90 || info.rotation === 270 ? { width: info.size.height, height: info.size.width } : info.size;
      req.pages.push({ page: p, width: shown.width, height: shown.height, textLines: [] });
      const scale = Math.min(2, 1280 / Math.max(shown.width, shown.height));
      const img = await doc.render(p, { scale });
      req.images!.push({ page: p, jpeg: await this.deps.images!.encode(img, 'jpeg', { quality: 0.8 }), width: img.width, height: img.height });
    }
    const out = await ai.analyzeForm(req, signal ?? new AbortController().signal);
    const result: FieldProposal[] = [];
    for (const a of out.newAreas) {
      const info = await doc.getPageInfo(a.page);
      const rect = bboxToUserRect(a.bbox, info);
      if (rect.width < 4 || rect.height < 3) continue;
      const confidence = Math.min(a.confidence, CONFIDENCE_CAP);
      result.push({
        id: '',
        page: a.page,
        rect,
        type: a.fieldType === 'checkbox' ? 'checkbox' : 'text',
        ...(a.fieldType === 'multiline' ? { multiline: true } : {}),
        label: a.label || undefined,
        confidence,
        source: 'ai',
        accepted: confidence >= LOW_CONFIDENCE,
      });
    }
    return result;
  }
}
