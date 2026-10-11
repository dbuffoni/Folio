import type { PdfEngine } from '@folio/ports';
import { createNodeEngine } from '@folio/engine-pdfium/node';

let shared: Promise<PdfEngine> | null = null;
/** One PDFium engine per test worker (loading the WASM takes ~20 ms, but there is no reason to repeat it). */
export function sharedEngine(): Promise<PdfEngine> {
  return (shared ??= createNodeEngine());
}
