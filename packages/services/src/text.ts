import { containsPoint, distance, center, rectsForRange, throwIfAborted, unionAll } from '@folio/core';
import type { PageIndex, PdfDocument, Point, Quad, Rect, SearchHit, SearchQuery, TextLayer } from '@folio/ports';

export interface TextRange {
  page: PageIndex;
  start: number;
  /** Exclusive. */
  end: number;
}

/** Text layers, selection geometry and document search (FR-VIEW-03/04). */
export class TextService {
  private cache = new Map<PageIndex, TextLayer>();
  constructor(private readonly doc: PdfDocument, private readonly maxCached = 24) {}

  async layer(page: PageIndex): Promise<TextLayer> {
    const hit = this.cache.get(page);
    if (hit) {
      // Refresh recency.
      this.cache.delete(page);
      this.cache.set(page, hit);
      return hit;
    }
    const layer = await this.doc.getTextLayer(page);
    this.cache.set(page, layer);
    if (this.cache.size > this.maxCached) this.cache.delete(this.cache.keys().next().value!);
    return layer;
  }
  /** Call when page content changed (history invalidation). */
  invalidate(pages?: PageIndex[]): void {
    if (!pages) this.cache.clear();
    else for (const p of pages) this.cache.delete(p);
  }

  /** Index of the character at a point, or the nearest one on the same line within `slop` points. */
  charAt(layer: TextLayer, p: Point, slop = 6): number {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < layer.chars.length; i++) {
      const r = layer.chars[i]!.rect;
      if (r.width <= 0) continue;
      if (containsPoint(r, p)) return i;
      if (p.y >= r.y - slop && p.y <= r.y + r.height + slop) {
        const d = distance(center(r), p);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    return bestDist <= Math.max(slop * 4, 40) ? best : -1;
  }

  /** Range covered by dragging from one character to another (order-independent). */
  rangeBetween(page: PageIndex, a: number, b: number): TextRange {
    return { page, start: Math.min(a, b), end: Math.max(a, b) + 1 };
  }
  /** Double-click: the word around a character. */
  wordAt(layer: TextLayer, index: number): TextRange {
    const isWord = (i: number): boolean => /[\p{L}\p{N}_'’-]/u.test(layer.chars[i]?.text ?? '');
    if (!isWord(index)) return { page: layer.page, start: index, end: index + 1 };
    let start = index;
    let end = index + 1;
    while (start > 0 && isWord(start - 1)) start--;
    while (end < layer.chars.length && isWord(end)) end++;
    return { page: layer.page, start, end };
  }
  /** Triple-click: the visual line (FR-VIEW-03). */
  lineAt(layer: TextLayer, index: number): TextRange {
    const isBreak = (i: number): boolean => /[\r\n]/.test(layer.chars[i]?.text ?? '');
    let start = index;
    let end = index + 1;
    while (start > 0 && !isBreak(start - 1)) start--;
    while (end < layer.chars.length && !isBreak(end)) end++;
    return { page: layer.page, start, end };
  }

  text(layer: TextLayer, range: TextRange): string {
    return layer.chars.slice(range.start, range.end).map((c) => c.text).join('').replace(/\r\n?/g, '\n');
  }
  /** One rectangle per visual line of the selection. */
  rects(layer: TextLayer, range: TextRange): Rect[] {
    return rectsForRange(layer.chars, range.start, range.end - range.start);
  }
  /** Quads for a text markup annotation over the selection. */
  quads(layer: TextLayer, range: TextRange): Quad[] {
    return this.rects(layer, range).map((r) => ({
      p1: { x: r.x, y: r.y + r.height },
      p2: { x: r.x + r.width, y: r.y + r.height },
      p3: { x: r.x, y: r.y },
      p4: { x: r.x + r.width, y: r.y },
    }));
  }
  bounds(layer: TextLayer, range: TextRange): Rect {
    return unionAll(this.rects(layer, range));
  }

  /** Whole-document search, page by page so the result list can fill progressively. */
  async search(q: SearchQuery, opts: { signal?: AbortSignal; onPage?: (page: PageIndex, hits: SearchHit[]) => void; limit?: number } = {}): Promise<SearchHit[]> {
    const all: SearchHit[] = [];
    if (q.text === '') return all;
    const pages = q.pages ?? Array.from({ length: this.doc.pageCount }, (_, i) => i);
    for (const page of pages) {
      throwIfAborted(opts.signal);
      const hits: SearchHit[] = [];
      for await (const h of this.doc.search({ ...q, pages: [page] })) hits.push(h);
      all.push(...hits);
      opts.onPage?.(page, hits);
      if (opts.limit && all.length >= opts.limit) return all.slice(0, opts.limit);
    }
    return all;
  }
}

/** Next/previous match with wrap-around (Enter / Shift+Enter). */
export function stepMatch(count: number, current: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  return (((current + direction) % count) + count) % count;
}
