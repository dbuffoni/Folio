import { afterEach, beforeEach } from 'vitest';
import './matchers.ts';
import { guard } from './warnings.ts';

// Zero-warning guard: a console warning or error, or a Node process warning (deprecations, experimental
// features), fails the test that caused it. A test that provokes one on purpose calls `expectWarnings()`.
const sink = console as unknown as Record<'warn' | 'error', (...args: unknown[]) => void>;
const originals = { warn: sink.warn, error: sink.error };

process.on('warning', (w) => guard.seen.push(`${w.name}: ${w.message}`));

beforeEach(() => {
  guard.allowed = false;
  guard.seen.length = 0;
  for (const level of ['warn', 'error'] as const) {
    sink[level] = (...args: unknown[]) => {
      guard.seen.push(`console.${level}: ${args.map(String).join(' ')}`);
    };
  }
});
afterEach(() => {
  sink.warn = originals.warn;
  sink.error = originals.error;
  // Process warnings are emitted on a later tick: give them one before judging the test.
  return new Promise<void>((resolve, reject) =>
    setImmediate(() => {
      const found = guard.allowed ? [] : [...guard.seen];
      guard.seen.length = 0;
      if (found.length) reject(new Error(`Unexpected warnings:\n${found.join('\n')}`));
      else resolve();
    }),
  );
});
