#!/usr/bin/env node
// Validates a CycloneDX SBOM before it is attached to a release.
//   node tools/validate-sbom.mjs <sbom.cdx.json> [pnpm-lock.yaml] [importer, default apps/web]
// Checks: the JSON parses, bomFormat is CycloneDX, specVersion is set, components is non-empty, and
// (when a lockfile is given) every production npm package that the importer reaches through
// pnpm-lock.yaml (workspace links followed) appears in the SBOM. Plain Node, no dependencies.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

const [sbomPath, lockPath, importer = 'apps/web'] = process.argv.slice(2);
if (!sbomPath) {
  console.error('usage: validate-sbom.mjs <sbom.cdx.json> [pnpm-lock.yaml] [importer]');
  process.exit(2);
}
const errors = [];
const fail = (m) => errors.push(m);

let sbom;
try {
  sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
} catch (e) {
  console.error(`FAIL  ${sbomPath} is not valid JSON: ${e.message}`);
  process.exit(1);
}
if (sbom.bomFormat !== 'CycloneDX') fail(`bomFormat is ${JSON.stringify(sbom.bomFormat)}, expected "CycloneDX"`);
if (typeof sbom.specVersion !== 'string' || !sbom.specVersion) fail('specVersion is missing');
const components = Array.isArray(sbom.components) ? sbom.components : [];
if (components.length === 0) fail('components is missing or empty');

/** Identity of an SBOM component as "name@version" (scoped names rejoined). */
const present = new Set();
for (const c of components) {
  if (!c || typeof c.name !== 'string') continue;
  const full = c.group ? `${c.group.startsWith('@') ? c.group : `@${c.group}`}/${c.name}` : c.name;
  present.add(`${full}@${c.version ?? ''}`);
  if (typeof c.purl === 'string') {
    const m = /^pkg:npm\/(.+)@([^@?#]+)/.exec(c.purl);
    if (m) present.add(`${decodeURIComponent(m[1])}@${m[2]}`);
  }
}
const presentNames = new Set([...present].map((p) => p.slice(0, p.lastIndexOf('@'))));

let expected = 0;
if (lockPath) {
  const lock = parseLock(readFileSync(lockPath, 'utf8'));
  if (!lock.importers.has(importer)) fail(`importer ${importer} not found in ${lockPath}`);
  const wanted = new Set(); // "name@version"
  const seenImporters = new Set();
  const visitImporter = (id) => {
    if (seenImporters.has(id)) return;
    seenImporters.add(id);
    for (const [name, version] of lock.importers.get(id) ?? []) {
      if (version.startsWith('link:')) visitImporter(posix.normalize(posix.join(id, version.slice(5))));
      else visitSnapshot(name, version);
    }
  };
  const visitSnapshot = (name, version) => {
    const v = version.replace(/\(.*$/, '');
    const key = `${name}@${v}`;
    if (wanted.has(key)) return;
    wanted.add(key);
    const snap = lock.snapshots.get(`${name}@${version}`) ?? lock.snapshots.get(key);
    for (const [n, ver] of snap ?? []) {
      // An alias dependency is written "real-name@1.2.3".
      if (ver.startsWith('link:')) continue;
      const alias = /^(@?[^@]+)@(.+)$/.exec(ver);
      if (alias && !/^\d/.test(ver)) visitSnapshot(alias[1], alias[2]);
      else visitSnapshot(n, ver);
    }
  };
  visitImporter(importer);
  expected = wanted.size;
  const missing = [...wanted].filter((w) => !present.has(w));
  // Same name at another version means the SBOM was generated from a different tree.
  for (const m of missing.slice(0, 25)) fail(`in ${posix.basename(lockPath)} but not in the SBOM: ${m}${presentNames.has(m.slice(0, m.lastIndexOf('@'))) ? ' (other version present)' : ''}`);
  if (missing.length > 25) fail(`... and ${missing.length - 25} more missing packages (${missing.length} in total)`);
}

if (errors.length) {
  console.error(`FAIL  ${sbomPath}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`OK    ${sbomPath}: CycloneDX ${sbom.specVersion}, ${components.length} components${lockPath ? `, all ${expected} production packages of ${importer} found` : ''}`);

/** Minimal reader for the importers and snapshots sections of a pnpm lockfile v9. */
function parseLock(text) {
  const importers = new Map(); // id -> [[name, version]] (prod + optional)
  const snapshots = new Map(); // "name@version(peers)" -> [[name, version]]
  let section = '';
  let cur = null;
  let list = null;
  const unq = (s) => s.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, '');
      cur = list = null;
      continue;
    }
    const indent = /^ */.exec(line)[0].length;
    const body = line.trim();
    if (!body) continue;
    if (section === 'importers') {
      if (indent === 2) {
        cur = unq(body.replace(/:$/, ''));
        importers.set(cur, []);
        list = null;
      } else if (indent === 4) list = body === 'dependencies:' || body === 'optionalDependencies:' ? importers.get(cur) : null;
      else if (indent === 6 && list && body.endsWith(':')) {
        // "name:" then "specifier:" and "version:" lines.
        const name = unq(body.slice(0, -1));
        let version = '';
        for (let j = i + 1; j < lines.length && /^ {8}/.test(lines[j]); j++) {
          const m = /^ {8}version: (.*)$/.exec(lines[j]);
          if (m) version = unq(m[1]);
        }
        list.push([name, version]);
      }
    } else if (section === 'snapshots') {
      if (indent === 2) {
        cur = unq(body.replace(/:( \{\})?$/, ''));
        snapshots.set(cur, []);
        list = null;
      } else if (indent === 4) list = body === 'dependencies:' || body === 'optionalDependencies:' ? snapshots.get(cur) : null;
      else if (indent === 6 && list) {
        const m = /^('[^']+'|"[^"]+"|[^:]+): (.*)$/.exec(body);
        if (m) list.push([unq(m[1]), unq(m[2])]);
      }
    }
  }
  return { importers, snapshots };
}
