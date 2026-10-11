import type { StandardFontFamily } from '@folio/ports';
import type { Pdfium, Ptr } from './mem.ts';

export type FontVariant = 'regular' | 'bold' | 'italic' | 'boldItalic';
/** TrueType data of the bundled metric-compatible fonts (SPEC §8.7). Missing entries fall back to the PDF standard 14. */
export type FontData = Partial<Record<StandardFontFamily, Partial<Record<FontVariant, Uint8Array>>>>;

const STANDARD: Record<StandardFontFamily, Record<FontVariant, string>> = {
  sans: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },
  serif: { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', boldItalic: 'Times-BoldItalic' },
  mono: { regular: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique' },
};
const BUNDLED_NAME: Record<StandardFontFamily, string> = { sans: 'Liberation Sans', serif: 'Liberation Serif', mono: 'Liberation Mono' };

export const variantOf = (bold?: boolean, italic?: boolean): FontVariant =>
  bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular';

/** Picks the bundled family closest to a font found in a document. */
export function nearestFamily(font: { name: string; family: string; flags: number }): StandardFontFamily {
  const n = `${font.name} ${font.family}`.toLowerCase();
  if (/courier|mono|consol|menlo|typewriter/.test(n) || font.flags & 0x1) return 'mono';
  if (/times|serif(?!.*sans)|georgia|garamond|cambria|caladea|roman|minion|palatino|book/.test(n) && !/sans/.test(n)) return 'serif';
  if (font.flags & 0x2 && !/sans|arial|helvet|calibri|verdana|tahoma/.test(n)) return 'serif';
  return 'sans';
}

export class FontRegistry {
  /** FPDF_FONT handles are owned by a document; cache them per document pointer. */
  private loaded = new Map<Ptr, Map<string, Ptr>>();
  /** Resolves when lazily loaded font data has arrived (immediately when fonts were given up front). */
  ready: Promise<void> = Promise.resolve();
  constructor(
    private readonly m: Pdfium,
    private data: FontData,
  ) {}

  /** Supplies font data after construction (the browser worker fetches fonts in the background). */
  provide(data: Promise<FontData>): void {
    this.ready = data.then(
      (d) => {
        this.data = d;
      },
      () => undefined, // fonts could not be fetched: the PDF standard 14 fallback stays in use
    );
  }

  /** Display name of what `load` will embed for the family. */
  displayName(family: StandardFontFamily, variant: FontVariant = 'regular'): string {
    return this.data[family]?.[variant] || this.data[family]?.regular ? BUNDLED_NAME[family] : STANDARD[family][variant];
  }

  load(doc: Ptr, family: StandardFontFamily, variant: FontVariant): Ptr {
    let perDoc = this.loaded.get(doc);
    if (!perDoc) this.loaded.set(doc, (perDoc = new Map()));
    const key = `${family}/${variant}`;
    let font = perDoc.get(key);
    if (font) return font;
    const bytes = this.data[family]?.[variant] ?? this.data[family]?.regular;
    if (bytes) {
      const p = this.m.pdfium._malloc(bytes.length);
      this.m.pdfium.HEAPU8.set(bytes, p);
      // TrueType (2), CID-keyed so any Unicode character the font covers can be written.
      font = this.m.FPDFText_LoadFont(doc, p, bytes.length, 2, true);
      this.m.pdfium._free(p);
    }
    if (!font) font = this.m.FPDFText_LoadStandardFont(doc, STANDARD[family][variant]);
    if (!font) throw new Error(`Could not load font ${key}`);
    perDoc.set(key, font);
    return font;
  }

  /** Call when a document is closed or reloaded; its font handles die with it. */
  forget(doc: Ptr): void {
    const perDoc = this.loaded.get(doc);
    if (!perDoc) return;
    for (const font of perDoc.values()) this.m.FPDFFont_Close(font);
    this.loaded.delete(doc);
  }
}
