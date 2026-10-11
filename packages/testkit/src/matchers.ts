// Custom Vitest matchers (SPEC §16.4). Registered by setup.ts.
import { expect } from 'vitest';
import type { AnnotationType, PdfDocument, RasterImage } from '@folio/ports';
import { diffImages } from './golden.ts';
import { pdfcpuFormFields, pdfcpuValidate, pdfinfo, pdftotext, qpdfCheck } from './oracles.ts';
import { sharedEngine } from './engine.ts';

async function reopen<T>(pdf: Uint8Array, fn: (doc: PdfDocument) => Promise<T>, password?: string): Promise<T> {
  const engine = await sharedEngine();
  const doc = await engine.open(pdf, { password });
  try {
    return await fn(doc);
  } finally {
    doc.dispose();
  }
}

/** poppler prints this for an AcroForm that only carries default resources; it is harmless. */
const HARMLESS = [/Can't get Fields array/];

expect.extend({
  async toBeValidPdf(received: Uint8Array, opts: { password?: string } = {}) {
    const q = await qpdfCheck(received, opts.password);
    const c = await pdfcpuValidate(received, opts.password);
    const warnings = q.warnings.filter((w) => !HARMLESS.some((h) => h.test(w)));
    const pass = q.ok && warnings.length === 0 && c.ok;
    return {
      pass,
      message: () => (pass ? 'expected PDF not to be valid' : `expected a valid PDF\nqpdf: ${q.output.trim()}\npdfcpu: ${c.output.trim()}`),
    };
  },
  async toHavePageCount(received: Uint8Array, expected: number) {
    const info = await pdfinfo(received);
    return { pass: info.pages === expected, message: () => `expected ${expected} pages (pdfinfo), got ${info.pages}` };
  },
  /** Text extracted by poppler contains every expected string (whitespace-insensitive). */
  async toContainText(received: Uint8Array, expected: string | string[], opts: { page?: number } = {}) {
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const text = norm(await pdftotext(received, { page: opts.page }));
    const missing = (Array.isArray(expected) ? expected : [expected]).filter((e) => !text.includes(norm(e)));
    return {
      pass: missing.length === 0,
      message: () => (missing.length ? `expected text ${JSON.stringify(missing)} in:\n${text.slice(0, 600)}` : `expected text not to contain ${JSON.stringify(expected)}`),
    };
  },
  /** Runs (text only) of a page as read back by the engine. */
  async toHaveTextRuns(received: Uint8Array, expected: string[], page = 0) {
    const runs = await reopen(received, async (doc) => (await doc.getTextLayer(page)).runs.map((r) => r.text.trim()));
    const missing = expected.filter((e) => !runs.includes(e));
    return { pass: missing.length === 0, message: () => `expected runs ${JSON.stringify(missing)} on page ${page + 1}; found ${JSON.stringify(runs)}` };
  },
  async toHaveAnnotation(received: Uint8Array, type: AnnotationType, page = 0) {
    const types = await reopen(received, async (doc) => (await doc.listAnnotations(page)).map((a) => a.type));
    return { pass: types.includes(type), message: () => `expected a ${type} annotation on page ${page + 1}; found ${JSON.stringify(types)}` };
  },
  /** Checked with pdfcpu (independent reader), not with the engine that wrote the value. */
  async toHaveFieldValue(received: Uint8Array, name: string, value: string) {
    const rows = await pdfcpuFormFields(received);
    const row = rows.find((r) => r.name === name);
    return {
      pass: row?.value === value,
      message: () => `expected field "${name}" = ${JSON.stringify(value)}; pdfcpu reports ${row ? JSON.stringify(row.value) : 'no such field'}`,
    };
  },
  toRenderLike(received: RasterImage, expected: RasterImage, opts: { tolerance?: number } = {}) {
    const d = diffImages(expected, received);
    const tolerance = opts.tolerance ?? 0.02;
    return {
      pass: d.sameSize && d.ratio <= tolerance,
      message: () =>
        d.sameSize
          ? `expected renders to differ by at most ${(tolerance * 100).toFixed(2)} % of pixels, got ${(d.ratio * 100).toFixed(2)} %`
          : `render sizes differ: ${received.width}×${received.height} vs ${expected.width}×${expected.height}`,
    };
  },
});

interface FolioMatchers {
  toBeValidPdf(opts?: { password?: string }): Promise<void>;
  toHavePageCount(expected: number): Promise<void>;
  toContainText(expected: string | string[], opts?: { page?: number }): Promise<void>;
  toHaveTextRuns(expected: string[], page?: number): Promise<void>;
  toHaveAnnotation(type: AnnotationType, page?: number): Promise<void>;
  toHaveFieldValue(name: string, value: string): Promise<void>;
  toRenderLike(expected: RasterImage, opts?: { tolerance?: number }): void;
}
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends FolioMatchers {}
}
