// Spike S1: PDFium WASM (@embedpdf/pdfium) in plain Node — init, open, render, save.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { init } from '@embedpdf/pdfium';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@embedpdf/pdfium/pdfium.wasm');
const t0 = performance.now();
const m = await init({ wasmBinary: (await readFile(wasmPath)).buffer as ArrayBuffer });
m.PDFiumExt_Init();
console.log('init ms', (performance.now() - t0).toFixed(0), 'keys', Object.keys(m.pdfium).filter((k) => /^(HEAP|_malloc|_free|addFunction|UTF|stringTo|wasm|cwrap|ccall|setValue|getValue)/.test(k)).join(' '));

const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
const page = src.addPage([612, 792]);
page.drawText('Hello Folio', { x: 72, y: 700, size: 24, font });
const bytes = await src.save();

const ptr = m.pdfium._malloc(bytes.length);
m.pdfium.HEAPU8.set(bytes, ptr);
const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
console.log('doc', doc, 'pages', m.FPDF_GetPageCount(doc), 'err', m.FPDF_GetLastError());
const pg = m.FPDF_LoadPage(doc, 0);
const w = 612, h = 792;
const bmp = m.FPDFBitmap_Create(w, h, 0);
m.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
const t1 = performance.now();
m.FPDF_RenderPageBitmap(bmp, pg, 0, 0, w, h, 0, 0x01);
console.log('render ms', (performance.now() - t1).toFixed(1));
const buf = m.FPDFBitmap_GetBuffer(bmp);
const stride = m.FPDFBitmap_GetStride(bmp);
let dark = 0;
for (let i = 0; i < h * stride; i += 4) if (m.pdfium.HEAPU8[buf + i]! < 128) dark++;
console.log('dark pixels', dark, 'stride', stride);
const tp = m.FPDFText_LoadPage(pg);
console.log('chars', m.FPDFText_CountChars(tp));
await writeFile(process.argv[2] ?? '/dev/null', bytes);
