import type { Methods } from '@embedpdf/pdfium';

export type Ptr = number;
/** The part of the Emscripten runtime the adapter uses. */
export interface WasmRuntime {
  _malloc(size: number): Ptr;
  _free(p: Ptr): void;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  removeFunction(index: number): void;
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
}
export type Pdfium = Methods & { pdfium: WasmRuntime };

/**
 * Scoped WASM heap helper. Everything allocated through an Arena is freed when `scope` returns,
 * so feature code never calls malloc/free directly.
 */
export class Arena {
  private ptrs: Ptr[] = [];
  constructor(readonly m: Pdfium) {}

  alloc(size: number): Ptr {
    const p = this.m.pdfium._malloc(Math.max(size, 1));
    if (!p) throw new Error('WASM heap exhausted');
    this.m.pdfium.HEAPU8.fill(0, p, p + size);
    this.ptrs.push(p);
    return p;
  }
  bytes(data: Uint8Array): Ptr {
    const p = this.alloc(data.length);
    this.m.pdfium.HEAPU8.set(data, p);
    return p;
  }
  /** NUL-terminated UTF-16LE string (FPDF_WIDESTRING). */
  utf16(s: string): Ptr {
    const p = this.alloc((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) this.m.pdfium.HEAPU16[(p >> 1) + i] = s.charCodeAt(i);
    return p;
  }
  /** NUL-terminated UTF-8/Latin string (FPDF_BYTESTRING). */
  utf8(s: string): Ptr {
    const data = new TextEncoder().encode(s);
    const p = this.alloc(data.length + 1);
    this.m.pdfium.HEAPU8.set(data, p);
    return p;
  }
  floats(values: readonly number[]): Ptr {
    const p = this.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) this.m.pdfium.HEAPF32[(p >> 2) + i] = values[i]!;
    return p;
  }
  ints(values: readonly number[]): Ptr {
    const p = this.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) this.m.pdfium.HEAP32[(p >> 2) + i] = values[i]!;
    return p;
  }
  f32(p: Ptr, i = 0): number {
    return this.m.pdfium.HEAPF32[(p >> 2) + i]!;
  }
  f64(p: Ptr, i = 0): number {
    return this.m.pdfium.HEAPF64[(p >> 3) + i]!;
  }
  i32(p: Ptr, i = 0): number {
    return this.m.pdfium.HEAP32[(p >> 2) + i]!;
  }
  u32(p: Ptr, i = 0): number {
    return this.m.pdfium.HEAPU32[(p >> 2) + i]!;
  }
  free(): void {
    for (const p of this.ptrs) this.m.pdfium._free(p);
    this.ptrs = [];
  }
}

export function scope<T>(m: Pdfium, fn: (a: Arena) => T): T {
  const a = new Arena(m);
  try {
    return fn(a);
  } finally {
    a.free();
  }
}

/** Reads a UTF-16LE string of `byteLen` bytes (terminator included or not). */
export function readUtf16(m: Pdfium, p: Ptr, byteLen: number): string {
  let s = '';
  const n = byteLen >> 1;
  const base = p >> 1;
  for (let i = 0; i < n; i++) {
    const c = m.pdfium.HEAPU16[base + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Calls a PDFium "fill my buffer" getter twice (size probe, then read) and decodes UTF-16LE.
 * `call(buffer, byteLength)` must return the required size in bytes.
 */
export function getUtf16(m: Pdfium, call: (buf: Ptr, len: number) => number): string {
  const need = call(0, 0);
  if (need <= 2) return '';
  return scope(m, (a) => {
    const buf = a.alloc(need + 2);
    const got = call(buf, need);
    return readUtf16(m, buf, Math.min(got, need));
  });
}
/** Same as getUtf16 for getters that return 8-bit strings. */
export function getAscii(m: Pdfium, call: (buf: Ptr, len: number) => number): string {
  const need = call(0, 0);
  if (need <= 1) return '';
  return scope(m, (a) => {
    const buf = a.alloc(need + 1);
    const got = Math.min(call(buf, need), need);
    let end = buf;
    while (end < buf + got && m.pdfium.HEAPU8[end] !== 0) end++;
    return new TextDecoder().decode(m.pdfium.HEAPU8.subarray(buf, end));
  });
}

export function copyOut(m: Pdfium, p: Ptr, len: number): Uint8Array {
  return m.pdfium.HEAPU8.slice(p, p + len);
}
