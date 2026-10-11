import { formatDate, type DateFormat } from '@folio/core';
import type { Color, Point, RasterImage, Rect, Size, StampAnnotation, StampAppearance, StandardFontFamily } from '@folio/ports';
import { placeAt, type SignatureService } from './signature.ts';

const RED: Color = { r: 198, g: 40, b: 40 };
const GREEN: Color = { r: 22, g: 128, b: 60 };
const GREY: Color = { r: 90, g: 99, b: 112 };
const BLUE: Color = { r: 29, g: 78, b: 216 };

export type StampKind = 'builtin' | 'text' | 'image' | 'date' | 'selection';
export interface TextStampStyle {
  text: string;
  color: Color;
  fontFamily: StandardFontFamily;
  bold: boolean;
  border: boolean;
  /** Degrees counter-clockwise. */
  rotation: number;
}
/** A stamp as stored in the library (SPEC §9 `stamps`). */
export interface StampDef {
  id: string;
  /** i18n key for built-ins, user-chosen name otherwise. */
  name: string;
  kind: StampKind;
  style?: TextStampStyle;
  /** Built-in mark drawn as vector paths. */
  mark?: 'check' | 'cross' | 'dot';
  dateFormat?: DateFormat;
  raster?: RasterImage;
}

const text = (id: string, label: string, color: Color): StampDef => ({
  id: `builtin:${id}`,
  name: `stamp.${id}`,
  kind: 'builtin',
  style: { text: label, color, fontFamily: 'sans', bold: true, border: true, rotation: 0 },
});
/** FR-STM-06. Labels are the English defaults; the UI localises through `name`. */
export const BUILTIN_STAMPS: StampDef[] = [
  text('approved', 'APPROVED', GREEN),
  text('rejected', 'REJECTED', RED),
  text('draft', 'DRAFT', GREY),
  text('confidential', 'CONFIDENTIAL', RED),
  text('paid', 'PAID', RED),
  text('copy', 'COPY', BLUE),
  text('final', 'FINAL', GREEN),
  text('notApproved', 'NOT APPROVED', RED),
  { id: 'builtin:check', name: 'stamp.check', kind: 'builtin', mark: 'check' },
  { id: 'builtin:cross', name: 'stamp.cross', kind: 'builtin', mark: 'cross' },
  { id: 'builtin:dot', name: 'stamp.dot', kind: 'builtin', mark: 'dot' },
];

const MARKS: Record<NonNullable<StampDef['mark']>, StampAppearance> = {
  check: { kind: 'vector', width: 20, height: 20, paths: [{ segments: [{ op: 'M', x: 3, y: 10 }, { op: 'L', x: 8, y: 4 }, { op: 'L', x: 17, y: 16 }], stroke: { r: 17, g: 17, b: 17 }, strokeWidth: 2.4 }] },
  cross: { kind: 'vector', width: 20, height: 20, paths: [{ segments: [{ op: 'M', x: 4, y: 4 }, { op: 'L', x: 16, y: 16 }], stroke: { r: 17, g: 17, b: 17 }, strokeWidth: 2.4 }, { segments: [{ op: 'M', x: 4, y: 16 }, { op: 'L', x: 16, y: 4 }], stroke: { r: 17, g: 17, b: 17 }, strokeWidth: 2.4 }] },
  dot: {
    kind: 'vector',
    width: 20,
    height: 20,
    paths: [
      {
        // Circle from four Bézier arcs.
        segments: [
          { op: 'M', x: 10, y: 4 },
          { op: 'C', x1: 13.3, y1: 4, x2: 16, y2: 6.7, x: 16, y: 10 },
          { op: 'C', x1: 16, y1: 13.3, x2: 13.3, y2: 16, x: 10, y: 16 },
          { op: 'C', x1: 6.7, y1: 16, x2: 4, y2: 13.3, x: 4, y: 10 },
          { op: 'C', x1: 4, y1: 6.7, x2: 6.7, y2: 4, x: 10, y: 4 },
          { op: 'Z' },
        ],
        fill: { r: 17, g: 17, b: 17 },
      },
    ],
  },
};

/** Approximate natural size in points; the engine fits the artwork inside the rect keeping its aspect. */
export function stampNaturalSize(def: StampDef, dateText?: string): Size {
  if (def.mark) return { width: 14, height: 14 };
  if (def.raster) {
    const height = Math.min(120, Math.max(24, def.raster.height / 3));
    return { width: (def.raster.width / def.raster.height) * height, height };
  }
  const label = dateText ?? def.style?.text ?? '';
  const border = def.style?.border ?? false;
  const height = def.kind === 'date' ? 16 : 30;
  // Bold caps average ~0.68 em; the frame adds padding on both sides.
  const em = border ? height / 1.34 : height / 0.74;
  const width = label.length * em * (def.kind === 'date' ? 0.52 : 0.68) + (border ? em * 0.9 : 0);
  const rot = ((def.style?.rotation ?? 0) * Math.PI) / 180;
  return { width: Math.abs(width * Math.cos(rot)) + Math.abs(height * Math.sin(rot)), height: Math.abs(width * Math.sin(rot)) + Math.abs(height * Math.cos(rot)) };
}

/** Stamps and date stamps as Stamp annotations (FR-STM-05…08). */
export class StampService {
  constructor(private readonly deps: { now: () => Date; locale: () => string }) {}

  dateStamp(format: DateFormat): StampDef {
    return { id: `date:${format}`, name: 'stamp.date', kind: 'date', dateFormat: format, style: { text: '', color: { r: 17, g: 17, b: 17 }, fontFamily: 'sans', bold: false, border: false, rotation: 0 } };
  }
  dateText(format: DateFormat): string {
    return formatDate(this.deps.now(), format, this.deps.locale());
  }
  customText(id: string, name: string, style: TextStampStyle): StampDef {
    return { id, name, kind: 'text', style: { ...style, text: style.text.trim() } };
  }
  customImage(id: string, name: string, raster: RasterImage, kind: 'image' | 'selection' = 'image'): StampDef {
    return { id, name, kind, raster };
  }

  appearance(def: StampDef): StampAppearance {
    if (def.mark) return MARKS[def.mark];
    if (def.raster) return { kind: 'image', image: def.raster };
    const style = def.style!;
    const label = def.kind === 'date' ? this.dateText(def.dateFormat ?? 'iso') : style.text;
    return { kind: 'text', text: label, color: style.color, fontFamily: style.fontFamily, bold: style.bold, border: style.border };
  }

  /** Annotation for dropping `def` centred at `at`. `rect` overrides the natural size (ghost resized by the user). */
  annotation(def: StampDef, at: Point, page: Size, rect?: Rect): StampAnnotation {
    const dateText = def.kind === 'date' ? this.dateText(def.dateFormat ?? 'iso') : undefined;
    const semantic = def.kind === 'date' ? 'Date' : def.mark ? def.mark[0]!.toUpperCase() + def.mark.slice(1) : def.kind === 'builtin' ? def.style!.text : def.name;
    return {
      type: 'stamp',
      name: semantic,
      rect: rect ?? placeAt(at, stampNaturalSize(def, dateText), page),
      rotation: def.style?.rotation ?? 0,
      contents: dateText ?? def.style?.text,
      appearance: this.appearance(def),
    };
  }

  /** Signature placement (FR-STM-03, FR-STM-08): a Stamp annotation named "Signature"/"Initials". */
  signatureAnnotation(signatures: SignatureService, sig: { kind: 'signature' | 'initials'; svg?: string | null; raster: RasterImage; width: number; height: number }, at: Point, page: Size, rect?: Rect): StampAnnotation {
    return { type: 'stamp', name: sig.kind === 'initials' ? 'Initials' : 'Signature', rect: rect ?? placeAt(at, sig, page), appearance: signatures.appearance(sig) };
  }
}

/** Arrow-key nudge of a placed object: 1 pt, 10 pt with Shift (FR-STM-03). */
export function nudge(rect: Rect, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', big: boolean, page: Size): Rect {
  const d = big ? 10 : 1;
  const dx = key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0;
  const dy = key === 'ArrowUp' ? d : key === 'ArrowDown' ? -d : 0;
  return { ...rect, x: Math.min(Math.max(0, rect.x + dx), page.width - rect.width), y: Math.min(Math.max(0, rect.y + dy), page.height - rect.height) };
}
