import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PdfDocument, RasterImage, RenderOptions } from '@folio/ports';
import { RenderService, budgetScale, tileRect } from './render.ts';

const bitmap = () => ({
  width: 10,
  height: 10,
  closed: false,
  close() {
    this.closed = true;
  },
});
function doc(): { doc: PdfDocument; calls: RenderOptions[] } {
  const calls: RenderOptions[] = [];
  return {
    calls,
    doc: {
      render: async (_i: number, o: RenderOptions): Promise<RasterImage> => {
        calls.push(o);
        return o.bitmap
          ? { width: 10, height: 10, data: new Uint8ClampedArray(0), bitmap: bitmap() }
          : { width: 10, height: 10, data: new Uint8ClampedArray(400) };
      },
    } as unknown as PdfDocument,
  };
}

describe('RenderService with bitmaps', () => {
  it('passes the bitmap request to the engine and caches it apart from pixel renders @FR-VIEW-01', async () => {
    const d = doc();
    const r = new RenderService(d.doc);
    const a = await r.render({ page: 0, scale: 1, bitmap: true });
    const b = await r.render({ page: 0, scale: 1 });
    expect(a.bitmap).toBeDefined();
    expect(b.bitmap).toBeUndefined();
    expect(d.calls.map((c) => c.bitmap)).toEqual([true, undefined]);
    expect(await r.render({ page: 0, scale: 1, bitmap: true })).toBe(a);
    expect(r.cachedCount).toBe(2);
  });
  it('counts a bitmap by its decoded size, evicts to the budget and closes what leaves the cache @NFR-03', async () => {
    const d = doc();
    const r = new RenderService(d.doc, { cacheBytes: 800 });
    const first = await r.render({ page: 0, scale: 1, bitmap: true });
    expect(r.cacheBytes).toBe(400);
    await r.render({ page: 1, scale: 1, bitmap: true });
    await r.render({ page: 2, scale: 1, bitmap: true });
    expect(r.cachedCount).toBe(2);
    expect((first.bitmap as unknown as { closed: boolean }).closed).toBe(true);
    const kept = await r.render({ page: 2, scale: 1, bitmap: true });
    r.invalidate([2]);
    expect((kept.bitmap as unknown as { closed: boolean }).closed).toBe(true);
    expect(r.cacheBytes).toBe(400);
  });
});

describe('budgetScale @FR-VIEW-01', () => {
  const A4 = { width: 595, height: 842 };
  const MAX_PX = 4_000_000;
  const MAX_SIDE = 8192;

  it('leaves a page unchanged when it is within the pixel and side budgets @FR-VIEW-01', () => {
    expect(budgetScale(A4, 1)).toBe(1);
    expect(budgetScale(A4, 2)).toBe(2);
  });

  it('lowers the scale of a large page so width × height × scale² fits the pixel budget @FR-VIEW-01', () => {
    const big = { width: 2000, height: 2000 };
    const s = budgetScale(big, 2);
    expect(s).toBeLessThan(2);
    expect(s).toBeGreaterThan(0);
    expect(big.width * big.height * s * s).toBeLessThanOrEqual(MAX_PX * (1 + 1e-9));
  });

  it('honours explicit maxPixels and maxSide arguments @FR-VIEW-01', () => {
    const s = budgetScale({ width: 1000, height: 1000 }, 4, 1_000_000);
    expect(s).toBeLessThanOrEqual(1 + 1e-9);
    expect(1000 * 1000 * s * s).toBeLessThanOrEqual(1_000_000 * (1 + 1e-9));
    expect(budgetScale({ width: 100, height: 100 }, 3, MAX_PX, 150)).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it('still caps the longest side at maxSide when the pixel budget would allow more @FR-VIEW-01', () => {
    // 100 × 20 000 at 1× is 2 Mpx: inside the pixel budget, but the long side is 20 000 px.
    const tall = { width: 100, height: 20_000 };
    const s = budgetScale(tall, 1);
    expect(s).toBeLessThan(1);
    expect(20_000 * s).toBeLessThanOrEqual(MAX_SIDE * (1 + 1e-9));
  });

  it('never raises the scale and always respects both budgets; unchanged when already within them (property) @FR-VIEW-01', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20_000 }),
        fc.integer({ min: 1, max: 20_000 }),
        fc.double({ min: 0.05, max: 8, noNaN: true }),
        (width, height, scale) => {
          const s = budgetScale({ width, height }, scale);
          expect(s).toBeGreaterThan(0);
          expect(s).toBeLessThanOrEqual(scale + 1e-12);
          expect(width * height * s * s).toBeLessThanOrEqual(MAX_PX * (1 + 1e-9));
          expect(Math.max(width, height) * s).toBeLessThanOrEqual(MAX_SIDE * (1 + 1e-9));
          if (width * height * scale * scale <= MAX_PX && Math.max(width, height) * scale <= MAX_SIDE) {
            expect(s).toBe(scale);
          }
        },
      ),
    );
  });
});

describe('tileRect @FR-VIEW-01', () => {
  // Shape as used by the viewer: the page size in CSS px, and the visible window as edges in
  // page-local CSS px (origin at the page's top-left). k converts CSS px to device px.
  const page = { width: 200, height: 300 };
  const full = (k: number) => ({ w: page.width * k, h: page.height * k });
  const edges = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it('returns null when the view misses the page @FR-VIEW-01', () => {
    expect(tileRect(page, edges(-100, 0, -10, 50), 2, 0)).toBeNull();
    expect(tileRect(page, edges(250, 0, 300, 50), 2, 0)).toBeNull();
    expect(tileRect(page, edges(0, 310, 50, 350), 2, 0)).toBeNull();
  });

  it('covers the whole page when the view contains it, clamped to the page @FR-VIEW-01', () => {
    expect(tileRect(page, edges(-50, -50, 500, 500), 2, 0)).toEqual({ x: 0, y: 0, width: 400, height: 600 });
  });

  it('returns the visible part of the page scaled by k @FR-VIEW-01', () => {
    const view = edges(50, 50, 100, 90);
    expect(tileRect(page, view, 2, 0)).toEqual({ x: 100, y: 100, width: 100, height: 80 });
    expect(tileRect(page, view, 3, 0)).toEqual({ x: 150, y: 150, width: 150, height: 120 });
  });

  it('clamps a view that hangs over the page edge to the page bounds @FR-VIEW-01', () => {
    // visible page-local window is x 0..100, y 0..60
    expect(tileRect(page, edges(-20, -40, 100, 60), 2, 0)).toEqual({ x: 0, y: 0, width: 200, height: 120 });
  });

  it('pads an interior tile on every side, without leaving the page @FR-VIEW-01', () => {
    const view = edges(50, 50, 100, 90);
    const bare = tileRect(page, view, 2, 0)!;
    const padded = tileRect(page, view, 2, 10)!;
    expect(padded.x).toBeLessThan(bare.x);
    expect(padded.y).toBeLessThan(bare.y);
    expect(padded.x + padded.width).toBeGreaterThan(bare.x + bare.width);
    expect(padded.y + padded.height).toBeGreaterThan(bare.y + bare.height);
    expect(padded.x).toBeGreaterThanOrEqual(0);
    expect(padded.y).toBeGreaterThanOrEqual(0);
    expect(padded.x + padded.width).toBeLessThanOrEqual(full(2).w);
    expect(padded.y + padded.height).toBeLessThanOrEqual(full(2).h);
  });

  it('never returns a tile smaller than 1 px, even for a sliver of overlap @FR-VIEW-01', () => {
    const t = tileRect(page, edges(199.9, 299.9, 250, 350), 2, 0);
    expect(t).not.toBeNull();
    expect(t!.width).toBeGreaterThanOrEqual(1);
    expect(t!.height).toBeGreaterThanOrEqual(1);
    expect(t!.x + t!.width).toBeLessThanOrEqual(full(2).w + 1e-9);
    expect(t!.y + t!.height).toBeLessThanOrEqual(full(2).h + 1e-9);
  });

  it('stays inside the full device size for any view, pad and scale (property) @FR-VIEW-01', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -300, max: 500 }),
        fc.integer({ min: -300, max: 700 }),
        fc.integer({ min: 1, max: 600 }),
        fc.integer({ min: 1, max: 900 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 30 }),
        (left, top, vw, vh, k, pad) => {
          const view = edges(left, top, left + vw, top + vh);
          const { w: W, h: H } = full(k);
          const overlapX = Math.min(page.width, view.right) - Math.max(0, view.left);
          const overlapY = Math.min(page.height, view.bottom) - Math.max(0, view.top);
          const gapX = Math.max(-view.right, view.left - page.width);
          const gapY = Math.max(-view.bottom, view.top - page.height);
          if (gapX >= 1 || gapY >= 1) {
            // Clearly separated from the page: no tile, even with no pad.
            expect(tileRect(page, view, k, 0)).toBeNull();
          }
          if (overlapX >= 1 && overlapY >= 1) {
            const t = tileRect(page, view, k, pad);
            expect(t).not.toBeNull();
            expect(t!.width).toBeGreaterThanOrEqual(1);
            expect(t!.height).toBeGreaterThanOrEqual(1);
            expect(t!.x).toBeGreaterThanOrEqual(0);
            expect(t!.y).toBeGreaterThanOrEqual(0);
            expect(t!.x + t!.width).toBeLessThanOrEqual(W + 1e-9);
            expect(t!.y + t!.height).toBeLessThanOrEqual(H + 1e-9);
          }
        },
      ),
    );
  });
});
