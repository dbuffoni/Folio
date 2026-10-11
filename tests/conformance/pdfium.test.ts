import { createNodeEngine } from '@folio/engine-pdfium/node';
import { runEngineConformance } from './engine-suite.ts';

runEngineConformance('pdfium-wasm', () => createNodeEngine(), { realPdf: true });
