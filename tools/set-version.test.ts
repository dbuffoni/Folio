import { cpSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION_FILES, checkConsistency, parseVersion, readAll, readVersion, replaceVersion, setAll } from './set-version.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));

function copyOfVersionFiles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'folio-version-'));
  for (const f of VERSION_FILES) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    cpSync(join(repo, f.path), join(dir, f.path));
  }
  return dir;
}

describe('set-version (release file names follow the tag) @FR-APP-15', () => {
  it('accepts tags, bare versions and pre-release suffixes', () => {
    expect(parseVersion('v0.1.4')).toBe('0.1.4');
    expect(parseVersion('refs/tags/v0.1.4-rc1')).toBe('0.1.4-rc1');
    expect(parseVersion('1.20.3')).toBe('1.20.3');
  });

  it('rejects anything that is not a version', () => {
    for (const bad of ['', 'main', 'v1.2', '1.2.3.4', 'v1.2.3 ; rm -rf', undefined]) {
      expect(() => parseVersion(bad)).toThrow(/not a version/);
    }
  });

  it('only touches the version of the Cargo package, not of dependencies', () => {
    const toml = '[package]\nname = "folio"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n';
    expect(replaceVersion('cargo-toml', toml, '0.2.0')).toBe(toml.replace('0.1.0', '0.2.0'));
    const lock = '[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "folio"\nversion = "0.1.0"\n';
    expect(replaceVersion('cargo-lock', lock, '0.2.0')).toBe(lock.replace('"0.1.0"', '"0.2.0"'));
  });

  it('reads and writes files with Windows line ends @FR-APP-15', () => {
    const lock = '[[package]]\r\nname = "folio"\r\nversion = "0.1.0"\r\n';
    expect(readVersion('cargo-lock', lock)).toBe('0.1.0');
    expect(replaceVersion('cargo-lock', lock, '0.2.0')).toBe(lock.replace('0.1.0', '0.2.0'));
    const toml = '[package]\r\nname = "folio"\r\nversion = "0.1.0"\r\n\r\n[dependencies]\r\n';
    expect(replaceVersion('cargo-toml', toml, '0.2.0')).toBe(toml.replace('0.1.0', '0.2.0'));
  });

  it('writes every version file and keeps a pre-release suffix', () => {
    const dir = copyOfVersionFiles();
    try {
      expect(setAll(dir, 'v0.3.1-rc2')).toBe('0.3.1-rc2');
      expect(readAll(dir).map((f) => f.version)).toEqual(VERSION_FILES.map(() => '0.3.1-rc2'));
      expect(checkConsistency(dir)).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).version).toBe('0.3.1-rc2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports files that disagree', () => {
    const dir = copyOfVersionFiles();
    try {
      setAll(dir, '0.9.0');
      // Put one file back to the repository's own version.
      cpSync(join(repo, 'apps/desktop/src-tauri/Cargo.toml'), join(dir, 'apps/desktop/src-tauri/Cargo.toml'));
      const problems = checkConsistency(dir);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/disagree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the files of the repository agree with each other', () => {
    expect(checkConsistency(repo)).toEqual([]);
  });
});
