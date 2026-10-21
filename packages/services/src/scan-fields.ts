import type { RasterImage } from '@folio/ports';

/** A field-like shape found in a page image, in pixels of that image (origin top-left). */
export interface ScanArea {
  kind: 'text' | 'checkbox';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Underlines and dotted rows on an upright page: pixel row of the printed line the text stands on. */
  line?: number;
  /** A row of equal boxes (a comb for one letter per cell): the x of each divider, left to right, in pixels. */
  dividers?: number[];
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
  /** Share of dark pixels in a box; writing space is empty, underlined words are not. */
  const inkIn = (x: number, y: number, bw: number, bh: number): number => {
    let ink = 0;
    let all = 0;
    for (let j = Math.max(0, Math.round(y)); j < Math.min(h, Math.round(y + bh)); j++) {
      for (let i = Math.max(0, Math.round(x)); i < Math.min(w, Math.round(x + bw)); i++) {
        all++;
        ink += dark[j * w + i]!;
      }
    }
    return all === 0 ? 1 : ink / all;
  };
  /** Only the band next to the line counts: tight line spacing puts the previous line's letters further up. */
  const free = (a: ScanArea, side: 'above' | 'below' | 'left' | 'right' = 'above'): boolean => {
    const band = pt(7);
    if (side === 'above') return inkIn(a.x, a.y + Math.max(0, a.height - band), a.width, Math.min(a.height, band)) < 0.01;
    if (side === 'below') return inkIn(a.x, a.y, a.width, Math.min(a.height, band)) < 0.01;
    if (side === 'left') return inkIn(a.x + Math.max(0, a.width - band), a.y, Math.min(a.width, band), a.height) < 0.01;
    return inkIn(a.x, a.y, Math.min(a.width, band), a.height) < 0.01;
  };
  /** x of every vertical stroke that crosses the whole shape, when they are evenly spaced like the cells of a comb. */
  const combDividers = (x: number, y: number, bw: number, bh: number): number[] => {
    const strokes: number[] = [];
    let run: number[] = [];
    const flush = (): void => {
      if (run.length) strokes.push((run[0]! + run[run.length - 1]!) / 2);
      run = [];
    };
    for (let i = x; i < x + bw; i++) {
      let ink = 0;
      for (let j = y; j < y + bh; j++) ink += dark[j * w + i]!;
      if (ink >= bh * 0.85) run.push(i);
      else flush();
    }
    flush();
    if (strokes.length < 4) return [];
    const gaps = strokes.slice(1).map((v, k) => v - strokes[k]!);
    const mean = gaps.reduce((n, g) => n + g, 0) / gaps.length;
    const even = gaps.every((g) => Math.abs(g - mean) <= mean * 0.25);
    return even && mean >= pt(6) && mean <= pt(40) ? strokes : [];
  };
  const out: ScanArea[] = [];
  const dots: Array<{ cx: number; cy: number }> = [];
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
    // Tiny round-ish marks: the dots of a dotted line (collected below, a row of them is one field).
    if (bw <= pt(3) && bh <= pt(3) && count >= 2) {
      dots.push({ cx: minX + bw / 2, cy: minY + bh / 2 });
      continue;
    }
    const long = Math.max(bw, bh);
    const short = Math.min(bw, bh);
    const limit = Math.max(w, h) * 0.95;
    // A comb: boxes side by side that share their borders form one wide shape crossed by full-height dividers.
    if (bw >= bh && long >= pt(30) && short >= pt(10) && short <= pt(48) && long <= limit) {
      const dividers = combDividers(minX, minY, bw, bh);
      if (dividers.length >= 4) {
        out.push({ kind: 'text', x: minX, y: minY, width: bw, height: bh, dividers });
        continue;
      }
    }
    if (short <= pt(4) && long >= pt(36) && long <= limit) {
      // An underline: the field is the strip on the "up" side of the line (right of it on a page turned by 90°).
      const strip = pt(14);
      if (bw >= bh) {
        const down = rotation === 180;
        const height = down ? Math.min(strip, h - (minY + bh)) : Math.min(strip, minY);
        const a: ScanArea = { kind: 'text', x: minX, y: down ? minY + bh : minY - height, width: bw, height };
        if (height >= pt(6) && free(a, down ? 'below' : 'above')) out.push(rotation === 0 ? { ...a, line: minY + bh / 2 } : a);
      } else {
        const right = rotation === 90;
        const width = right ? Math.min(strip, w - (minX + bw)) : Math.min(strip, minX);
        const a: ScanArea = { kind: 'text', x: right ? minX + bw : minX - width, y: minY, width, height: bh };
        if (width >= pt(6) && free(a, right ? 'right' : 'left')) out.push(a);
      }
    } else if (long >= pt(30) && short >= pt(10) && short <= pt(48) && long <= limit && fill <= 0.2 && inkInside() < 0.02) {
      out.push({ kind: 'text', x: minX, y: minY, width: bw, height: bh });
    } else if (bw >= pt(8) && bw <= pt(22) && bh >= pt(8) && bh <= pt(22) && Math.abs(bw - bh) <= pt(3) && fill <= 0.45 && inkInside() < 0.02) {
      out.push({ kind: 'checkbox', x: minX, y: minY, width: bw, height: bh });
    }
  }
  // Dotted lines ("name ……………"): at least eight dots on one level, evenly close together.
  dots.sort((a, b) => a.cx - b.cx);
  const rows: Array<Array<{ cx: number; cy: number }>> = [];
  for (const d of dots) {
    const row = rows.find((r) => Math.abs(r[r.length - 1]!.cy - d.cy) <= pt(1) && d.cx - r[r.length - 1]!.cx <= pt(9) && d.cx >= r[r.length - 1]!.cx);
    if (row) row.push(d);
    else rows.push([d]);
  }
  for (const row of rows) {
    if (row.length < 8) continue;
    const x0 = row[0]!.cx - pt(1);
    const x1 = row[row.length - 1]!.cx + pt(1);
    if (x1 - x0 < pt(36) || x1 - x0 > Math.max(w, h) * 0.95) continue;
    const cy = row.reduce((n, d) => n + d.cy, 0) / row.length;
    const strip = pt(14);
    const horizontal = rotation === 0 || rotation === 180;
    const a: ScanArea = { kind: 'text', x: x0, y: rotation === 180 ? cy + pt(1.5) : cy - strip, width: x1 - x0, height: strip };
    if (horizontal && free({ ...a, height: strip - pt(2) }, rotation === 180 ? 'below' : 'above')) out.push(rotation === 0 ? { ...a, line: cy } : a);
  }
  return out;
}

/**
 * The page image with the printed lines, dotted rows, boxes and squares painted over, so recognition reads the
 * words around them without the strokes that touch or hide them ("number....." read as "nUMDber").
 */
export function blankShapes(image: RasterImage, areas: ScanArea[], pxPerPoint: number): RasterImage {
  const data = new Uint8ClampedArray(image.data);
  const fill = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(image.height, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(image.width, Math.ceil(x1)); x++) data.set([255, 255, 255, 255], (y * image.width + x) * 4);
  };
  const band = 2 * pxPerPoint;
  for (const a of areas) {
    if (a.line !== undefined) fill(a.x - 2, a.line - band, a.x + a.width + 2, a.line + band);
    else fill(a.x - 2, a.y - 2, a.x + a.width + 2, a.y + a.height + 2);
  }
  return { ...image, data };
}
