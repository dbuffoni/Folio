import { defineConfig } from 'vitest/config';

const setupFiles = ['packages/testkit/src/setup.ts'];

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/{core,services,app,db,ai}/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 90, branches: 80 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/cli/src/**/*.test.ts', 'tools/**/*.test.ts'],
          setupFiles,
          testTimeout: 30_000,
        },
      },
      {
        test: { name: 'conformance', include: ['tests/conformance/**/*.test.ts'], setupFiles, testTimeout: 60_000 },
      },
      {
        test: {
          name: 'interop',
          include: ['tests/interop/**/*.test.ts', 'tests/golden/**/*.test.ts'],
          setupFiles,
          testTimeout: 120_000,
        },
      },
      { test: { name: 'perf', include: ['tests/perf/**/*.test.ts'], setupFiles, testTimeout: 300_000 } },
    ],
  },
});
