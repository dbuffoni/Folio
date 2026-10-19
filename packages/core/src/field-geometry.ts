import type { Rect } from '@folio/ports';

/**
 * Where text sits above a printed line: one rule for every field made from a detected area (field detection,
 * Smart Fill) and for the preview that shows it before it is created.
 */
export const TEXT_BASELINE_OFFSET = { min: 0, max: 12, default: 2 } as const;

/**
 * Single-line text in a form field is centred on its box: the baseline lies `height / 2 - K × font size` above
 * the bottom edge (K measured on the PDFium renderer, 0.36 for the standard fonts, see field-geometry.test.ts).
 */
export const BASELINE_K = 0.36;

/** Font size of text typed into a detected area. */
export const detectedFontSize = (areaHeight: number): number => Math.min(11, Math.max(7, areaHeight * 0.7));

/** Height of the baseline of centred text in a box, in PDF user space. */
export const centredBaseline = (box: Rect, fontSize: number): number => box.y + box.height / 2 - BASELINE_K * fontSize;

/**
 * The field box for text that must sit `offset` points (pixels at 100 % zoom) above a printed line, measured from
 * the baseline of the characters (descenders such as the tail of a "q" go below it and are not counted). Areas
 * that are not a line (boxes, comb cells) keep their own rectangle and centre the text.
 */
export function anchoredRect(area: Rect, lineY: number | undefined, fontSize: number, offset: number): Rect {
  if (lineY === undefined) return area;
  return { ...area, y: lineY + offset - area.height / 2 + BASELINE_K * fontSize };
}

/** Where the baseline of the text ends up for an area, with or without a line. */
export function textBaseline(area: Rect, lineY: number | undefined, fontSize: number, offset: number): number {
  return centredBaseline(anchoredRect(area, lineY, fontSize, offset), fontSize);
}
