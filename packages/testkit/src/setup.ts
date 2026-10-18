import { afterEach, beforeEach } from 'vitest';
import './matchers.ts';

// Zero-warning guard: a console warning or error, or a Node process warning (deprecations, experimental
// features), fails the test that caused it. A test that provokes one on purpose calls `expectWarnings()`.
const seen: string[] = [];
let allowed = false;
const originals = { warn: console.warn, error: console.error };

/** Marks the running test as one that provokes warnings on purpose; they are returned instead of failing it. */
export function expectWarnings(): string[] {
  allowed = true;
  return seen;
}

process.on('warning', (w) => seen.push(`${w.name}: ${w.message}`));

beforeEach(() => {
  allowed = false;
  seen.length = 0;
  for (const level of ['warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      seen.push(`console.${level}: ${args.map(String).join(' ')}`);
    };
  }
});
afterEach(() => {
  console.warn = originals.warn;
  console.error = originals.error;
  // Process warnings are emitted on a later tick: give them one before judging the test.
  return new Promise<void>((resolve, reject) =>
    setImmediate(() => {
      const found = allowed ? [] : [...seen];
      seen.length = 0;
      if (found.length) reject(new Error(`Unexpected warnings:\n${found.join('\n')}`));
      else resolve();
    }),
  );
});
