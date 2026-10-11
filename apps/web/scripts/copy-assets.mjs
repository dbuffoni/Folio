// Copies bundled fonts into static/ so the same files are served on the web and inside Tauri.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const out = fileURLToPath(new URL('../static/fonts/', import.meta.url));
for (const dir of ['liberation', 'handwriting']) {
  mkdirSync(out + dir, { recursive: true });
  for (const f of readdirSync(assets + dir)) cpSync(`${assets}${dir}/${f}`, `${out}${dir}/${f}`);
}
console.log('fonts copied to static/fonts');
