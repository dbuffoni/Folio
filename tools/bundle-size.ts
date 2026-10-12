// Bundle budget (NFR-10): JavaScript of the web build ≤ 600 KB gzip excluding WASM, PDFium WASM
// ≤ 6 MB gzip. Run after `pnpm build`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const build = join(import.meta.dirname, '../apps/web/build');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const gz = (files: string[]): number => files.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
const files = walk(build);
// The SQLite worker bundle ships with its package but is not loaded: the database runs in-page.
const js = gz(files.filter((f) => f.endsWith('.js') && !/sqlite3-(worker1|opfs)/.test(f)));
const pdfium = gz(files.filter((f) => /pdfium.*\.wasm$/.test(f)));
const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
console.warn(`bundle: JavaScript ${kb(js)} gzip (budget 600 KB), PDFium WASM ${kb(pdfium)} gzip (budget 6144 KB)`);
if (js > 600 * 1024 || pdfium > 6 * 1024 * 1024) {
  console.error('bundle: over budget');
  process.exit(1);
}
