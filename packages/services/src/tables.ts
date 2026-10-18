import { InvalidArgumentError, applyToRect, detectTable, pageToViewMatrix, toCsv, toTsv, type CsvOptions, type TableWord } from '@folio/core';
import type { AiProvider, ImageCodec, PageIndex, PdfDocument, Rect, TextLayer } from '@folio/ports';

export type TableNotice = 'rotated' | 'nothing';
export interface ExtractedTable {
  page: PageIndex;
  area: Rect;
  rows: string[][];
  source: 'local' | 'ai';
  /** Cells came from ruled lines (local only). */
  ruled?: boolean;
  /** Rotated or vertical text was left out. */
  skippedRotated: boolean;
}

/** Words of a text layer with their boxes; characters of one run are split at spaces. */
export function wordsOf(layer: TextLayer): { words: TableWord[]; skippedRotated: boolean } {
  const words: TableWord[] = [];
  let skippedRotated = false;
  for (const run of layer.runs) {
    if (Math.abs(((run.angle + 180) % 360) - 180) > 1) {
      skippedRotated = true;
      continue;
    }
    let text = '';
    let rect: Rect | null = null;
    const flush = (): void => {
      if (text && rect) words.push({ text, rect });
      text = '';
      rect = null;
    };
    for (let k = run.charStart; k < run.charStart + run.charCount; k++) {
      const c = layer.chars[k];
      if (!c) continue;
      if (/\s/.test(c.text) || c.text === '') {
        flush();
        continue;
      }
      text += c.text;
      if (c.rect.width > 0 || c.rect.height > 0) {
        rect = rect
          ? { x: Math.min(rect.x, c.rect.x), y: Math.min(rect.y, c.rect.y), width: Math.max(rect.x + rect.width, c.rect.x + c.rect.width) - Math.min(rect.x, c.rect.x), height: Math.max(rect.y + rect.height, c.rect.y + c.rect.height) - Math.min(rect.y, c.rect.y) }
          : c.rect;
      }
    }
    flush();
  }
  return { words, skippedRotated };
}

/** Table extraction to a preview grid, then CSV (FR-OPT-12). Local first; AI only on explicit action. */
export class TableService {
  constructor(private readonly deps: { ai?: AiProvider; images?: ImageCodec }) {}

  /** Ruling lines of a page as thin rectangles: path objects and the edges of boxes. */
  private async rules(doc: PdfDocument, page: PageIndex): Promise<Rect[]> {
    const out: Rect[] = [];
    for (const o of await doc.listObjects(page)) {
      if (o.type !== 'path') continue;
      const b = o.bounds;
      if (b.height <= 3 || b.width <= 3) out.push(b);
      else if (b.width < 700 && b.height < 700) {
        // A drawn box: its four edges are rules too.
        out.push({ x: b.x, y: b.y, width: b.width, height: 0.5 }, { x: b.x, y: b.y + b.height, width: b.width, height: 0.5 }, { x: b.x, y: b.y, width: 0.5, height: b.height }, { x: b.x + b.width, y: b.y, width: 0.5, height: b.height });
      }
    }
    return out;
  }

  /** @param area null = the whole page. */
  async extractLocal(doc: PdfDocument, page: PageIndex, area: Rect | null): Promise<ExtractedTable | null> {
    const info = await doc.getPageInfo(page);
    const region = area ?? info.cropBox;
    const { words, skippedRotated } = wordsOf(await doc.getTextLayer(page));
    const found = detectTable(words, region, { rules: await this.rules(doc, page) });
    if (!found) return null;
    return { page, area: region, rows: found.rows, source: 'local', ruled: found.ruled, skippedRotated };
  }

  /** The vision model reads the area image; the page text is not sent, only the picture (FR-OPT-12). */
  async extractAi(doc: PdfDocument, page: PageIndex, area: Rect | null, signal?: AbortSignal): Promise<ExtractedTable> {
    const { ai, images } = this.deps;
    if (!ai || !images || !(await ai.isConfigured())) throw new InvalidArgumentError('AI is not set up', { reason: 'notConfigured' });
    const info = await doc.getPageInfo(page);
    const region = area ?? info.cropBox;
    const scale = Math.min(3, 1600 / Math.max(region.width, region.height));
    // Render the page at the chosen scale (as shown, with its /Rotate) and cut the area out.
    const img = await doc.render(page, { scale, annotations: true });
    const view = applyToRect(pageToViewMatrix(info.size, info.rotation, scale), { ...region, x: region.x - info.cropBox.x, y: region.y - info.cropBox.y });
    const x = Math.min(img.width - 1, Math.max(0, Math.round(view.x)));
    const y = Math.min(img.height - 1, Math.max(0, Math.round(view.y)));
    const w = Math.max(1, Math.min(img.width - x, Math.round(view.width)));
    const h = Math.max(1, Math.min(img.height - y, Math.round(view.height)));
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) data.set(img.data.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4), row * w * 4);
    const jpeg = await images.encode({ width: w, height: h, data }, 'jpeg', { quality: 0.85 });
    const out = await ai.extractTable({ page, jpeg, width: w, height: h }, signal ?? new AbortController().signal);
    return { page, area: region, rows: out.rows, source: 'ai', skippedRotated: false };
  }

  csv(rows: string[][], opts: CsvOptions = {}): Uint8Array {
    return new TextEncoder().encode(toCsv(rows, opts));
  }
  tsv(rows: string[][]): string {
    return toTsv(rows);
  }
  /** `Report page 3 table.csv` */
  fileName(documentName: string, page: PageIndex): string {
    return `${documentName.replace(/\.pdf$/i, '')} page ${page + 1} table.csv`;
  }
}
