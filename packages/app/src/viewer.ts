import { clamp, rotatedSize } from '@folio/core';
import type { PageIndex, Rotation, Size } from '@folio/ports';

export type ZoomMode = 'fit-width' | 'fit-page' | 'actual' | 'custom';
export type Layout = 'continuous' | 'single' | 'two-page';
export type PageTheme = 'normal' | 'dark' | 'sepia' | 'high-contrast';
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const PAGE_GAP = 12;
export const CANVAS_PADDING = 24;
const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

export interface ViewState {
  page: PageIndex;
  zoomMode: ZoomMode;
  /** Effective zoom (1 = 100 %), also kept for fit modes so the status bar can show it. */
  zoom: number;
  layout: Layout;
  /** Non-destructive view rotation (FR-VIEW-06). */
  rotation: Rotation;
  theme: PageTheme;
}

/** Zoom that makes a page fit the viewport in the given mode (FR-VIEW-01). */
export function fitZoom(page: Size, viewport: Size, mode: ZoomMode, layout: Layout, current = 1): number {
  const columns = layout === 'two-page' ? 2 : 1;
  const availW = Math.max(50, viewport.width - 2 * CANVAS_PADDING - (columns - 1) * PAGE_GAP);
  const availH = Math.max(50, viewport.height - 2 * CANVAS_PADDING);
  switch (mode) {
    case 'fit-width':
      return clamp(availW / (page.width * columns), MIN_ZOOM, MAX_ZOOM);
    case 'fit-page':
      return clamp(Math.min(availW / (page.width * columns), availH / page.height), MIN_ZOOM, MAX_ZOOM);
    case 'actual':
      return 1;
    case 'custom':
      return clamp(current, MIN_ZOOM, MAX_ZOOM);
  }
}
/** Next/previous zoom step for Ctrl+= / Ctrl+-. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return STEPS.find((s) => s > zoom + 0.001) ?? MAX_ZOOM;
  return [...STEPS].reverse().find((s) => s < zoom - 0.001) ?? MIN_ZOOM;
}
/** Ctrl+wheel / pinch: multiplicative zoom, clamped to 10 %–800 %. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clamp(zoom * Math.exp(-deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
}
export const zoomLabel = (v: ViewState): string => `${Math.round(v.zoom * 100)}%`;

export interface PageBox {
  index: PageIndex;
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * Positions of every page in canvas pixels for the given layout and zoom. Continuous and single
 * layouts stack pages; two-page puts them in rows of two (the first page alone, like a book cover).
 */
export function layoutPages(sizes: Array<{ size: Size; rotation: Rotation }>, zoom: number, layout: Layout, viewRotation: Rotation = 0): { boxes: PageBox[]; width: number; height: number } {
  const dims = sizes.map((p) => {
    const s = rotatedSize(p.size, (((p.rotation + viewRotation) % 360) as Rotation));
    return { width: s.width * zoom, height: s.height * zoom };
  });
  const boxes: PageBox[] = [];
  let y = CANVAS_PADDING;
  if (layout === 'two-page') {
    const rows: number[][] = [];
    dims.forEach((_, i) => {
      if (i === 0) rows.push([0]);
      else if ((i - 1) % 2 === 0) rows.push([i]);
      else rows[rows.length - 1]!.push(i);
    });
    const rowWidth = (r: number[]): number => r.reduce((n, i) => n + dims[i]!.width, 0) + (r.length - 1) * PAGE_GAP;
    const width = Math.max(0, ...rows.map(rowWidth)) + 2 * CANVAS_PADDING;
    for (const row of rows) {
      const h = Math.max(...row.map((i) => dims[i]!.height));
      let x = (width - rowWidth(row)) / 2;
      for (const i of row) {
        boxes.push({ index: i, x, y: y + (h - dims[i]!.height) / 2, ...dims[i]! });
        x += dims[i]!.width + PAGE_GAP;
      }
      y += h + PAGE_GAP;
    }
    return { boxes, width, height: y - PAGE_GAP + CANVAS_PADDING };
  }
  const width = Math.max(0, ...dims.map((d) => d.width)) + 2 * CANVAS_PADDING;
  dims.forEach((d, i) => {
    boxes.push({ index: i, x: (width - d.width) / 2, y, ...d });
    y += d.height + PAGE_GAP;
  });
  return { boxes, width, height: Math.max(CANVAS_PADDING * 2, y - PAGE_GAP + CANVAS_PADDING) };
}

/** Pages to mount: those within ±2 viewport heights of the visible area (SPEC §8.8). */
export function visibleRange(boxes: PageBox[], scrollTop: number, viewportHeight: number, overscan = 2): { visible: PageIndex[]; mounted: PageIndex[]; current: PageIndex } {
  const top = scrollTop;
  const bottom = scrollTop + viewportHeight;
  const visible = boxes.filter((b) => b.y + b.height > top && b.y < bottom).map((b) => b.index);
  const mounted = boxes.filter((b) => b.y + b.height > top - overscan * viewportHeight && b.y < bottom + overscan * viewportHeight).map((b) => b.index);
  // The current page is the one covering the most of the viewport (ties → the first).
  let current = visible[0] ?? 0;
  let best = -1;
  for (const b of boxes) {
    const cover = Math.min(b.y + b.height, bottom) - Math.max(b.y, top);
    if (cover > best) {
      best = cover;
      current = b.index;
    }
  }
  return { visible, mounted, current };
}
export interface RenderWindow {
  /** Pages intersecting the viewport. */
  inView: ReadonlySet<PageIndex>;
  /** Pages within one viewport height of it. */
  near: ReadonlySet<PageIndex>;
  /** Pages that keep a mounted canvas. */
  mounted: ReadonlySet<PageIndex>;
  current: PageIndex;
}
/**
 * What to mount and render for a scroll position. Pages are mounted when they come within one
 * viewport of the view and kept until they are three away, so scrolling back and forth does not
 * create and destroy page views.
 */
export function renderWindow(boxes: PageBox[], scrollTop: number, viewportHeight: number, previous: ReadonlySet<PageIndex> = new Set()): RenderWindow {
  const base = visibleRange(boxes, scrollTop, viewportHeight, 1);
  const keep = new Set(visibleRange(boxes, scrollTop, viewportHeight, 3).mounted);
  const mounted = new Set(base.mounted);
  for (const i of previous) if (keep.has(i)) mounted.add(i);
  return { inView: new Set(base.visible), near: new Set(base.mounted), mounted, current: base.current };
}
export const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => a.size === b.size && [...a].every((x) => b.has(x));
export function scrollTopFor(boxes: PageBox[], page: PageIndex): number {
  const b = boxes.find((x) => x.index === page);
  return b ? Math.max(0, b.y - CANVAS_PADDING / 2) : 0;
}

/** Keyboard navigation (FR-VIEW-08). Returns the page to go to, or a scroll amount for Space/PgDn within a page. */
export function navigate(key: 'PageDown' | 'PageUp' | 'Home' | 'End' | 'Space' | 'ShiftSpace' | 'ArrowRight' | 'ArrowLeft', page: PageIndex, pageCount: number, layout: Layout): PageIndex {
  const step = layout === 'two-page' ? 2 : 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return pageCount - 1;
    case 'PageDown':
    case 'Space':
    case 'ArrowRight':
      return Math.min(pageCount - 1, page + step);
    case 'PageUp':
    case 'ShiftSpace':
    case 'ArrowLeft':
      return Math.max(0, page - step);
  }
}
/** Parses the page jump box: "12", " 3 " → 0-based index, or null when out of range. */
export function parsePageJump(text: string, pageCount: number): PageIndex | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= pageCount ? n - 1 : null;
}

/** CSS filter for a reading mode (FR-VIEW-07). Images are re-inverted by the UI using `imageRects`. */
export function themeFilter(theme: PageTheme): string {
  switch (theme) {
    case 'dark':
      return 'invert(0.9) hue-rotate(180deg)';
    case 'sepia':
      return 'sepia(0.55) brightness(0.97)';
    case 'high-contrast':
      return 'grayscale(1) contrast(1.6)';
    default:
      return 'none';
  }
}
export const themeInvertsImages = (theme: PageTheme): boolean => theme === 'dark';
