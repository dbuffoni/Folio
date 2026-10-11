// The same conformance suite through the worker RPC boundary (structured clone + transfer),
// using a MessageChannel in place of a Web Worker.
import { MessageChannel } from 'node:worker_threads';
import { createNodeEngine } from '@folio/engine-pdfium/node';
import { connectEngine, serveEngine, type RpcPort } from '@folio/engine-pdfium/rpc';
import { runEngineConformance } from './engine-suite.ts';

const adapt = (port: import('node:worker_threads').MessagePort): RpcPort => {
  const p: RpcPort = { postMessage: (m, t) => port.postMessage(m, (t ?? []) as never), onmessage: null };
  port.on('message', (data) => p.onmessage?.({ data }));
  return p;
};

runEngineConformance(
  'pdfium-wasm over RPC',
  async () => {
    const { port1, port2 } = new MessageChannel();
    serveEngine(createNodeEngine(), adapt(port1));
    const engine = connectEngine(adapt(port2));
    return {
      ...engine,
      dispose: async () => {
        await engine.dispose();
        port1.close();
        port2.close();
      },
    };
  },
  { realPdf: true },
);
