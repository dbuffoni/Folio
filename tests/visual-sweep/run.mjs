// Screenshot sweep: main screens and dialogs at four window sizes in both themes, for the visual polish pass.
// From apps/web (build running on :4173): cp ../../tests/visual-sweep/run.mjs _vs.mjs && node _vs.mjs <outdir>
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const out = resolve(process.argv[2] ?? 'shots');
const base = process.env.BASE ?? 'http://127.0.0.1:4173';
const fixtures = resolve(process.cwd(), '../../fixtures/generated');
mkdirSync(out, { recursive: true });
const SIZES = [[480, 800], [800, 600], [1024, 700], [1360, 860]];
const browser = await chromium.launch();
async function open(page, name) {
  const [c] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
  await c.setFiles(resolve(fixtures, name));
  // The new tab becomes the current one (the first document's canvas is still on screen until then).
  await page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', { name }).and(page.locator('[aria-current=page]')).waitFor({ timeout: 30_000 });
  await page.locator('.pv canvas').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}
const mode = (page, n) => page.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: n }).click();
const palette = async (page, q) => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type(q);
  await page.keyboard.press('Enter');
};
for (const theme of ['light', 'dark']) {
  for (const [w, h] of SIZES) {
    const tag = `${w}x${h}-${theme}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showSaveFilePicker;
    });
    const errors = [];
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
    await page.goto(base + '/');
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30_000 });
    const shot = (n) => page.screenshot({ path: `${out}/${n}-${tag}.png` });
    const closeDlg = async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    };
    await shot('01-home');
    await open(page, 'annotated.pdf');
    await shot('02-view');
    for (const [n, label] of [['03-organise', 'Organise'], ['04-annotate', 'Annotate'], ['05-fill', 'Fill & Sign'], ['06-edit', 'Edit']]) {
      await mode(page, label);
      await page.waitForTimeout(250);
      await shot(n);
    }
    await mode(page, 'View');
    for (const [n, q] of [['07-properties', 'document properties'], ['08-hidden-data', 'remove hidden data'], ['09-settings', 'settings'], ['10-compress', 'reduce file size'], ['11-digital-sign', 'sign with a certificate'], ['12-verify', 'check digital signatures'], ['13-ocr', 'recognise text'], ['14-split', 'split']]) {
      await palette(page, q);
      await page.waitForTimeout(400);
      await shot(n);
      await closeDlg();
    }
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    await shot('15-palette');
    await closeDlg();
    await open(page, 'restricted.pdf');
    await shot('16-restricted');
    await mode(page, 'Annotate');
    await shot('17-restricted-annotate');
    if (errors.length) console.log(tag, 'console:', errors.slice(0, 3));
    await ctx.close();
  }
}
await browser.close();
console.log('done', out);
