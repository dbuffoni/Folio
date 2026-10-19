import { bboxToUserRect, intersect, isFolioError, AiError, NetworkError } from '@folio/core';
import type { AiProvider, FormAnalysisRequest, FormFieldType, ImageCodec, PageIndex, PdfDocument, Rect } from '@folio/ports';
import { detectAreas } from './form.ts';
import { detectScanAreas } from './scan-fields.ts';

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
  /** Nothing that looks like a field was found. */
  | 'none';
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
  constructor(private readonly deps: { ai?: AiProvider; images?: ImageCodec }) {}

  /** Local detection only: no network, never needs an image. */
  async detectLocal(doc: PdfDocument, page: PageIndex): Promise<FieldProposal[]> {
    const [objects, layer] = [await doc.listObjects(page), await doc.getTextLayer(page)];
    return detectAreas(page, objects, layer).map((a, k) => ({
      id: `p${page + 1}-d${k + 1}`,
      page,
      rect: a.rect,
      type: a.kind === 'checkbox' ? 'checkbox' : 'text',
      ...(a.kind === 'comb' ? { cells: a.cells } : {}),
      ...(a.lineY !== undefined ? { lineY: a.lineY } : {}),
      label: a.label,
      confidence: CONFIDENCE_CAP,
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
      result.push({ id: '', page, rect, type: a.kind, confidence: SCAN_CONFIDENCE, source: 'local', accepted: true });
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
    opts: { useAi: boolean; forceAi?: boolean; signal?: AbortSignal },
  ): Promise<DetectionResult> {
    const found: FieldProposal[] = [];
    let notice: DetectionNotice | undefined;
    let usedAi = false;
    const aiReady = opts.useAi && !!this.deps.ai && !!this.deps.images && (await this.deps.ai.isConfigured());
    const aiPages: PageIndex[] = [];
    for (const page of pages) {
      const scanned = (await doc.getTextLayer(page)).isScanned;
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
