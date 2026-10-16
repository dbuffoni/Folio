import type { RasterImage } from '@folio/ports';

/** A field-like shape found in a page image, in pixels of that image (origin top-left). */
export interface ScanArea {
  kind: 'text' | 'checkbox';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Otsu's threshold on a 256-bin histogram, kept in a range that suits paper scans. */
function threshold(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const g of gray) hist[g]!++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let level = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      level = t;
    }
  }
  return Math.min(200, Math.max(90, level));
}

/**
 * Finds what a person would fill in on a scanned or photographed paper form, from the page image alone
 * (no text layer, no AI): underlines and empty boxes for text, small hollow squares for check boxes.
 * `pxPerPoint` is the render scale, so sizes can be stated in points; `rotation` is the page's /Rotate, which
 * decides on which side of an underline the writing space lies.
 */
export function detectScanAreas(image: RasterImage, pxPerPoint: number, rotation: 0 | 90 | 180 | 270 = 0): ScanArea[] {
  const { width: w, height: h, data } = image;
  if (w === 0 || h === 0 || data.length < w * h * 4) return [];
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3]! / 255;
    gray[i] = Math.round((0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!) * a + 255 * (1 - a));
  }
  const level = threshold(gray);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = gray[i]! < level ? 1 : 0;

  const pt = (n: number): number => n * pxPerPoint;
  const out: ScanArea[] = [];
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!dark[start] || seen[start]) continue;
    // One connected shape (8-neighbourhood): its bounding box and how much of that box is ink.
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (dark[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fill = count / (bw * bh);
    // Share of ink in the middle half of the box: an empty box has none, a letter does.
    const inkInside = (): number => {
      const x0 = minX + Math.floor(bw / 4);
      const x1 = maxX - Math.floor(bw / 4);
      const y0 = minY + Math.floor(bh / 4);
      const y1 = maxY - Math.floor(bh / 4);
      let ink = 0;
      let all = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          all++;
          ink += dark[y * w + x]!;
        }
      }
      return all === 0 ? 0 : ink / all;
    };
    const long = Math.max(bw, bh);
    const short = Math.min(bw, bh);
    const limit = Math.max(w, h) * 0.95;
    if (short <= pt(4) && long >= pt(36) && long <= limit) {
      // An underline: the field is the strip on the "up" side of the line (right of it on a page turned by 90°).
      const strip = pt(14);
      if (bw >= bh) {
        const down = rotation === 180;
        const height = down ? Math.min(strip, h - (minY + bh)) : Math.min(strip, minY);
        if (height >= pt(6)) out.push({ kind: 'text', x: minX, y: down ? minY + bh : minY - height, width: bw, height });
      } else {
        const right = rotation === 90;
        const width = right ? Math.min(strip, w - (minX + bw)) : Math.min(strip, minX);
        if (width >= pt(6)) out.push({ kind: 'text', x: right ? minX + bw : minX - width, y: minY, width, height: bh });
      }
    } else if (long >= pt(30) && short >= pt(10) && short <= pt(48) && long <= limit && fill <= 0.2 && inkInside() < 0.02) {
      out.push({ kind: 'text', x: minX, y: minY, width: bw, height: bh });
    } else if (bw >= pt(8) && bw <= pt(22) && bh >= pt(8) && bh <= pt(22) && Math.abs(bw - bh) <= pt(3) && fill <= 0.45 && inkInside() < 0.02) {
      out.push({ kind: 'checkbox', x: minX, y: minY, width: bw, height: bh });
    }
  }
  return out;
}
