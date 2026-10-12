// i18n lint (NFR-12): every message key used in the code exists in the catalogue, and Svelte
// templates contain no hard-coded user-visible text. Run by `pnpm lint`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const catalogue = JSON.parse(readFileSync(join(root, 'apps/web/src/lib/i18n/messages/en.json'), 'utf8')) as Record<string, string>;
const keys = new Set(Object.keys(catalogue));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'build' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|svelte)$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const problems: string[] = [];
const used = new Set<string>();
const prefixes = new Set<string>();
const files = [...walk(join(root, 'apps/web/src')), ...walk(join(root, 'packages/app/src')), ...walk(join(root, 'packages/services/src'))];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  const ui = rel.startsWith('apps/web');
  // Literal keys: t('a.b'), tm({ key: 'a.b' }), { key: 'a.b' }, title: 'cmd.x' in the command registry.
  const patterns = [/\bkey:\s*'([a-zA-Z][\w]*(?:\.[\w-]+)+)'/g, /\btitle:\s*'([a-z][\w]*(?:\.[\w-]+)+)'/g];
  if (ui) patterns.push(/\bt\(\s*'([a-zA-Z][\w]*(?:\.[\w-]+)+)'/g);
  for (const re of patterns)
    for (const m of text.matchAll(re)) {
      used.add(m[1]!);
      if (!keys.has(m[1]!)) problems.push(`${rel}: unknown message key "${m[1]}"`);
    }
  // Template keys: t(`sign.tab.${id}`) must match at least one catalogue entry.
  for (const m of text.matchAll(/\bt\(\s*`([a-zA-Z][\w.]*\.)\$\{/g)) {
    prefixes.add(m[1]!);
    if (![...keys].some((k) => k.startsWith(m[1]!))) problems.push(`${rel}: no message key starts with "${m[1]}"`);
  }
  // Hard-coded text between tags of a Svelte template.
  if (file.endsWith('.svelte')) {
    const template = text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const noExpr = template.replace(/\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, '');
    for (const m of noExpr.matchAll(/>([^<>]*[A-Za-z]{2,}[^<>]*)</g)) {
      const s = m[1]!.trim();
      if (/^(F|Folio|pt|px|mm|%|×|·|→|A[3-5])$/.test(s)) continue; // brand, units, ISO paper names
      if (/^(?:(?:Enter|Tab|Esc|Shift|Ctrl|Alt)|[+/ ])+$/.test(s)) continue; // key names
      problems.push(`${rel}: hard-coded text "${s.slice(0, 60)}"`);
    }
    for (const m of noExpr.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*[A-Za-z]{3,}[^"]*)"/g)) problems.push(`${rel}: hard-coded attribute "${m[1]!.slice(0, 60)}"`);
  }
}
const unused = [...keys].filter((k) => !used.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
if (process.argv.includes('--unused')) for (const k of unused) console.warn(`unused: ${k}`);
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`i18n lint: ${problems.length} problem(s)`);
  process.exit(1);
}
console.warn(`i18n lint: ${keys.size} keys, ${used.size} referenced literally, ${unused.length} not referenced literally (computed keys such as error.<code>)`);
