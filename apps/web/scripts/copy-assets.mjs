// Copies bundled fonts and OCR files into static/ so the same files are served on the web and inside Tauri.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const out = fileURLToPath(new URL('../static/fonts/', import.meta.url));
for (const dir of ['liberation', 'handwriting']) {
  mkdirSync(out + dir, { recursive: true });
  for (const f of readdirSync(assets + dir)) cpSync(`${assets}${dir}/${f}`, `${out}${dir}/${f}`);
}
console.log('fonts copied to static/fonts');
// OCR: the tesseract.js worker, the WebAssembly cores (LSTM only, embedded wasm) and the English and
// Italian data. The library's default is a CDN; nothing is ever fetched from there.
const require = createRequire(import.meta.url);
const ocr = fileURLToPath(new URL('../static/ocr/', import.meta.url));
mkdirSync(join(ocr, 'core'), { recursive: true });
mkdirSync(join(ocr, 'lang'), { recursive: true });
const tess = dirname(require.resolve('tesseract.js/package.json'));
cpSync(join(tess, 'dist', 'worker.min.js'), join(ocr, 'worker.min.js'));
const core = dirname(require.resolve('tesseract.js-core/package.json', { paths: [tess] }));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'])
  if (existsSync(join(core, f))) cpSync(join(core, f), join(ocr, 'core', f));
for (const lang of ['eng', 'ita']) {
  const pkg = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  cpSync(join(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`), join(ocr, 'lang', `${lang}.traineddata.gz`));
}
console.log('OCR files copied to static/ocr');
