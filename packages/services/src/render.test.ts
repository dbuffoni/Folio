import { describe, expect, it } from 'vitest';
import type { PdfDocument, RasterImage, RenderOptions } from '@folio/ports';
import { RenderService } from './render.ts';

const bitmap = () => ({ width: 10, height: 10, closed: false, close() { this.closed = true; } });
function doc(): { doc: PdfDocument; calls: RenderOptions[] } {
  const calls: RenderOptions[] = [];
  return {
    calls,
    doc: {
      render: async (_i: number, o: RenderOptions): Promise<RasterImage> => {
        calls.push(o);
        return o.bitmap ? { width: 10, height: 10, data: new Uint8ClampedArray(0), bitmap: bitmap() } : { width: 10, height: 10, data: new Uint8ClampedArray(400) };
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
