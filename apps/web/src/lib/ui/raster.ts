import type { RasterImage } from '@folio/ports';

/** Draws an engine raster into a canvas at its native pixel size. */
export function paint(canvas: HTMLCanvasElement, img: RasterImage): void {
  if (canvas.width !== img.width) canvas.width = img.width;
  if (canvas.height !== img.height) canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
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
