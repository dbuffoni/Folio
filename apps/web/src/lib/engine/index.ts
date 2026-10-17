import { connectEngine, type RpcPort } from '@folio/engine-pdfium/rpc';
import type { PdfEngine } from '@folio/ports';
import { instrumentEngine, perfRequested } from '../perf.ts';

/** Starts the engine worker and returns a PdfEngine that talks to it. */
export function createWorkerEngine(): PdfEngine {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const port: RpcPort = { postMessage: (m, t) => worker.postMessage(m, t ?? []), onmessage: null };
  worker.onmessage = (e) => port.onmessage?.({ data: e.data });
  worker.postMessage({ base: new URL('.', document.baseURI).href });
  const engine = connectEngine(port);
  return perfRequested() ? instrumentEngine(engine) : engine;
}

/** Bundled handwriting fonts for typed signatures (same-origin static files). */
export async function loadHandwritingFont(name: string): Promise<Uint8Array> {
  const res = await fetch(new URL(`fonts/handwriting/${name}.ttf`, document.baseURI));
  if (!res.ok) throw new Error(`font ${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
