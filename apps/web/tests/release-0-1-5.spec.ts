import { expect, mode, openPdf, test, tool } from './helpers.ts';

test('first start shows the six-slide tutorial with no document; Back, Next and Done work; it does not return @tutorial @FR-APP-17', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Welcome to Folio' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('heading', { name: 'Five modes, fewer buttons' })).toBeVisible();
  await expect(dialog.getByText('1 of 6')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('heading', { name: 'Forms that fill themselves' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog.getByText('1 of 6')).toBeVisible();
  for (let i = 0; i < 4; i++) await dialog.getByRole('button', { name: 'Next' }).click();
  // Slide 5: data stays on the device, no switch is on (the switches exist on the desktop app only).
  await expect(dialog.getByRole('heading', { name: 'Your files stay on this device' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByText('6 of 6')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Skip' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(4000); // the settings database is written to private storage a moment after the change
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: 'Welcome to Folio' })).toHaveCount(0);
});

test('Skip and Esc close the tutorial; Help > Tutorial opens it again; links open Settings on the pane @tutorial @FR-APP-17', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Welcome to Folio' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Tutorial' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('1 of 6')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Open Profiles in Settings' }).click();
  await expect(dialog).toBeHidden();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('button', { name: 'Profiles' })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Tutorial' }).click();
  await dialog.getByRole('button', { name: 'Skip' }).click();
  await expect(dialog).toBeHidden();
});

test('Smart Fill with no profile shows a popover next to the button, not a toast @FR-AIF-03', async ({ app }) => {
  await openPdf(app, 'acroform.pdf');
  await mode(app, 'Fill & Sign');
  const button = app.getByRole('button', { name: /Smart Fill/ }).first();
  await button.click();
  const pop = app.getByRole('dialog', { name: 'Create a profile first' });
  await expect(pop).toBeVisible();
  await expect(pop.getByRole('button', { name: 'Create profile' })).toBeFocused();
  const b = (await button.boundingBox())!;
  const p = (await pop.boundingBox())!;
  expect(p.y).toBeGreaterThanOrEqual(b.y + b.height - 1);
  expect(Math.abs(p.x + p.width / 2 - (b.x + b.width / 2))).toBeLessThan(p.width / 2 + 20);
  await app.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await pop.getByRole('button', { name: 'Create profile' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('button', { name: 'Profiles' })).toHaveAttribute('aria-current', 'page');
});

test('tool shortcuts are Alt+letter; the bare letters do nothing @FR-APP-18', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await expect(tool(app, 'Select')).toHaveAttribute('aria-pressed', 'true');
  await app.keyboard.press('h');
  await expect(app.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: 'View' })).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Alt+h');
  await expect(app.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: 'Annotate' })).toHaveAttribute('aria-selected', 'true');
  await expect(tool(app, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
  await app.keyboard.press('Alt+v');
  await expect(tool(app, 'Select')).toHaveAttribute('aria-pressed', 'true');
  await app.keyboard.press('Alt+n');
  await expect(tool(app, 'Note')).toHaveAttribute('aria-pressed', 'true');
  await app.keyboard.press('Alt+Shift+r');
  // The shortcuts dialog lists the new keys.
  await app.getByRole('button', { name: 'Main menu' }).click();
  await app.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
  const list = app.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(list.getByText('Alt+V', { exact: true })).toBeVisible();
  await expect(list.getByText('Alt+Shift+R', { exact: true })).toBeVisible();
});

test('the web build has no backup folder and no update check; backups are off by default @FR-APP-04 @FR-APP-16', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'General' }).click();
  await expect(settings.getByRole('checkbox', { name: 'Keep a backup (.bak) when saving' })).not.toBeChecked();
  await expect(settings.getByText('Backup folder')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Privacy' }).click();
  await expect(settings.getByRole('checkbox', { name: 'Check for updates' })).toHaveCount(0);
});
