import { InvalidArgumentError, IoError } from '@folio/core';
import type { Clipboard, Clock, CryptoService, ImageCodec, ImageFormat, Logger, Printing } from '@folio/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** In-memory ring buffer for "Copy diagnostics" (SPEC §8.12). Nothing is uploaded anywhere. */
export class RingLogger implements Logger {
  private lines: string[] = [];
  constructor(private readonly sink?: (level: string, line: string) => void) {}
  private add(level: string, msg: string, data?: unknown): void {
    const line = `${new Date().toISOString()} ${level} ${msg}${data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`}`;
    this.lines.push(line);
    if (this.lines.length > 400) this.lines.shift();
    this.sink?.(level, line);
  }
  debug(msg: string, data?: unknown): void {
    this.add('DEBUG', msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.add('INFO', msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.add('WARN', msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.add('ERROR', msg, data);
  }
  dump(): string {
    return this.lines.join('\n');
  }
}

export class WebCryptoService implements CryptoService {
  randomBytes(n: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(n));
  }
  async sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  }
  private key(raw: Uint8Array): Promise<CryptoKey> {
    if (raw.length !== 32) throw new InvalidArgumentError('AES-256 key must be 32 bytes');
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async encrypt(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
    const iv = this.randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await this.key(key), plain as BufferSource));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }
  async decrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 28) throw new InvalidArgumentError('Ciphertext is too short');
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) as BufferSource }, await this.key(key), data.subarray(12) as BufferSource));
    } catch {
      throw new InvalidArgumentError('Decryption failed (wrong key or corrupted data)');
    }
  }
  async deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 210_000 }, base, 256));
  }
}

const MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Raster codec on top of the browser's own decoders and canvas encoders. */
export class CanvasImageCodec implements ImageCodec {
  private webp: boolean | null = null;
  private canvas(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D } {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) throw new IoError('Canvas is not available');
    return { canvas, ctx };
  }
  supports(format: ImageFormat): boolean {
    if (format !== 'webp') return true;
    if (this.webp === null) {
      // WebKitGTK cannot encode WebP: toDataURL silently falls back to PNG there.
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      this.webp = c.toDataURL('image/webp').startsWith('data:image/webp');
    }
    return this.webp;
  }
  async decode(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray; format: ImageFormat | 'tiff' }> {
    const format: ImageFormat | 'tiff' = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg' : bytes[0] === 0x89 ? 'png' : bytes[0] === 0x52 && bytes[8] === 0x57 ? 'webp' : bytes[0] === 0x49 || bytes[0] === 0x4d ? 'tiff' : 'png';
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    } catch (e) {
      throw new InvalidArgumentError('The image could not be decoded', { reason: 'badImage', detail: String(e) });
    }
    const { ctx } = this.canvas(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const out = { width: bitmap.width, height: bitmap.height, data: new Uint8ClampedArray(data), format };
    bitmap.close();
    return out;
  }
  async encode(image: { width: number; height: number; data: Uint8ClampedArray }, format: ImageFormat, opts: { quality?: number } = {}): Promise<Uint8Array> {
    const { canvas, ctx } = this.canvas(image.width, image.height);
    if (format === 'jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, image.width, image.height);
      // JPEG has no alpha: draw through an intermediate bitmap so transparency blends onto white.
      const tmp = this.canvas(image.width, image.height);
      tmp.ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      ctx.drawImage(tmp.canvas as CanvasImageSource, 0, 0);
    } else {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    }
    const blob = 'convertToBlob' in canvas ? await canvas.convertToBlob({ type: MIME[format], quality: opts.quality }) : await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new IoError('Encoding failed'))), MIME[format], opts.quality));
    return new Uint8Array(await blob.arrayBuffer());
  }
}

export class BrowserClipboard implements Clipboard {
  async readImage(): Promise<Uint8Array | null> {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return new Uint8Array(await (await item.getType(type)).arrayBuffer());
      }
    } catch {
      // Permission denied or unsupported: the paste event path in the UI still works.
    }
    return null;
  }
  async writeImage(png: Uint8Array | Promise<Uint8Array>): Promise<void> {
    // The write is requested now, inside the user gesture; the item resolves when the image is ready.
    const blob = Promise.resolve(png).then((bytes) => new Blob([bytes as BlobPart], { type: 'image/png' }));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }
  async writeText(t: string): Promise<void> {
    await navigator.clipboard.writeText(t);
  }
}

/** Printing through a hidden iframe showing the PDF (SPEC §11.1, risk R6). */
export class IframePrinting implements Printing {
  constructor(private readonly fallback?: (pdf: Uint8Array) => Promise<void>) {}
  async print(pdf: Uint8Array): Promise<void> {
    const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    frame.src = url;
    const cleanup = (): void => {
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        frame.onload = () => {
          try {
            frame.contentWindow!.focus();
            frame.contentWindow!.print();
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        frame.onerror = () => reject(new Error('could not load the print frame'));
        document.body.appendChild(frame);
        setTimeout(() => reject(new Error('print frame timed out')), 8000);
      });
    } catch (e) {
      if (!this.fallback) throw new IoError('Printing is not available here', e);
      await this.fallback(pdf);
    } finally {
      cleanup();
    }
  }
}
