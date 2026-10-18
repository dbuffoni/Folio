// Interaction-latency profiler for the real UI (Chromium). Usage, from apps/web:
//   node ../../tests/perf/ui/run-ui.mjs <base-url> <out.json>
// Needs a running build (pnpm build && pnpm preview --port 4173) and fixtures in fixtures/generated
// (pnpm fixtures:build). It reports, per scenario: wall time, long-task time (> 50 ms), frames over 50 ms,
// and how many model-change notifications the UI received (each one re-evaluates every template that
// reads a model, so a quiet interaction should cause few). Numbers on a machine without a GPU only compare
// builds with each other.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:4173', out = 'ui-perf.json'] = process.argv.slice(2);
const fixtures = resolve(process.cwd(), '../../fixtures/generated');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = {};

async function fresh(viewport = { width: 1360, height: 860 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('folio.perf', '1');
    window.__long = 0;
    window.__frames = { over50: 0, n: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long += Math.max(0, e.duration - 50);
    }).observe({ type: 'longtask', buffered: true });
    let last = performance.now();
    const tick = (t) => {
      window.__frames.n++;
      if (t - last > 50) window.__frames.over50++;
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await page.goto(base + '/');
  await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 60_000 });
  results.bootMs ??= Date.now() - t0;
  return { page, context };
}
async function openFile(page, name) {
  const t0 = Date.now();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
  await chooser.setFiles(resolve(fixtures, name));
  await page.locator('.pv canvas').first().waitFor({ timeout: 60_000 });
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  return Date.now() - t0;
}
async function measure(page, name, action) {
  await page.evaluate(() => {
    window.__long = 0;
    window.__frames = { over50: 0, n: 0 };
    window.__b0 = window.__folioPerf?.bumps?.() ?? 0;
  });
  const t0 = Date.now();
  await action();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const ms = Date.now() - t0;
  const m = await page.evaluate(() => ({ long: Math.round(window.__long), over50: window.__frames.over50, frames: window.__frames.n, bumps: (window.__folioPerf?.bumps?.() ?? 0) - window.__b0 }));
  results[name] = { ms, ...m };
}

{
  const { page, context } = await fresh();
  results.heapAfterBootMB = Math.round((await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)) / 1e6);
  results.openText3Ms = await openFile(page, 'text.pdf');
  await page.waitForFunction(() => window.__folioPerf);

  await measure(page, 'hover 80 toolbar moves', async () => {
    const box = await page.getByRole('toolbar').boundingBox();
    for (let i = 0; i < 80; i++) await page.mouse.move(box.x + 8 + ((i * 17) % (box.width - 16)), box.y + box.height / 2);
  });
  await measure(page, 'hover 80 page moves', async () => {
    const box = await page.locator('.pv').first().boundingBox();
    for (let i = 0; i < 80; i++) await page.mouse.move(box.x + 10 + ((i * 13) % (box.width - 20)), box.y + 10 + ((i * 29) % (box.height - 20)));
  });
  await measure(page, 'switch all five modes', async () => {
    for (const n of ['Organise', 'Annotate', 'Fill & Sign', 'Edit', 'View']) await page.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: n }).click();
  });
  await measure(page, 'open Properties and type 40 characters', async () => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('properties');
    await page.keyboard.press('Enter');
    const title = page.getByLabel('Title', { exact: true });
    await title.fill('');
    await title.pressSequentially('abcdefghijklmnopqrstuvwxyz0123456789ABCD', { delay: 0 });
    await page.keyboard.press('Escape');
  });
  await measure(page, 'open and close Settings dialog 5 times', async () => {
    for (let i = 0; i < 5; i++) {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    }
  });
  await measure(page, 'zoom in/out 10 steps', async () => {
    for (let i = 0; i < 5; i++) await page.keyboard.press('Control+=');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Control+-');
  });
  await context.close();
}
{
  const { page, context } = await fresh();
  results.openText25Ms = await openFile(page, 'text-25.pdf');
  await measure(page, 'scroll 25 pages with the wheel', async () => {
    const box = await page.locator('#canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 700);
  });
  await measure(page, 'organise mode with 25 thumbnails, select all', async () => {
    await page.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: 'Organise' }).click();
    await page.keyboard.press('Control+a');
  });
  await context.close();
}
{
  const { page, context } = await fresh({ width: 800, height: 600 });
  results.openText3Small = await openFile(page, 'text.pdf');
  results.heapAfterOpenMB = Math.round((await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)) / 1e6);
  await context.close();
}
await browser.close();
writeFileSync(out, JSON.stringify(results, null, 2));
console.table(results);
