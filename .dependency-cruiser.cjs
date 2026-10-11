/** Dependency rules of SPEC §8.2 / §16.2. */
const layer = (name) => `^packages/${name}/src`;
const notTests = { pathNot: '(\\.test\\.ts|/testing\\.ts)$' };
module.exports = {
  forbidden: [
    { name: 'no-apps-from-packages', severity: 'error', comment: 'Nothing below imports apps/*', from: { path: '^packages' }, to: { path: '^apps' } },
    { name: 'ports-are-leaf', severity: 'error', from: { path: layer('ports') }, to: { path: '^packages/(?!ports)' } },
    { name: 'core-only-ports', severity: 'error', from: { path: layer('core'), ...notTests }, to: { path: '^packages/(?!core|ports)' } },
    { name: 'services-below-app', severity: 'error', from: { path: layer('services'), ...notTests }, to: { path: '^packages/(app|engine-pdfium|testkit|db|ai)/' } },
    { name: 'app-no-engine', severity: 'error', comment: 'The application layer sees the engine only through the port', from: { path: layer('app'), ...notTests }, to: { path: '^packages/(engine-pdfium|testkit)/' } },
    { name: 'no-testkit-in-product', severity: 'error', from: { path: '^(packages/(core|ports|services|app|db|ai|engine-pdfium)/src|apps/web/src)', ...notTests }, to: { path: '^packages/testkit' } },
    { name: 'no-platform-in-logic', severity: 'error', from: { path: '^packages/(core|ports|services|app|ai|db)/src', ...notTests }, to: { path: '^(node_modules/@tauri-apps|node:|fs$|path$)', dependencyTypes: ['npm', 'core'] } },
    { name: 'tauri-only-in-adapter', severity: 'error', from: { path: '^apps/web/src', pathNot: '^apps/web/src/lib/platform/tauri\\.ts$' }, to: { path: '@tauri-apps' } },
    { name: 'no-circular', severity: 'error', from: { pathNot: '^packages/testkit' }, to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|\\.svelte-kit|/build/|/target/|/gen/|/spikes/)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'], extensions: ['.ts', '.js'] },
  },
};
