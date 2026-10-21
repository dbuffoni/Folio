import { bboxToUserRect } from '@folio/core';
import type { Color, FontInfo, Matrix, OcrPageResult, PageIndex, PageInfo, PageObject, Rect, TextChar, TextLayer, TextLine, TextRun } from '@folio/ports';
import type { ScanArea } from './scan-fields.ts';

// A scan has no text and no vector shapes. These helpers turn what OCR and the image analysis found into
// the same two inputs native detection reads (a text layer and page objects), so a scanned form is located
// by one code path with a native one (FR-FRM-15).

const NO_FONT: FontInfo = { name: 'OCR', family: 'OCR', isEmbedded: false, isSubset: false, weight: 400, italic: false, flags: 0 };
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

/** Runs of dashes are how scans show a ruled line made of hyphens; they read as underscores, like a typed line. */
const DASHES = /^[-‐-―−~=]{5,}$/;

/** Words OCR read as nothing but leaders: underscores, dots, dashes. */
export function isLeaderWord(text: string): boolean {
  return /^[_.…·-]{3,}$/.test(text) || DASHES.test(text);
}

/** A printed line (underline or row of dots) found in the page image, in pixels of that image. */
export interface PixelLeader {
  x0: number;
  x1: number;
  /** Pixel row of the line itself. */
  y: number;
}

/** The glyph size a leader is given, in points: the size of the text of a form. */
const LEADER_PT = 12;
const LEADER_GLYPH_PT = 5;

/**
 * What is left of a word once the part lying on a leader is cut away: a word "Firma......" read as one keeps
 * "Firma"; a word of junk read from dots disappears. Characters are placed evenly over the word's box.
 */
function clearLeader<W extends { text: string; x0: number; y0: number; x1: number; y1: number }>(w: W, lead: PixelLeader, top: number, bottom: number): W[] {
  const cy = (w.y0 + w.y1) / 2;
  if (cy < top || cy > bottom || w.x1 < lead.x0 - 2 || w.x0 > lead.x1 + 2) return [w];
  // "Firma......" read as one word: what is written before the leader characters is the word.
  const own = [...w.text];
  const core = [...w.text.replace(/[_.\u2026\u00b7-]{2,}$/, '')];
  if (core.length > 0 && core.length < own.length) {
    const x1 = Math.min(w.x0 + ((w.x1 - w.x0) * core.length) / own.length, lead.x0);
    return [{ ...w, text: core.join(''), x1: Math.max(x1, w.x0 + 1) }];
  }
  const glyphs = [...w.text];
  const step = (w.x1 - w.x0) / glyphs.length;
  const out: W[] = [];
  let from = -1;
  const flush = (to: number): void => {
    if (from < 0) return;
    const text = glyphs.slice(from, to).join('').replace(/^[_.\u2026\u00b7\s-]+|[_.\u2026\u00b7\s-]+$/g, '');
    if (text) out.push({ ...w, text, x0: w.x0 + from * step, x1: w.x0 + to * step });
    from = -1;
  };
  glyphs.forEach((_, i) => {
    const cx = w.x0 + (i + 0.5) * step;
    if (cx >= lead.x0 - 2 && cx <= lead.x1 + 2) flush(i);
    else if (from < 0) from = i;
  });
  flush(glyphs.length);
  return out;
}

/**
 * The words OCR recognised as a text layer in PDF user space: one character per glyph (spread over the
 * word's box), a space between words and a line break after every line, so leaders, labels and lines are found
 * the way they are on a native page. Dashes that form a line become underscores.
 *
 * `leaders` are the lines and dotted rows seen in the image. OCR reads those badly (a row of dots comes back as
 * "ccoevvienn", a line of underscores as nothing), so the words lying on a leader are dropped and the leader is
 * written into the layer as typed underscores, in its text line, where native detection finds it with the words
 * before it as its label.
 */
export function ocrTextLayer(result: OcrPageResult, info: PageInfo, page: PageIndex, leaders: PixelLeader[] = [], pxPerPoint = 1): TextLayer {
  interface W {
    text: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const glyphPx = LEADER_PT * pxPerPoint;
  const rows: Array<{ words: W[]; y0: number; y1: number; x0: number; x1: number }> = result.lines.map((l) => ({
    words: l.words.map((w) => ({ text: DASHES.test(w.text) ? '_'.repeat(w.text.length) : w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })),
    y0: l.y0,
    y1: l.y1,
    x0: l.x0,
    x1: l.x1,
  }));
  for (const lead of leaders) {
    // The band the line's own glyphs would occupy: from a glyph height above the line to just under it.
    const top = lead.y - glyphPx * 0.8;
    const bottom = lead.y + glyphPx * 0.3;
    for (const row of rows) row.words = row.words.flatMap((w) => clearLeader(w, lead, top, bottom));
    const glyphs = Math.max(4, Math.round((lead.x1 - lead.x0) / (LEADER_GLYPH_PT * pxPerPoint)));
    const word: W = { text: '_'.repeat(glyphs), x0: lead.x0, x1: lead.x1, y1: lead.y + glyphPx * 0.2, y0: lead.y + glyphPx * 0.2 - glyphPx };
    // The text line it sits in: the one whose band holds the line, else a line of its own.
    const home = rows.find((r) => r.words.length > 0 && lead.y >= r.y0 && lead.y <= r.y1 + glyphPx * 0.3);
    if (home) {
      home.words.push(word);
      home.x0 = Math.min(home.x0, word.x0);
      home.x1 = Math.max(home.x1, word.x1);
    } else rows.push({ words: [word], y0: word.y0, y1: word.y1, x0: word.x0, x1: word.x1 });
  }
  const chars: TextChar[] = [];
  const runs: TextRun[] = [];
  const lines: TextLine[] = [];
  const box = (x0: number, y0: number, x1: number, y1: number): Rect => bboxToUserRect([x0 / result.width, y0 / result.height, x1 / result.width, y1 / result.height], info);
  const push = (text: string, rect: Rect): void => {
    chars.push({ text, rect, origin: { x: rect.x, y: rect.y } });
  };
  for (const row of rows.filter((r) => r.words.length > 0).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const start = chars.length;
    const words = [...row.words].sort((a, b) => a.x0 - b.x0);
    const lineRect = box(Math.min(...words.map((w) => w.x0)), Math.min(...words.map((w) => w.y0)), Math.max(...words.map((w) => w.x1)), Math.max(...words.map((w) => w.y1)));
    let text = '';
    words.forEach((w, n) => {
      const r = box(w.x0, w.y0, w.x1, w.y1);
      const glyphs = [...w.text];
      const step = r.width / glyphs.length;
      glyphs.forEach((g, k) => push(g, { x: r.x + k * step, y: r.y, width: step, height: r.height }));
      text += w.text;
      const next = words[n + 1];
      if (next) {
        const gap = box(w.x1, w.y0, Math.max(w.x1, next.x0), w.y1);
        push(' ', { x: gap.x, y: gap.y, width: gap.width, height: gap.height });
        text += ' ';
      }
    });
    push('\n', { x: lineRect.x + lineRect.width, y: lineRect.y, width: 0, height: lineRect.height });
    runs.push({ text, rect: lineRect, origin: { x: lineRect.x, y: lineRect.y }, angle: 0, font: NO_FONT, fontSize: lineRect.height, color: BLACK, charStart: start, charCount: chars.length - 1 - start });
    lines.push({ text, rect: lineRect, runs: [runs.length - 1], editable: false });
  }
  return { page, text: chars.map((c) => c.text).join(''), chars, runs, lines, isScanned: true };
}

/**
 * Shapes found in the page image as the path objects native detection expects: an underline or a dotted row
 * is a thin path on its line; an empty box or a small square is a path of its own. `img` is the size of the
 * image the areas are in.
 */
export function scanShapeObjects(areas: ScanArea[], img: { width: number; height: number }, info: PageInfo): PageObject[] {
  const toUser = (x0: number, y0: number, x1: number, y1: number): Rect => bboxToUserRect([x0 / img.width, y0 / img.height, x1 / img.width, y1 / img.height], info);
  const identity: Matrix = [1, 0, 0, 1, 0, 0];
  return areas.flatMap((a, n): PageObject[] => {
    const path = (bounds: Rect, k = 0): PageObject => ({ id: `scan-${n}-${k}`, type: 'path', bounds, matrix: identity });
    // An underline is the line itself, one pixel thick; native detection then finds the writing space above it.
    if (a.line !== undefined) return [path(toUser(a.x, a.line, a.x + a.width, a.line + 1))];
    // A comb is the row of its cells, side by side, as it is drawn on a native page.
    if (a.dividers) return a.dividers.slice(1).map((x, k) => path(toUser(a.dividers![k]!, a.y, x, a.y + a.height), k));
    return [path(toUser(a.x, a.y, a.x + a.width, a.y + a.height))];
  });
}
