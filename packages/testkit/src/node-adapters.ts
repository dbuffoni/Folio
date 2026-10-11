// Node implementations of small platform ports, used by tests and folio-cli.
import { webcrypto } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { InvalidArgumentError, UnsupportedFeatureError } from '@folio/core';
import type { Clock, CryptoService, ImageCodec, ImageFormat, Logger } from '@folio/ports';

export class NodeCrypto implements CryptoService {
  randomBytes(n: number): Uint8Array {
    return webcrypto.getRandomValues(new Uint8Array(n));
  }
  async sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await webcrypto.subtle.digest('SHA-256', data));
  }
  private key(raw: Uint8Array): Promise<CryptoKey> {
    if (raw.length !== 32) throw new InvalidArgumentError('AES-256 key must be 32 bytes');
    return webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
  }
  async encrypt(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
    const iv = this.randomBytes(12);
    const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(key), plain));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }
  async decrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 28) throw new InvalidArgumentError('Ciphertext is too short');
    try {
      return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, await this.key(key), data.subarray(12)));
    } catch {
      throw new InvalidArgumentError('Decryption failed (wrong key or corrupted data)');
    }
  }
  async deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210_000 }, base, 256));
  }
}

/** PNG and JPEG via pure-JS codecs. WebP is not available headlessly; the browser adapter provides it. */
export class NodeImageCodec implements ImageCodec {
  supports(format: ImageFormat): boolean {
    return format === 'png' || format === 'jpeg';
  }
  async decode(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray; format: ImageFormat | 'tiff' }> {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), format: 'png' };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), format: 'jpeg' };
    }
    throw new UnsupportedFeatureError('imageFormat', 'Only PNG and JPEG can be decoded in Node');
  }
  async encode(image: { width: number; height: number; data: Uint8ClampedArray }, format: ImageFormat, opts: { quality?: number } = {}): Promise<Uint8Array> {
    if (format === 'png') {
      const png = new PNG({ width: image.width, height: image.height });
      png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length);
      return new Uint8Array(PNG.sync.write(png));
    }
    if (format === 'jpeg') {
      // JPEG has no alpha: composite on white first.
      const flat = Buffer.alloc(image.data.length);
      for (let i = 0; i < image.data.length; i += 4) {
        const a = image.data[i + 3]! / 255;
        flat[i] = image.data[i]! * a + 255 * (1 - a);
        flat[i + 1] = image.data[i + 1]! * a + 255 * (1 - a);
        flat[i + 2] = image.data[i + 2]! * a + 255 * (1 - a);
        flat[i + 3] = 255;
      }
      return new Uint8Array(jpeg.encode({ width: image.width, height: image.height, data: flat }, Math.round((opts.quality ?? 0.9) * 100)).data);
    }
    throw new UnsupportedFeatureError('imageFormat', `${format} encoding is not available in this environment`);
  }
}

export class FakeClock implements Clock {
  constructor(private current = new Date(Date.UTC(2026, 9, 11, 9, 0, 0))) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(d: Date): void {
    this.current = new Date(d);
  }
}

export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  private add(level: string, msg: string, data?: unknown): void {
    this.lines.push(`${level} ${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);
    if (this.lines.length > 500) this.lines.shift();
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
