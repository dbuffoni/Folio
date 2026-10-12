// Downloads third-party sample PDFs listed in fixtures/manifest.json into fixtures/fetched and
// verifies their checksums (SPEC §15 fixture policy). Network access happens only when asked.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Entry {
  name: string;
  url: string;
  sha256: string;
  licence?: string;
}
const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'fixtures/manifest.json'), 'utf8')) as { fetched: Entry[] };
const dir = join(root, 'fixtures/fetched');
mkdirSync(dir, { recursive: true });
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

let failed = 0;
for (const e of manifest.fetched) {
  const path = join(dir, e.name);
  if (existsSync(path) && sha(readFileSync(path)) === e.sha256) continue;
  const res = await fetch(e.url);
  if (!res.ok) {
    console.error(`${e.name}: HTTP ${res.status}`);
    failed++;
    continue;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha(bytes) !== e.sha256) {
    console.error(`${e.name}: checksum mismatch, file rejected`);
    failed++;
    continue;
  }
  writeFileSync(path, bytes);
  console.warn(`fetched ${e.name} (${bytes.length} bytes)`);
}
console.warn(`fixtures: ${manifest.fetched.length - failed}/${manifest.fetched.length} third-party files present`);
process.exit(failed ? 1 : 0);
