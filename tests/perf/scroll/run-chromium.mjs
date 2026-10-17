// Runs the scroll scenarios in Chromium (Playwright). Usage: node run-chromium.mjs <base-url> <pdf-url> <out.json>
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:4173', pdf = '/perf-300.pdf', out = 'chromium.json'] = process.argv.slice(2);
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const reports = [];
// A fresh page load per run: the render cache would make repeated runs of the same pages free.
async function fresh() {
  await page.goto(`${base}/?perf`);
  await page.waitForFunction(() => window.__folioPerf, null, { timeout: 60_000 });
  await page.evaluate((u) => window.__folioPerf.open(u), pdf);
  await page.waitForSelector('.pv canvas', { timeout: 60_000 });
}
await fresh();
const names = await page.evaluate(() => window.__folioPerf.scenarios);
for (const name of names) {
  for (let i = 0; i < 3; i++) {
    await fresh();
    reports.push(await page.evaluate((n) => window.__folioPerf.run(n), name));
  }
}
writeFileSync(out, JSON.stringify(reports, null, 2));
await browser.close();
console.log(`wrote ${out}`);
