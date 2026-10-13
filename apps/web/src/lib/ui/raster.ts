import type { RasterImage } from '@folio/ports';

/** Draws an engine raster into a canvas at its native pixel size. */
export function paint(canvas: HTMLCanvasElement, img: RasterImage): void {
  if (canvas.width !== img.width) canvas.width = img.width;
  if (canvas.height !== img.height) canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  if (img.bitmap) {
    try {
      ctx.drawImage(img.bitmap as unknown as ImageBitmap, 0, 0);
    } catch {
      // The cache closed this bitmap after the request was answered; the next render replaces it.
    }
    return;
  }
  ctx.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
}

const POOL_LIMIT = 12;
const pool: HTMLCanvasElement[] = [];
/**
 * Svelte action: gives the page box a recycled canvas as its first child and hands it back when the
 * page unmounts. Re-using canvases of the same size avoids reallocating their backing stores while
 * pages come and go during a scroll.
 */
export function pooledCanvas(node: HTMLElement, onCanvas: (canvas: HTMLCanvasElement) => void) {
  const canvas = pool.pop() ?? document.createElement('canvas');
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  node.prepend(canvas);
  onCanvas(canvas);
  return {
    destroy() {
      canvas.remove();
      canvas.style.filter = '';
      if (pool.length < POOL_LIMIT) pool.push(canvas);
      else {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  };
}
const pending = new Map<HTMLCanvasElement, { img: RasterImage; stale: () => boolean }>();
let frame = 0;
function flush(): void {
  frame = 0;
  for (const [canvas, job] of pending) {
    pending.delete(canvas);
    if (job.stale()) continue;
    paint(canvas, job.img);
    break;
  }
  if (pending.size) frame = requestAnimationFrame(flush);
}
/** Like `paint`, but at most one canvas per animation frame so bitmaps arriving together do not stall scrolling. */
export function paintSoon(canvas: HTMLCanvasElement, img: RasterImage, stale: () => boolean = () => false): void {
  pending.set(canvas, { img, stale });
  if (!frame) frame = requestAnimationFrame(flush);
}
export function pngUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
}
/** Svelte action: shows PNG bytes in an <img>, revoking the object URL when it changes or goes away. */
export function png(node: HTMLImageElement, bytes: Uint8Array | null | undefined) {
  let url = '';
  const set = (b: Uint8Array | null | undefined): void => {
    if (url) URL.revokeObjectURL(url);
    url = b ? pngUrl(b) : '';
    node.src = url;
  };
  set(bytes);
  return { update: set, destroy: () => url && URL.revokeObjectURL(url) };
}
export const rgb = (c?: { r: number; g: number; b: number } | null): string => (c ? `rgb(${c.r},${c.g},${c.b})` : 'transparent');
export function hexToColor(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export const colorToHex = (c: { r: number; g: number; b: number }): string => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
