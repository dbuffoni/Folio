// Default size of dates and signatures follows the page's body text (ticket 142); sizes are read back from
// the saved file and the screens are captured for a visual check.
import { mkdirSync } from 'node:fs';
import { dismissCoach, expect, mode, openPdf, qdf, qpdfCheck, save, test, tool } from './helpers.ts';

const SHOTS = process.env.FOLIO_SHOTS;
const undo = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Undo' }).first();

/** Heights of the /Stamp annotations in the saved file, in file order. */
const stampHeights = (dump: string): number[] =>
  dump
    .split(/\nendobj/)
    .filter((o) => /\/Subtype\s*\/Stamp/.test(o))
    .map((o) => {
      const [y1, y2] = /\/Rect\s*\[([^\]]+)\]/.exec(o)![1]!.trim().split(/\s+/).map(Number).filter((_, i) => i === 1 || i === 3) as [number, number];
      return Math.abs(y2 - y1);
    });

async function dropDateOn(page: import('@playwright/test').Page, index: number, scheme = 'light'): Promise<void> {
  const pv = page.locator('.pv').nth(index);
  await pv.scrollIntoViewIfNeeded();
  await expect(pv.locator('canvas')).toBeVisible();
  const box = (await pv.boundingBox())!;
  await tool(page, 'Insert date').click();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Let the page's text be measured before the click, as a person moving towards the spot would.
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(undo(page)).toBeEnabled();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(200);
    await pv.screenshot({ path: `${SHOTS}/date-page-${index + 1}-${scheme}.png` });
  }
}

test('fill & sign: the date is sized from each page\'s text and Settings changes it @FR-STM-05 @FR-APP-10', async ({ app }, testInfo) => {
  await openPdf(app, 'body-sizes.pdf');
  await mode(app, 'Fill & Sign');
  await dismissCoach(app);
  for (const i of [0, 1, 2]) await dropDateOn(app, i);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await app.locator('.pv').first().scrollIntoViewIfNeeded();
    await app.screenshot({ path: `${SHOTS}/${testInfo.project.name}-dates-default.png` });
  }
  const first = await save(app);
  qpdfCheck(first);
  // 9, 12 and 18 pt body text give 12, 16 and 24 pt tall dates (the order of objects in the file is not the page order).
  const heights = stampHeights(qdf(first)).sort((x, y) => x - y);
  expect(heights).toHaveLength(3);
  [12, 16, 24].forEach((h, i) => expect(heights[i]).toBeCloseTo(h, 0));
});

test('settings: size percentages are validated and used for the next date @FR-STM-05 @FR-APP-10', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const dialog = app.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'General' }).click();
  const date = dialog.getByLabel('Date stamp size (% of page text)');
  const sig = dialog.getByLabel('Signature size (% of page text)');
  await expect(date).toHaveValue('100');
  await expect(sig).toHaveValue('100');
  await date.fill('9999');
  await date.blur();
  await expect(date).toHaveValue('100');
  await expect(app.getByText('Enter a whole number from 25 to 300.')).toBeVisible();
  await date.fill('200');
  await date.blur();
  await expect(date).toHaveValue('200');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  await openPdf(app, 'body-sizes.pdf');
  await mode(app, 'Fill & Sign');
  await dropDateOn(app, 1);
  const out = await save(app);
  expect(stampHeights(qdf(out))[0]).toBeCloseTo(32, 0);
});

for (const [w, h] of [[1360, 860], [1024, 700], [800, 600]] as const) {
  test(`settings screen with the size fields at ${w}x${h} @FR-APP-10`, async ({ app }, testInfo) => {
    test.skip(!SHOTS || testInfo.project.name !== 'chromium', 'screenshots are collected on demand, in Chromium');
    mkdirSync(SHOTS!, { recursive: true });
    await app.setViewportSize({ width: w, height: h });
    for (const scheme of ['light', 'dark'] as const) {
      await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await app.getByRole('button', { name: 'Settings' }).click();
      const dialog = app.getByRole('dialog', { name: 'Settings' });
      await dialog.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'General' }).click();
      await expect(dialog.getByLabel('Signature size (% of page text)')).toBeVisible();
      // No control is clipped by the dialog edge.
      const overlap = await dialog.evaluate((el) => {
        const pane = el.querySelector('.setpane')!;
        const edge = pane.getBoundingClientRect().left + pane.clientWidth;
        return Math.max(...[...pane.querySelectorAll('input, select, button, textarea')].map((c) => c.getBoundingClientRect().right)) - edge;
      });
      expect(overlap).toBeLessThanOrEqual(-8);
      await app.waitForTimeout(300);
      await app.screenshot({ path: `${SHOTS}/settings-${scheme}-${w}x${h}.png` });
      await app.keyboard.press('Escape');
    }
  });
}
