/// <reference lib="webworker" />
// Engine worker: PDFium WASM runs here so PDF work never blocks the UI (SPEC §8.7).
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { PdfiumEngine, type FontData, type FontVariant } from '@folio/engine-pdfium';
import { serveEngine, type RpcPort } from '@folio/engine-pdfium/rpc';

const FILES: Record<string, Record<FontVariant, string>> = {
  sans: { regular: 'LiberationSans-Regular', bold: 'LiberationSans-Bold', italic: 'LiberationSans-Italic', boldItalic: 'LiberationSans-BoldItalic' },
  serif: { regular: 'LiberationSerif-Regular', bold: 'LiberationSerif-Bold', italic: 'LiberationSerif-Italic', boldItalic: 'LiberationSerif-BoldItalic' },
  mono: { regular: 'LiberationMono-Regular', bold: 'LiberationMono-Bold', italic: 'LiberationMono-Italic', boldItalic: 'LiberationMono-BoldItalic' },
};

let base = '';
/** Bundled fonts are same-origin static files; nothing is fetched from the network. */
async function loadFonts(): Promise<FontData> {
  const out: Record<string, Record<string, Uint8Array>> = {};
  await Promise.all(
    Object.entries(FILES).flatMap(([family, variants]) =>
      Object.entries(variants).map(async ([variant, file]) => {
        const res = await fetch(`${base}fonts/liberation/${file}.ttf`);
        if (!res.ok) throw new Error(`font ${file}: HTTP ${res.status}`);
        (out[family] ??= {})[variant] = new Uint8Array(await res.arrayBuffer());
      }),
    ),
  );
  return out as FontData;
}

async function start(): Promise<PdfiumEngine> {
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`pdfium.wasm: HTTP ${res.status}`);
  return PdfiumEngine.create({ wasmBinary: await res.arrayBuffer(), fonts: loadFonts() });
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const port: RpcPort = { postMessage: (m, t) => scope.postMessage(m, t ?? []), onmessage: null };
let served = false;
scope.onmessage = (event) => {
  // The first message carries the base URL of the app (workers cannot know the page's base).
  if (!served) {
    served = true;
    base = (event.data as { base: string }).base;
    serveEngine(start(), port);
    return;
  }
  port.onmessage?.({ data: event.data });
};
