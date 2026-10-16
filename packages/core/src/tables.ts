import type { Rect } from '@folio/ports';

/** A word with its box on the page (PDF user space). */
export interface TableWord {
  text: string;
  rect: Rect;
}
export interface TableOptions {
  /** Horizontal and vertical ruling lines found on the page, as thin rectangles. */
  rules?: Rect[];
}
export interface TableResult {
  rows: string[][];
  /** Cells came from ruled lines (true) or from alignment and gaps (false). */
  ruled: boolean;
  /** Union of the cells. */
  bounds: Rect;
}

const right = (r: Rect): number => r.x + r.width;
const top = (r: Rect): number => r.y + r.height;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const inside = (r: Rect, area: Rect): boolean => {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return cx >= area.x && cx <= right(area) && cy >= area.y && cy <= top(area);
};

/** Reading order: top to bottom, then left to right, words of one line joined with a space. */
function joinWords(words: TableWord[]): string {
  if (words.length === 0) return '';
  const h = median(words.map((w) => w.rect.height)) || 10;
  const sorted = [...words].sort((a, b) => {
    const dy = b.rect.y + b.rect.height / 2 - (a.rect.y + a.rect.height / 2);
    return Math.abs(dy) > h * 0.5 ? dy : a.rect.x - b.rect.x;
  });
  return sorted.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
}

/** Positions where consecutive rules are merged: edges closer than `tol` count as one line. */
function cluster(values: number[], tol: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  for (const v of s) {
    if (group.length && v - group[group.length - 1]! > tol) {
      out.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [];
    }
    group.push(v);
  }
  if (group.length) out.push(group.reduce((a, b) => a + b, 0) / group.length);
  return out;
}

/**
 * Table from ruling lines: cells are the spaces between consecutive horizontal and vertical rules that
 * lie in `area`. Words go to the cell holding their centre; several lines in a cell are joined. A cell
 * that a merged region covers is left empty, the text sits in its first cell.
 */
function ruledGrid(words: TableWord[], rules: Rect[], area: Rect): TableResult | null {
  const horizontal = rules.filter((r) => r.height <= 3 && r.width >= 12 && inside(r, area));
  const vertical = rules.filter((r) => r.width <= 3 && r.height >= 8 && inside(r, area));
  if (horizontal.length < 2 || vertical.length < 2) return null;
  const ys = cluster(horizontal.map((r) => r.y + r.height / 2), 2.5).reverse(); // top → bottom
  const xs = cluster(vertical.map((r) => r.x + r.width / 2), 2.5);
  if (ys.length < 2 || xs.length < 2) return null;
  const rows: string[][] = [];
  for (let r = 0; r < ys.length - 1; r++) {
    const row: string[] = [];
    for (let c = 0; c < xs.length - 1; c++) {
      const cell: Rect = { x: xs[c]!, y: ys[r + 1]!, width: xs[c + 1]! - xs[c]!, height: ys[r]! - ys[r + 1]! };
      row.push(joinWords(words.filter((w) => inside(w.rect, cell))));
    }
    rows.push(row);
  }
  const bounds: Rect = { x: xs[0]!, y: ys[ys.length - 1]!, width: xs[xs.length - 1]! - xs[0]!, height: ys[0]! - ys[ys.length - 1]! };
  return { rows, ruled: true, bounds };
}

/**
 * Table from alignment and gaps: lines are found by vertical position, columns by vertical channels of
 * white space that no line crosses. A line that starts in a later column than the one above and sits
 * tight under it continues the cell above (multi-line cells).
 */
function alignedGrid(words: TableWord[]): TableResult | null {
  if (words.length < 2) return null;
  const h = median(words.map((w) => w.rect.height)) || 10;
  // 1. Lines.
  const sorted = [...words].sort((a, b) => b.rect.y + b.rect.height / 2 - (a.rect.y + a.rect.height / 2));
  const lines: TableWord[][] = [];
  for (const w of sorted) {
    const cy = w.rect.y + w.rect.height / 2;
    const last = lines[lines.length - 1];
    const lastY = last ? last.reduce((n, x) => n + x.rect.y + x.rect.height / 2, 0) / last.length : 0;
    if (last && Math.abs(lastY - cy) <= h * 0.55) last.push(w);
    else lines.push([w]);
  }
  for (const l of lines) l.sort((a, b) => a.rect.x - b.rect.x);
  // 2. Segments: neighbouring words closer than ~0.9 em belong to the same cell.
  const gap = Math.max(h * 0.9, 5);
  const segmentsOf = (l: TableWord[]): Array<{ words: TableWord[]; x0: number; x1: number }> => {
    const segs: Array<{ words: TableWord[]; x0: number; x1: number }> = [];
    for (const w of l) {
      const s = segs[segs.length - 1];
      if (s && w.rect.x - s.x1 <= gap) {
        s.words.push(w);
        s.x1 = Math.max(s.x1, right(w.rect));
      } else segs.push({ words: [w], x0: w.rect.x, x1: right(w.rect) });
    }
    return segs;
  };
  // A paragraph above or below the table is one wide segment per line and would close every column
  // channel: the table is the stretch from the first to the last line with two or more segments.
  const multi = lines.map((l) => segmentsOf(l).length >= 2);
  const first = multi.indexOf(true);
  const last = multi.lastIndexOf(true);
  if (first > 0 || (last >= 0 && last < lines.length - 1)) lines.splice(0, lines.length, ...lines.slice(first, last + 1));
  const segments = lines.map((l) => {
    const segs: Array<{ words: TableWord[]; x0: number; x1: number }> = [];
    for (const w of l) {
      const s = segs[segs.length - 1];
      if (s && w.rect.x - s.x1 <= gap) {
        s.words.push(w);
        s.x1 = Math.max(s.x1, right(w.rect));
      } else segs.push({ words: [w], x0: w.rect.x, x1: right(w.rect) });
    }
    return segs;
  });
  // 3. Column channels: x ranges not covered by any segment, at least `gap` wide.
  const cover = segments.flat().map((s) => [s.x0, s.x1] as const).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of cover) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + gap * 0.5) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (merged.length < 2 && segments.every((l) => l.length < 2)) return null;
  // Column edges at the start of every covered block and the cut between blocks.
  const edges: number[] = [];
  for (let i = 0; i < merged.length; i++) edges.push(i === 0 ? merged[0]![0] - 1 : (merged[i - 1]![1] + merged[i]![0]) / 2);
  edges.push(merged[merged.length - 1]![1] + 1);
  const colOf = (x: number): number => {
    for (let i = edges.length - 2; i >= 0; i--) if (x >= edges[i]!) return i;
    return 0;
  };
  const cols = edges.length - 1;
  const rows: string[][] = [];
  const rowTop: number[] = [];
  const rowBottom: number[] = [];
  for (const [n, segs] of segments.entries()) {
    const lineTop = Math.max(...lines[n]!.map((w) => top(w.rect)));
    const lineBottom = Math.min(...lines[n]!.map((w) => w.rect.y));
    const cells: string[] = Array<string>(cols).fill('');
    const used: number[] = [];
    for (const s of segs) {
      const c = colOf(s.x0);
      cells[c] = cells[c] ? `${cells[c]} ${joinWords(s.words)}` : joinWords(s.words);
      used.push(c);
    }
    // Continuation: starts after column 0, sits tight under the previous line, leaves its first column empty.
    const prev = rows[rows.length - 1];
    const tight = prev !== undefined && rowBottom[rowBottom.length - 1]! - lineTop < h * 0.6;
    if (prev && tight && cells[0] === '' && prev[0] !== '' && used.every((c) => c > 0)) {
      for (const c of used) prev[c] = prev[c] ? `${prev[c]} ${cells[c]}` : cells[c]!;
      rowBottom[rowBottom.length - 1] = lineBottom;
      continue;
    }
    rows.push(cells);
    rowTop.push(lineTop);
    rowBottom.push(lineBottom);
  }
  const x0 = Math.min(...words.map((w) => w.rect.x));
  const x1 = Math.max(...words.map((w) => right(w.rect)));
  const y0 = Math.min(...words.map((w) => w.rect.y));
  const y1 = Math.max(...words.map((w) => top(w.rect)));
  return { rows: dropEmptyColumns(rows), ruled: false, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

function dropEmptyColumns(rows: string[][]): string[][] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const keep = Array.from({ length: width }, (_, c) => rows.some((r) => (r[c] ?? '') !== ''));
  return rows.map((r) => r.filter((_, c) => keep[c]));
}

/** Finds the table in `area`: ruled when the page has lines forming a grid there, else by alignment. */
export function detectTable(words: TableWord[], area: Rect, opts: TableOptions = {}): TableResult | null {
  const inArea = words.filter((w) => w.text.trim() !== '' && inside(w.rect, area));
  const ruled = opts.rules ? ruledGrid(inArea, opts.rules, area) : null;
  if (ruled && ruled.rows.some((r) => r.some((c) => c !== ''))) return ruled;
  const aligned = alignedGrid(inArea);
  return aligned && aligned.rows.length > 0 ? aligned : null;
}

// ---- CSV (RFC 4180) ---------------------------------------------------------------------------

export interface CsvOptions {
  delimiter?: ',' | ';' | '\t';
  /** A UTF-8 byte order mark first, so Excel opens the file as UTF-8. */
  bom?: boolean;
}
/** Quotes a field only when it has to be: delimiter, quote, or a line break. */
function field(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}
/** UTF-8 CSV text; numbers stay exactly as printed. Lines end with CRLF as RFC 4180 asks. */
export function toCsv(rows: string[][], opts: CsvOptions = {}): string {
  const d = opts.delimiter ?? ',';
  return `${opts.bom ? '﻿' : ''}${rows.map((r) => r.map((c) => field(c, d)).join(d)).join('\r\n')}${rows.length ? '\r\n' : ''}`;
}
/** Tab-separated text for pasting into a spreadsheet: tabs and line breaks inside a cell become spaces. */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

// ---- grid editing -----------------------------------------------------------------------------

const widthOf = (rows: string[][]): number => Math.max(0, ...rows.map((r) => r.length));
const square = (rows: string[][]): string[][] => rows.map((r) => Array.from({ length: widthOf(rows) }, (_, c) => r[c] ?? ''));
export const grid = {
  square,
  setCell(rows: string[][], r: number, c: number, value: string): string[][] {
    return square(rows).map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row));
  },
  /** Joins column `c` with the next one (texts joined with a space). */
  mergeColumns(rows: string[][], c: number): string[][] {
    return square(rows).map((r) => (c + 1 >= r.length ? r : [...r.slice(0, c), [r[c], r[c + 1]].filter(Boolean).join(' '), ...r.slice(c + 2)]));
  },
  /** Splits column `c` at the first space of every cell: the rest of the text moves to a new column. */
  splitColumn(rows: string[][], c: number): string[][] {
    return square(rows).map((r) => {
      const [head, ...tail] = (r[c] ?? '').split(/\s+/);
      return [...r.slice(0, c), head ?? '', tail.join(' '), ...r.slice(c + 1)];
    });
  },
  deleteRow: (rows: string[][], r: number): string[][] => rows.filter((_, i) => i !== r),
  deleteColumn: (rows: string[][], c: number): string[][] => square(rows).map((r) => r.filter((_, j) => j !== c)),
  moveRow(rows: string[][], r: number, to: number): string[][] {
    const next = [...rows];
    const [x] = next.splice(r, 1);
    if (x) next.splice(Math.max(0, Math.min(next.length, to)), 0, x);
    return next;
  },
};
