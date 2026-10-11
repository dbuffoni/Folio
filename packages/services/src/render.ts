import { CancelledError, rotatedSize } from '@folio/core';
import type { PageIndex, PdfDocument, RasterImage, Rotation } from '@folio/ports';

export type RenderPriority = 'visible' | 'near' | 'thumbnail';
const ORDER: Record<RenderPriority, number> = { visible: 0, near: 1, thumbnail: 2 };

interface Job {
  key: string;
  priority: RenderPriority;
  run: () => Promise<RasterImage>;
  resolve: (img: RasterImage) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  seq: number;
}

export interface RenderRequest {
  page: PageIndex;
  /** Device pixels per point (zoom × devicePixelRatio). */
  scale: number;
  rotation?: Rotation;
  /** Tile in device pixels; whole page when omitted. */
  rect?: { x: number; y: number; width: number; height: number };
  priority?: RenderPriority;
  signal?: AbortSignal;
}

/**
 * Prioritised render queue with an LRU bitmap cache bounded by memory (SPEC §8.8):
 * visible pages first, then nearby pages, then thumbnails; stale requests are dropped when aborted.
 */
export class RenderService {
  private cache = new Map<string, RasterImage>();
  private bytes = 0;
  private queue: Job[] = [];
  private pending = new Map<string, Promise<RasterImage>>();
  private busy = false;
  private seq = 0;
  /** Bumped on invalidation so results rendered from old content are not cached. */
  private generation = 0;

  constructor(
    private readonly doc: PdfDocument,
    private readonly opts: { cacheBytes?: number; thumbnailWidth?: number } = {},
  ) {}

  get cacheBytes(): number {
    return this.bytes;
  }
  get cachedCount(): number {
    return this.cache.size;
  }

  private keyOf(r: RenderRequest): string {
    const t = r.rect ? `${r.rect.x},${r.rect.y},${r.rect.width},${r.rect.height}` : 'full';
    return `${r.page}@${r.scale.toFixed(4)}r${r.rotation ?? 0}:${t}`;
  }

  /** Cached bitmap for exactly this request, if any (used for instant repaint). */
  peek(r: RenderRequest): RasterImage | undefined {
    return this.cache.get(this.keyOf(r));
  }

  render(r: RenderRequest): Promise<RasterImage> {
    const key = this.keyOf(r);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    if (r.signal?.aborted) return Promise.reject(new CancelledError());
    const shared = this.pending.get(key);
    if (shared && !r.signal) return shared;
    const promise = new Promise<RasterImage>((resolve, reject) => {
      this.queue.push({
        key,
        priority: r.priority ?? 'visible',
        signal: r.signal,
        seq: this.seq++,
        resolve,
        reject,
        run: () => this.doc.render(r.page, { scale: r.scale, rotation: r.rotation, rect: r.rect }, r.signal),
      });
    });
    if (!r.signal) {
      this.pending.set(key, promise);
      void promise.finally(() => this.pending.delete(key)).catch(() => undefined);
    }
    void this.pump();
    return promise;
  }

  /** Thumbnail no wider than `thumbnailWidth` (default 200 px), cached like any other render. */
  async thumbnail(page: PageIndex, width = this.opts.thumbnailWidth ?? 200, signal?: AbortSignal): Promise<RasterImage> {
    const info = await this.doc.getPageInfo(page);
    const shown = rotatedSize(info.size, info.rotation);
    return this.render({ page, scale: Math.min(width, 200) / shown.width, priority: 'thumbnail', signal });
  }

  /** Drops cached bitmaps of the given pages (all pages when omitted) after a document change. */
  invalidate(pages?: PageIndex[]): void {
    this.generation++;
    for (const [key, img] of this.cache) {
      const page = Number(key.slice(0, key.indexOf('@')));
      if (!pages || pages.includes(page)) {
        this.cache.delete(key);
        this.bytes -= img.data.byteLength;
      }
    }
  }

  private store(key: string, img: RasterImage): void {
    const budget = this.opts.cacheBytes ?? 300 * 1024 * 1024;
    if (img.data.byteLength > budget) return;
    this.cache.set(key, img);
    this.bytes += img.data.byteLength;
    while (this.bytes > budget) {
      const oldest = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(oldest)!.data.byteLength;
      this.cache.delete(oldest);
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => ORDER[a.priority] - ORDER[b.priority] || a.seq - b.seq);
        const job = this.queue.shift()!;
        if (job.signal?.aborted) {
          job.reject(new CancelledError());
          continue;
        }
        const generation = this.generation;
        try {
          const img = await job.run();
          if (generation === this.generation) this.store(job.key, img);
          job.resolve(img);
        } catch (e) {
          job.reject(e);
        }
        // Let newly queued, more urgent work get in between renders.
        await Promise.resolve();
      }
    } finally {
      this.busy = false;
    }
  }
}

/** Target render scale capped so no bitmap side exceeds `maxSide` (SPEC §8.8: 8192 px). */
export function cappedScale(size: { width: number; height: number }, scale: number, maxSide = 8192): number {
  const longest = Math.max(size.width, size.height) * scale;
  return longest > maxSide ? (scale * maxSide) / longest : scale;
}
/** Tiles (1024² by default) covering a region of a page rendered at `scale`. */
export function tilesFor(full: { width: number; height: number }, visible: { x: number; y: number; width: number; height: number }, tile = 1024): Array<{ x: number; y: number; width: number; height: number }> {
  const out = [];
  const x0 = Math.max(0, Math.floor(visible.x / tile));
  const y0 = Math.max(0, Math.floor(visible.y / tile));
  const x1 = Math.min(Math.ceil(full.width / tile), Math.ceil((visible.x + visible.width) / tile));
  const y1 = Math.min(Math.ceil(full.height / tile), Math.ceil((visible.y + visible.height) / tile));
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      out.push({ x: tx * tile, y: ty * tile, width: Math.min(tile, full.width - tx * tile), height: Math.min(tile, full.height - ty * tile) });
    }
  }
  return out;
}
