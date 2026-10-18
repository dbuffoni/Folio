import type { Size, TextLayer } from '@folio/ports';

/** Body text size, in points, that today's default stamp and signature sizes are drawn for. Also the fallback. */
export const REFERENCE_BODY_PT = 12;

/** Percentage range of the "size relative to page text" settings; 100 keeps today's size on 12 pt text. */
export const STAMP_SIZE_PCT = { min: 25, max: 300, default: 100 } as const;

/** Protection against absurd results, in points of height. Internal constants, never shown to the user. */
export const SIGNATURE_HEIGHT_LIMITS = { min: 18, max: 120 } as const;
export const DATE_HEIGHT_LIMITS = { min: 8, max: 40 } as const;

/** Glyph sizes outside this range are decoration or noise, not body text. */
const BODY_MIN_PT = 4;
const BODY_MAX_PT = 144;

/**
 * The font size that carries most of the page's text: the horizontal runs' sizes weighted by the number of
 * visible characters, rounded to half a point. `null` when the page has no usable text (scan, blank page).
 */
export function predominantFontSize(layer: Pick<TextLayer, 'runs'>): number | null {
  const weight = new Map<number, number>();
  for (const run of layer.runs) {
    if (Math.abs(run.angle) >= 0.5 || !(run.fontSize >= BODY_MIN_PT && run.fontSize <= BODY_MAX_PT)) continue;
    const chars = run.text.replace(/\s+/g, '').length;
    if (chars === 0) continue;
    const key = Math.round(run.fontSize * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + chars);
  }
  let best: number | null = null;
  let bestWeight = 0;
  for (const [size, w] of weight) {
    // Ties go to the larger size: it is the safer one for a signature to match.
    if (w > bestWeight || (w === bestWeight && best !== null && size > best)) {
      best = size;
      bestWeight = w;
    }
  }
  return best;
}

/**
 * Factor applied to a stamp's natural size: `pct` percent of the page's body text size relative to
 * {@link REFERENCE_BODY_PT}, then kept inside `limits` for the resulting height. A missing or unusable body
 * size (`null`, NaN) falls back to the reference size.
 */
export function stampScale(
  bodyPt: number | null,
  pct: number,
  baseHeight: number,
  limits: { min: number; max: number },
): number {
  const body = bodyPt !== null && Number.isFinite(bodyPt) && bodyPt > 0 ? bodyPt : REFERENCE_BODY_PT;
  const percent = Number.isFinite(pct) && pct > 0 ? pct : STAMP_SIZE_PCT.default;
  const raw = (body / REFERENCE_BODY_PT) * (percent / 100);
  if (!(baseHeight > 0)) return raw;
  return Math.min(limits.max / baseHeight, Math.max(limits.min / baseHeight, raw));
}

export function scaleSize(size: Size, factor: number): Size {
  return { width: size.width * factor, height: size.height * factor };
}
