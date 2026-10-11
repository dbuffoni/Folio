import type { PageIndex, Rect, SearchHit, SearchQuery, TextChar, TextLayer, TextLine, TextRun } from '@folio/ports';
import { unionAll } from './geometry.ts';

const sameColor = (a: TextRun['color'], b: TextRun['color']): boolean => a.r === b.r && a.g === b.g && a.b === b.b;

/**
 * Groups runs into editable lines (SPEC §8.7 step 1): adjacent runs on the same baseline with equal
 * font, size and colour. Runs must be in reading order.
 */
export function groupLines(runs: readonly TextRun[]): TextLine[] {
  const lines: TextLine[] = [];
  let current: number[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const rs = current.map((i) => runs[i]!);
    const first = rs[0]!;
    lines.push({
      text: rs.map((r) => r.text).join(''),
      rect: unionAll(rs.map((r) => r.rect)),
      runs: current,
      editable: Math.abs(first.angle) < 0.5 && rs.every((r) => r.objId !== undefined),
    });
    current = [];
  };
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const prev = current.length ? runs[current[current.length - 1]!]! : undefined;
    if (prev) {
      const tol = Math.max(0.5, prev.fontSize * 0.1);
      const sameBaseline = Math.abs(prev.origin.y - run.origin.y) <= tol && Math.abs(prev.angle - run.angle) < 0.5;
      const gap = run.rect.x - (prev.rect.x + prev.rect.width);
      const adjacent = gap > -prev.fontSize * 0.5 && gap < prev.fontSize * 1.5;
      const sameStyle =
        prev.font.name === run.font.name && Math.abs(prev.fontSize - run.fontSize) < 0.05 && sameColor(prev.color, run.color);
      if (!(sameBaseline && adjacent && sameStyle)) flush();
    }
    current.push(i);
  }
  flush();
  return lines;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Merges character boxes of a match into one rectangle per visual line. */
export function rectsForRange(chars: readonly TextChar[], start: number, count: number): Rect[] {
  const rects: Rect[] = [];
  let group: Rect[] = [];
  for (let i = start; i < start + count; i++) {
    const c = chars[i];
    if (!c || c.rect.width <= 0 || c.rect.height <= 0) continue;
    const last = group[group.length - 1];
    if (last) {
      const overlap = Math.min(last.y + last.height, c.rect.y + c.rect.height) - Math.max(last.y, c.rect.y);
      if (overlap < Math.min(last.height, c.rect.height) * 0.5) {
        rects.push(unionAll(group));
        group = [];
      }
    }
    group.push(c.rect);
  }
  if (group.length) rects.push(unionAll(group));
  return rects;
}

/** Search inside one page's text layer (FR-VIEW-04): case option, whole-word option, snippets. */
export function searchTextLayer(layer: TextLayer, q: Pick<SearchQuery, 'text' | 'matchCase' | 'wholeWord'>): SearchHit[] {
  // Length-preserving case folding so string offsets keep pointing at the same characters.
  const fold = (s: string): string =>
    q.matchCase ? s : Array.from({ length: s.length }, (_, i) => (s[i]!.toLowerCase().length === 1 ? s[i]!.toLowerCase() : s[i]!)).join('');
  const needle = fold(q.text);
  if (needle.length === 0) return [];
  // One entry of `chars` may hold more than one UTF-16 unit; map string offsets back to char indexes.
  const offsets: number[] = [];
  let text = '';
  layer.chars.forEach((c, i) => {
    for (let k = 0; k < c.text.length; k++) offsets.push(i);
    text += c.text;
  });
  const hay = fold(text);
  const hits: SearchHit[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    from = at + Math.max(1, needle.length);
    const end = at + needle.length;
    if (q.wholeWord && (isWordChar(text[at - 1]) || isWordChar(text[end]))) continue;
    const charStart = offsets[at]!;
    const charCount = offsets[end - 1]! - charStart + 1;
    const clean = (s: string): string => s.replace(/\s+/g, ' ');
    hits.push({
      page: layer.page,
      charStart,
      charCount,
      rects: rectsForRange(layer.chars, charStart, charCount),
      snippet: {
        before: clean(text.slice(Math.max(0, at - 40), at)).trimStart(),
        match: text.slice(at, end),
        after: clean(text.slice(end, end + 40)).trimEnd(),
      },
    });
  }
  return hits;
}

export function pagesToSearch(q: SearchQuery, pageCount: number): PageIndex[] {
  return q.pages ?? Array.from({ length: pageCount }, (_, i) => i);
}
