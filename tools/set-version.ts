// Single source of truth for the version: the release tag vX.Y.Z (or an explicit argument).
// Writes the version into every file that carries one, so installer names (Tauri builds them from
// tauri.conf.json), the app's About page and the Cargo package agree with the tag.
//   pnpm exec tsx tools/set-version.ts 0.1.4          set from a version
//   pnpm exec tsx tools/set-version.ts v0.1.4-rc1     a leading "v" (a tag name) is stripped
//   pnpm exec tsx tools/set-version.ts --check        fail when the files disagree with each other
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type Kind = 'json' | 'cargo-toml' | 'cargo-lock';

export const VERSION_FILES: { path: string; kind: Kind }[] = [
  { path: 'package.json', kind: 'json' },
  { path: 'apps/cli/package.json', kind: 'json' },
  { path: 'apps/desktop/package.json', kind: 'json' },
  { path: 'apps/web/package.json', kind: 'json' },
  { path: 'apps/desktop/src-tauri/tauri.conf.json', kind: 'json' },
  { path: 'apps/desktop/src-tauri/Cargo.toml', kind: 'cargo-toml' },
  { path: 'apps/desktop/src-tauri/Cargo.lock', kind: 'cargo-lock' },
];

/** Accepts "0.1.4", "v0.1.4" or "refs/tags/v0.1.4-rc1"; returns the bare version or throws. */
export function parseVersion(input: unknown): string {
  const v = String(input ?? '')
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^v/, '');
  if (!SEMVER.test(v)) throw new Error(`not a version: "${input}" (expected X.Y.Z or X.Y.Z-suffix)`);
  return v;
}

const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
// [package] section only: the first `version = "..."` after the header, before the next section.
const CARGO_TOML_VERSION = /(\[package\][^[]*?\nversion\s*=\s*")([^"]*)(")/;
// Cargo.lock: the entry of the package named "folio".
const CARGO_LOCK_VERSION = /(\[\[package\]\]\nname = "folio"\nversion = ")([^"]*)(")/;

const PATTERN: Record<Kind, RegExp> = { json: JSON_VERSION, 'cargo-toml': CARGO_TOML_VERSION, 'cargo-lock': CARGO_LOCK_VERSION };

export function readVersion(kind: Kind, text: string): string | null {
  const m = PATTERN[kind].exec(text);
  return m ? m[2]! : null;
}

export function replaceVersion(kind: Kind, text: string, version: string): string {
  if (!PATTERN[kind].test(text)) throw new Error(`no version found (${kind})`);
  return text.replace(PATTERN[kind], `$1${version}$3`);
}

export function readAll(root: string) {
  return VERSION_FILES.map((f) => ({ ...f, version: readVersion(f.kind, readFileSync(join(root, f.path), 'utf8')) }));
}

/** Problems found by --check; an empty list means every file carries the same version. */
export function checkConsistency(root: string): string[] {
  const all = readAll(root);
  const problems = all.filter((f) => f.version === null).map((f) => `${f.path}: no version found`);
  const versions = new Set(all.filter((f) => f.version !== null).map((f) => f.version));
  if (versions.size > 1) {
    problems.push(`version files disagree: ${all.map((f) => `${f.path}=${f.version}`).join(', ')}`);
  }
  return problems;
}

export function setAll(root: string, version: string): string {
  const v = parseVersion(version);
  for (const f of VERSION_FILES) {
    const file = join(root, f.path);
    writeFileSync(file, replaceVersion(f.kind, readFileSync(file, 'utf8'), v));
  }
  return v;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const arg = process.argv[2];
  try {
    if (arg === '--check') {
      const problems = checkConsistency(root);
      if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
      }
      console.log(`version files agree: ${readAll(root)[0].version}`);
    } else {
      console.log(`version set to ${setAll(root, arg)}`);
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
