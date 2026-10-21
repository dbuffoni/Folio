// Screenshots for release 0.1.4: the new states at several window sizes in both themes.
// From apps/web (build running on :4173): cp ../../tests/visual-sweep/release-0.1.4.mjs _r.mjs && node _r.mjs <outdir>
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const out = resolve(process.argv[2] ?? 'shots');
const base = process.env.BASE ?? 'http://127.0.0.1:4173';
const fixtures = resolve(process.cwd(), '../../fixtures/generated');
mkdirSync(out, { recursive: true });
const SIZES = [[800, 600], [1024, 700], [1366, 768], [1920, 1080]];
const browser = await chromium.launch();
async function open(page, name) {
  const [c] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
  await c.setFiles(resolve(fixtures, name));
  await page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', { name }).and(page.locator('[aria-current=page]')).waitFor({ timeout: 30_000 });
  await page.locator('.pv canvas').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}
const mode = (page, n) => page.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: n }).click();
for (const theme of ['light', 'dark']) {
  for (const [w, h] of SIZES) {
    const tag = `${w}x${h}-${theme}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showSaveFilePicker;
    });
    await page.goto(base + '/');
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30_000 });
    const shot = (n) => page.screenshot({ path: `${out}/${n}-${tag}.png` });

    // 165: signed document: state, question, state after the change.
    await open(page, 'signed-form.pdf');
    await shot('165a-signed-valid');
    await mode(page, 'Annotate');
    await page.getByRole('toolbar').getByRole('button', { name: 'Note', exact: true }).click();
    const box = await page.locator('.pv').first().boundingBox();
    await page.mouse.click(box.x + Math.min(box.width * 0.5, 300), box.y + 200);
    await page.getByRole('dialog').waitFor();
    await shot('165b-signed-question');
    await page.getByRole('button', { name: 'Edit anyway' }).click();
    await page.waitForTimeout(300);
    await page.locator('#statusbar button.sig').click();
    await shot('165c-signed-will-break-menu');
    await page.keyboard.press('Escape');
    await page.locator('#statusbar button.sig').focus();

    // 164: Tab through a two-page form.
    await open(page, 'acroform-multipage.pdf');
    await mode(page, 'Fill & Sign');
    await page.locator('.fld[aria-label="p1.first"]').focus();
    await page.keyboard.type('Ada');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Lovelace');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    await shot('164-tab-second-page');

    // 161: picture-only form read with OCR.
    for (const file of ['test_module_pic.pdf', 'scanned-labelled-form.pdf']) {
      await open(page, file);
      await mode(page, 'Fill & Sign');
      await page.getByRole('button', { name: 'Edit form', exact: true }).click();
      await page.getByRole('button', { name: 'Detect fields', exact: true }).click();
      if (!(await page.getByRole('complementary', { name: 'Inspector' }).isVisible())) await page.getByRole('button', { name: 'Toggle inspector' }).click();
      await page.getByText(/fields proposed/).waitFor({ timeout: 120_000 });
      await page.waitForTimeout(600);
      await shot(`161-${file.replace('.pdf', '')}`);
    }
    await ctx.close();
  }
}
await browser.close();
