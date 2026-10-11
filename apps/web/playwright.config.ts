import { defineConfig } from '@playwright/test';

// End-to-end tests run against the production build of the web app (SPEC §15).
export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1360, height: 860 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm build && pnpm preview --port 4173 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:4173', reuseExistingServer: true, timeout: 180_000 },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
