// Visual regression (SPEC §15): UI states in both themes against approved baselines. Baselines are
// rendered with the fonts of the reference machine, so the comparison tolerates small differences;
// update them with `pnpm --filter @folio/web test:e2e --update-snapshots` after an intended change.
import type { Page } from '@playwright/test';
import { dismissCoach, expect, menu, mode, openPdf, test } from './helpers.ts';

test.skip(({ browserName }) => browserName !== 'chromium', 'baselines are kept for Chromium only');

const shot = async (page: Page, name: string): Promise<void> => {
  // Thumbnails and pages are painted asynchronously: wait until nothing is pending.
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot(`${name}.png`, { maxDiffPixelRatio: 0.02, animations: 'disabled', mask: [page.locator('#home h1')] });
};

for (const theme of ['light', 'dark'] as const) {
  test(`screens in the ${theme} theme`, async ({ app }) => {
    await app.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await shot(app, `home-${theme}`);
    await openPdf(app, 'acroform.pdf');
    await dismissCoach(app);
    await shot(app, `view-${theme}`);
    await mode(app, 'Organise');
    await shot(app, `organise-${theme}`);
    await mode(app, 'Annotate');
    await shot(app, `annotate-${theme}`);
    await mode(app, 'Fill & Sign');
    await shot(app, `fill-${theme}`);
    await mode(app, 'Edit');
    await shot(app, `edit-${theme}`);
    await menu(app, 'Merge files…');
    await shot(app, `merge-${theme}`);
    await app.keyboard.press('Escape');
    await menu(app, 'Split document…');
    await shot(app, `split-${theme}`);
    await app.keyboard.press('Escape');
    await app.getByRole('button', { name: 'Settings' }).click();
    await shot(app, `settings-${theme}`);
  });
}
