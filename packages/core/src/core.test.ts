import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TextRun } from '@folio/ports';
import {
  DEFAULT_SETTINGS,
  FolioError,
  PAGE_SIZES,
  PasswordRequiredError,
  applyToPoint,
  applyToRect,
  bytesEqual,
  clampRect,
  describePageSize,
  fitRect,
  formatBytes,
  formatDate,
  formatPageRanges,
  fromBase64,
  fromHex,
  groupLines,
  intersect,
  invert,
  isValidPageRanges,
  multiply,
  normalizeRotation,
  pageToViewMatrix,
  parsePageRanges,
  parsePdfDate,
  parseSettings,
  rectFromPoints,
  rotatedSize,
  rotation,
  searchTextLayer,
  splitExt,
  toBase64,
  toHex,
  toPdfDate,
  union,
  uuid,
  viewToPageMatrix,
} from './index.ts';

describe('page ranges @FR-MRG-01 @FR-MRG-04', () => {
  it('parses lists, ranges, open ranges and reverse ranges', () => {
    expect(parsePageRanges('1-3,7,10-', 12)).toEqual([0, 1, 2, 6, 9, 10, 11]);
    expect(parsePageRanges('', 3)).toEqual([0, 1, 2]);
    expect(parsePageRanges(' 3 , 1 ,1', 5)).toEqual([2, 0, 0]);
    expect(parsePageRanges('5-3', 5)).toEqual([4, 3, 2]);
    expect(parsePageRanges('-2', 5)).toEqual([0, 1]);
  });
  it('rejects malformed or out-of-range input', () => {
    for (const bad of ['0', '6', '1-9', 'a', '1,,2', '1-2-3', '-', '1.5']) expect(isValidPageRanges(bad, 5)).toBe(false);
    expect(() => parsePageRanges('9', 5)).toThrow(FolioError);
  });
  it('format ∘ parse is the identity for ascending selections (property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 199 }), { minLength: 1, maxLength: 60 }), (pages) => {
        const sorted = [...pages].sort((a, b) => a - b);
        expect(parsePageRanges(formatPageRanges(sorted), 200)).toEqual(sorted);
      }),
    );
  });
});

describe('geometry', () => {
  const rectArb = fc.record({ x: fc.double({ min: -500, max: 500, noNaN: true }), y: fc.double({ min: -500, max: 500, noNaN: true }), width: fc.double({ min: 1, max: 500, noNaN: true }), height: fc.double({ min: 1, max: 500, noNaN: true }) });
  it('rect helpers', () => {
    expect(rectFromPoints({ x: 5, y: 9 }, { x: 1, y: 2 })).toEqual({ x: 1, y: 2, width: 4, height: 7 });
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersect({ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 5, width: 1, height: 1 })).toBeNull();
    expect(union({ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 5, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 6, height: 6 });
    expect(clampRect({ x: -5, y: 95, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 90, width: 10, height: 10 });
    expect(fitRect({ width: 200, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, 'contain')).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(fitRect({ width: 200, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, 'cover')).toEqual({ x: -50, y: 0, width: 200, height: 100 });
    expect(describePageSize(PAGE_SIZES.A4)).toEqual({ name: 'A4', landscape: false });
    expect(describePageSize({ width: 792, height: 612 })).toEqual({ name: 'Letter', landscape: true });
    expect(describePageSize({ width: 300, height: 200 }).name).toBeUndefined();
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(rotatedSize({ width: 2, height: 3 }, 90)).toEqual({ width: 3, height: 2 });
  });
  it('matrix inverse round-trips points (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -360, max: 360, noNaN: true }), fc.double({ min: 0.1, max: 8, noNaN: true }), fc.double({ min: -300, max: 300, noNaN: true }), fc.double({ min: -300, max: 300, noNaN: true }), (deg, s, x, y) => {
        const m = multiply(rotation(deg, { x: 10, y: 20 }), [s, 0, 0, s, 3, -4]);
        const p = applyToPoint(invert(m), applyToPoint(m, { x, y }));
        expect(p.x).toBeCloseTo(x, 5);
        expect(p.y).toBeCloseTo(y, 5);
      }),
    );
    expect(() => invert([0, 0, 0, 0, 1, 1])).toThrow(RangeError);
  });
  it('page↔view transforms map the page corners for every rotation and invert each other (property)', () => {
    const size = { width: 612, height: 792 };
    expect(applyToPoint(pageToViewMatrix(size, 0, 2), { x: 0, y: 792 })).toEqual({ x: 0, y: 0 });
    expect(applyToPoint(pageToViewMatrix(size, 90, 1), { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(applyToPoint(pageToViewMatrix(size, 180, 1), { x: 612, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(applyToPoint(pageToViewMatrix(size, 270, 1), { x: 612, y: 792 })).toEqual({ x: 0, y: 0 });
    fc.assert(
      fc.property(rectArb, fc.constantFrom(0 as const, 90 as const, 180 as const, 270 as const), fc.double({ min: 0.1, max: 8, noNaN: true }), (r, rot, scale) => {
        const view = applyToRect(pageToViewMatrix(size, rot, scale), r);
        const back = applyToRect(viewToPageMatrix(size, rot, scale), view);
        expect(back.x).toBeCloseTo(r.x, 4);
        expect(back.y).toBeCloseTo(r.y, 4);
        expect(back.width).toBeCloseTo(r.width, 4);
        expect(back.height).toBeCloseTo(r.height, 4);
        const shown = rotatedSize(size, rot);
        const whole = applyToRect(pageToViewMatrix(size, rot, scale), { x: 0, y: 0, ...size });
        expect(whole.x).toBeCloseTo(0, 6);
        expect(whole.width).toBeCloseTo(shown.width * scale, 5);
      }),
    );
  });
});

describe('utilities', () => {
  it('encodes and decodes hex and base64 (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(bytesEqual(fromHex(toHex(bytes)), bytes)).toBe(true);
        expect(bytesEqual(fromBase64(toBase64(bytes)), bytes)).toBe(true);
        expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      }),
    );
  });
  it('dates, sizes, names, ids', () => {
    const d = new Date(Date.UTC(2026, 9, 11, 8, 5, 9));
    expect(toPdfDate(d)).toBe('D:20261011080509Z');
    expect(parsePdfDate('D:20261011080509Z')!.getTime()).toBe(d.getTime());
    expect(parsePdfDate("D:20261011100509+02'00'")!.getTime()).toBe(d.getTime());
    expect(parsePdfDate('garbage')).toBeNull();
    expect(parsePdfDate(undefined)).toBeNull();
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2400)).toBe('2.3 KB');
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(splitExt('report.final.pdf')).toEqual(['report.final', '.pdf']);
    expect(splitExt('.hidden')).toEqual(['.hidden', '']);
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const local = new Date(2026, 9, 3);
    expect(formatDate(local, 'iso')).toBe('2026-10-03');
    expect(formatDate(local, 'dmy')).toBe('03/10/2026');
    expect(formatDate(local, 'mdy')).toBe('10/03/2026');
    expect(formatDate(local, 'long', 'en')).toBe('October 3, 2026');
  });
  it('typed errors carry a code for the message table', () => {
    expect(new PasswordRequiredError().code).toBe('passwordRequired');
    expect(new PasswordRequiredError(true).code).toBe('wrongPassword');
  });
});

describe('settings @FR-APP-10', () => {
  it('has sensible defaults: private AI mode, backups on, 30 s recovery', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ theme: 'system', keepBackup: true, recoveryIntervalSec: 30, units: 'mm', language: 'en' });
    expect(DEFAULT_SETTINGS.ai).toMatchObject({ enabled: false, mode: 'mapping_only', includeImage: false, baseUrl: 'https://api.openai.com/v1' });
  });
  it('validates stored values key by key and falls back to defaults', () => {
    const s = parseSettings({ theme: 'dark', units: 'furlongs', recoveryIntervalSec: 2, unknown: 1, ai: { mode: 'with_values' } });
    expect(s.theme).toBe('dark');
    expect(s.units).toBe('mm');
    expect(s.recoveryIntervalSec).toBe(30);
    expect(s.ai).toMatchObject({ mode: 'with_values', enabled: false });
    expect('unknown' in s).toBe(false);
  });
});

describe('text layer helpers @FR-VIEW-04 @FR-EDT-01', () => {
  const run = (text: string, x: number, y: number, extra: Partial<TextRun> = {}): TextRun => ({
    objId: 'o1', text, rect: { x, y: y - 2, width: text.length * 6, height: 12 }, origin: { x, y }, angle: 0,
    font: { name: 'Helvetica', family: 'Helvetica', isEmbedded: false, isSubset: false, weight: 400, italic: false, flags: 0 },
    fontSize: 12, color: { r: 0, g: 0, b: 0 }, charStart: 0, charCount: text.length, ...extra,
  });
  it('groups adjacent same-style runs on a baseline into one editable line', () => {
    const lines = groupLines([run('Hello ', 10, 100), run('world', 46, 100), run('Next', 10, 80), run('Bold', 40, 80, { fontSize: 14 }), run('Tilt', 10, 50, { angle: 30 }), run('Gen', 10, 20, { objId: undefined })]);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next', 'Bold', 'Tilt', 'Gen']);
    expect(lines.map((l) => l.editable)).toEqual([true, true, true, false, false]);
    expect(lines[0]!.runs).toEqual([0, 1]);
    expect(lines[0]!.rect.width).toBe(66);
  });
  it('finds matches with snippets and per-line rectangles', () => {
    const text = 'Total due\r\nTotal paid';
    const chars = [...text].map((c, i) => ({ text: c, rect: c.trim() ? { x: (i % 11) * 6, y: i < 11 ? 100 : 80, width: 6, height: 10 } : { x: 0, y: 0, width: 0, height: 0 }, origin: { x: 0, y: 0 } }));
    const layer = { page: 4, text, chars, runs: [], lines: [], isScanned: false };
    const hits = searchTextLayer(layer, { text: 'total' });
    expect(hits.map((h) => [h.page, h.charStart, h.charCount])).toEqual([[4, 0, 5], [4, 11, 5]]);
    expect(hits[0]!.rects).toEqual([{ x: 0, y: 100, width: 30, height: 10 }]);
    expect(hits[1]!.snippet).toEqual({ before: 'Total due ', match: 'Total', after: ' paid' });
    expect(searchTextLayer(layer, { text: 'TOTAL', matchCase: true })).toEqual([]);
    expect(searchTextLayer(layer, { text: 'tot', wholeWord: true })).toEqual([]);
    expect(searchTextLayer(layer, { text: 'due\r\nTotal' })[0]!.rects.length).toBe(2);
  });
});
