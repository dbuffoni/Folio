import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const NO_PLATFORM = {
  patterns: [
    { group: ['@tauri-apps/*'], message: 'Tauri is only allowed in apps/web/src/lib/platform/tauri.ts (SPEC §8.2).' },
    { group: ['node:*', 'fs', 'path', 'os', 'child_process'], message: 'core, services and app must stay platform-independent.' },
    { group: ['**/apps/*', '@folio/web', '@folio/desktop', '@folio/cli'], message: 'Packages never import from apps/.' },
  ],
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/build/**', '**/.svelte-kit/**', '**/target/**', '**/gen/**', 'docs/**', 'fixtures/**', '**/*.generated.ts', 'apps/desktop/shell/**', 'apps/web/static/**', '**/spikes/**', '**/*.svelte', '**/*.cjs', '**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    // Platform independence of the layers below the UI (SPEC §8.2, §16.2).
    files: ['packages/core/src/**/*.ts', 'packages/ports/src/**/*.ts', 'packages/services/src/**/*.ts', 'packages/app/src/**/*.ts', 'packages/ai/src/**/*.ts', 'packages/db/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/testing.ts'],
    rules: {
      'no-restricted-imports': ['error', NO_PLATFORM],
      'no-restricted-globals': ['error', { name: 'window', message: 'No DOM in this layer.' }, { name: 'document', message: 'No DOM in this layer.' }, { name: 'localStorage', message: 'No DOM in this layer.' }, { name: 'navigator', message: 'No DOM in this layer.' }, { name: 'fetch', message: 'Use the HttpClient port.' }],
    },
  },
  { files: ['tools/**', 'apps/cli/**', 'apps/web/scripts/**', '**/*.test.ts', 'tests/**'], rules: { 'no-console': 'off' } },
);
