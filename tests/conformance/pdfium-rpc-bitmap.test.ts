// Rendering through the RPC boundary hands the UI a transferred bitmap when one is requested and the
// worker can create it; without createImageBitmap (Node, old WebViews) the raw pixels come back.
import { afterEach, describe, expect, it } from 'vitest';
import type { PdfDocument, PdfEngine, RasterImage, RenderOptions } from '@folio/ports';
import { connectEngine, serveEngine, type RpcPort } from '@folio/engine-pdfium/rpc';

class FakeBitmap {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed = true;
  }
}
class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, ImageBitmap: g.ImageBitmap, ImageData: g.ImageData };
afterEach(() => Object.assign(g, saved));

const fakeDoc = {
  id: 'd1',
  pageCount: 1,
  getPageInfo: async () => ({}),
  render: async (_i: number, o: RenderOptions): Promise<RasterImage> => ({
    width: 2,
    height: 1,
    data: new Uint8ClampedArray(8).fill(o.scale),
  }),
  dispose: () => undefined,
} as unknown as PdfDocument;

/** In-memory ports; the transfer list is recorded instead of applied. */
function link(): { client: RpcPort; server: RpcPort; transferred: unknown[][] } {
  const transferred: unknown[][] = [];
  const client: RpcPort = { postMessage: (m) => queueMicrotask(() => server.onmessage?.({ data: m })), onmessage: null };
  const server: RpcPort = {
    postMessage: (m, t) => (transferred.push((t ?? []) as unknown[]), queueMicrotask(() => client.onmessage?.({ data: m }))),
    onmessage: null,
  };
  return { client, server, transferred };
}
async function open() {
  const { client, server, transferred } = link();
  serveEngine({ open: async () => fakeDoc } as unknown as PdfEngine, server);
  const doc = await connectEngine(client).open(new Uint8Array(1));
  return { doc, transferred };
}

describe('render with a bitmap request over RPC', () => {
  it('returns a transferred bitmap instead of pixels when the worker can create one @FR-VIEW-01', async () => {
    Object.assign(g, {
      ImageBitmap: FakeBitmap,
      ImageData: FakeImageData,
      createImageBitmap: async (d: FakeImageData) => new FakeBitmap(d.width, d.height),
    });
    const { doc, transferred } = await open();
    const img = await doc.render(0, { scale: 1, bitmap: true });
    expect(img.bitmap).toBeInstanceOf(FakeBitmap);
    expect(img).toMatchObject({ width: 2, height: 1 });
    expect(img.data.byteLength).toBe(0);
    expect(transferred.at(-1)).toContain(img.bitmap);
  });
  it('keeps the pixels when no bitmap was asked for or none can be made @FR-VIEW-01', async () => {
    const { doc } = await open();
    expect((await doc.render(0, { scale: 3, bitmap: true })).bitmap).toBeUndefined();
    Object.assign(g, { ImageBitmap: FakeBitmap, ImageData: FakeImageData, createImageBitmap: async () => new FakeBitmap(2, 1) });
    const plain = await doc.render(0, { scale: 3 });
    expect(plain.bitmap).toBeUndefined();
    expect(plain.data[0]).toBe(3);
  });
  it('falls back to pixels when the bitmap cannot be created @FR-VIEW-01', async () => {
    Object.assign(g, {
      ImageBitmap: FakeBitmap,
      ImageData: FakeImageData,
      createImageBitmap: async () => {
        throw new Error('no GPU');
      },
    });
    const { doc } = await open();
    const img = await doc.render(0, { scale: 2, bitmap: true });
    expect(img.bitmap).toBeUndefined();
    expect(img.data.byteLength).toBe(8);
  });
});
