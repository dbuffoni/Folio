// Screens bind to their view-models (SPEC §15 headless-first rule): each test drives one screen the
// way a user would and checks the saved file with external tools where a file is the result.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { tabs, choose, dismissCoach, expect, firstPage, menu, mode, openPdf, pageCount, qdf, qpdfCheck, save, test, textOf, tool } from './helpers.ts';

const status = (page: Page) => page.getByRole('contentinfo');

test('viewer: pages, zoom, find and page themes @FR-VIEW-01 @FR-VIEW-04 @FR-VIEW-07', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await expect(status(app).getByText('/ 3')).toBeVisible();
  await status(app).getByRole('button', { name: 'Next page' }).click();
  await expect(status(app).getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
  const zoom = status(app).getByRole('button', { name: 'Zoom', exact: true });
  const before = await zoom.textContent();
  await status(app).getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom).not.toHaveText(before!);

  await app.keyboard.press('Control+f');
  const find = app.getByRole('search');
  await find.getByRole('textbox').fill('Page 3');
  await expect(find.getByText(/1\s*(of|\/)\s*1/)).toBeVisible();
  await find.getByRole('textbox').press('Enter');
  await expect(status(app).getByRole('textbox', { name: 'Page number' })).toHaveValue('3');
  await app.keyboard.press('Escape');

  await tool(app, 'Dark pages').click();
  await expect(tool(app, 'Dark pages')).toHaveAttribute('aria-pressed', 'true');
});

test('organise: delete with undo, rotate, save @FR-ORG-02 @FR-ORG-04 @FR-ORG-05', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  const grid = app.locator('#canvaswrap');
  await grid.getByRole('button', { name: 'Page 2' }).click();
  await tool(app, 'Delete').click();
  await expect(status(app).getByText('/ 2')).toBeVisible();
  await app.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(status(app).getByText('/ 3')).toBeVisible();

  await grid.getByRole('button', { name: 'Page 1' }).click();
  await tool(app, 'Rotate pages right').click();
  await expect(app.getByLabel('Undo', { exact: true })).toBeEnabled();
  await app.keyboard.press('Control+a');
  await expect(app.getByText('3 selected').first()).toBeVisible();
  const out = await save(app);
  expect(pageCount(out)).toBe(3);
  expect(qdf(out)).toMatch(/\/Rotate 90/);
  qpdfCheck(out);
});

test('annotate: highlight selected text and add a note @FR-ANN-01 @FR-ANN-02', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Annotate');
  await tool(app, 'Highlight').click();
  const page = (await firstPage(app).boundingBox())!;
  // Drag across the heading "Page 1 of 3".
  await app.mouse.move(page.x + 100, page.y + 88);
  await app.mouse.down();
  await app.mouse.move(page.x + 200, page.y + 90, { steps: 6 });
  await app.mouse.up();
  await expect(app.getByLabel('Undo', { exact: true })).toBeEnabled();
  await tool(app, 'Note').click();
  await app.mouse.click(page.x + 500, page.y + 300);
  const out = await save(app);
  const dump = qdf(out);
  expect(dump).toMatch(/\/Subtype \/Highlight/);
  expect(dump).toMatch(/\/Subtype \/Text/);
  qpdfCheck(out);
  textOf(out);
});

test('command palette and keyboard reach every task @FR-APP-09 @NFR-11', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await app.keyboard.press('Control+k');
  const palette = app.getByRole('dialog', { name: /command/i }).or(app.locator('.palette')).first();
  await palette.getByRole('textbox').or(palette.getByRole('combobox')).first().fill('split');
  await app.keyboard.press('Enter');
  await expect(app.getByRole('dialog', { name: 'Split document' })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await app.keyboard.press('Control+Shift+O');
  await expect(app.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: 'Organise' })).toHaveAttribute('aria-selected', 'true');
});

test('a password-protected file asks for its password @FR-APP-12', async ({ app }) => {
  await choose(app, () => app.keyboard.press('Control+o'), 'encrypted.pdf');
  const prompt = app.getByRole('dialog');
  await prompt.getByRole('textbox').fill('wrong');
  await prompt.getByRole('textbox').press('Enter');
  await expect(prompt.getByRole('alert')).toBeVisible();
  await prompt.getByRole('textbox').fill('open-sesame');
  await prompt.getByRole('textbox').press('Enter');
  await expect(app.locator('.pv canvas').first()).toBeVisible();
});

test('a broken file is reported, not opened @FR-APP-13', async ({ app }) => {
  await choose(app, () => app.keyboard.press('Control+o'), 'garbage.pdf');
  await expect(app.getByRole('alert').or(app.getByRole('status')).filter({ hasText: /garbage\.pdf|not a PDF|damaged|could not/i }).first()).toBeVisible();
  await expect(tabs(app).locator('.tabb')).toHaveCount(0);
});

test('closing a changed document asks first @FR-APP-07', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  const grid = app.locator('#canvaswrap');
  await grid.getByRole('button', { name: 'Page 1' }).click();
  await tool(app, 'Rotate pages right').click();
  await expect(app.getByLabel('Undo', { exact: true })).toBeEnabled();
  await app.keyboard.press('Control+w');
  const prompt = app.getByRole('dialog');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: /Discard|Don.t save/ }).click();
  await expect(tabs(app).locator('.tabb')).toHaveCount(0);
});

test('theme switch and settings persist across a reload @FR-APP-10', async ({ app }) => {
  await app.getByRole('button', { name: 'Light / dark theme' }).click();
  const theme = await app.evaluate(() => document.documentElement.dataset.theme);
  expect(theme).toMatch(/dark|light/);
  await app.waitForTimeout(500); // settings are written to the browser's private storage shortly after a change
  await app.reload();
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await app.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
});

test.describe('accessibility @NFR-11', () => {
  // Findings are collected over all screens and reported together.
  let found: string[] = [];
  const scan = async (page: Page, what: string): Promise<void> => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    found.push(...serious.map((v) => `${what}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`));
  };
  for (const theme of ['light', 'dark'] as const) {
    test(`no serious axe violations (${theme})`, async ({ app }) => {
      found = [];
      await app.emulateMedia({ colorScheme: theme });
      await scan(app, 'home');
      await openPdf(app, 'acroform.pdf');
      await dismissCoach(app);
      for (const m of ['View', 'Organise', 'Annotate', 'Fill & Sign', 'Edit'] as const) {
        await mode(app, m);
        await scan(app, m);
      }
      for (const item of ['Merge files…', 'Split document…', 'Images to PDF…', 'Export pages as images…', 'Document properties…', 'Keyboard shortcuts']) {
        await menu(app, item);
        await expect(app.getByRole('dialog')).toBeVisible();
        await scan(app, item);
        await app.keyboard.press('Escape');
        await expect(app.getByRole('dialog')).toHaveCount(0);
      }
      await app.keyboard.press('Control+k');
      await scan(app, 'palette');
      await app.keyboard.press('Escape');
      await app.keyboard.press('Control+f');
      await scan(app, 'find');
      await app.keyboard.press('Escape');
      await mode(app, 'Fill & Sign');
      await tool(app, 'Sign').click();
      await app.getByRole('menuitem', { name: 'Create new signature…' }).click();
      await scan(app, 'signature');
      await app.keyboard.press('Escape');
      await app.getByRole('button', { name: 'Settings' }).click();
      for (const pane of ['Smart Fill', 'Profiles', 'General', 'Privacy', 'About']) {
        await app.getByRole('dialog').getByRole('button', { name: pane, exact: true }).click();
        await scan(app, `settings ${pane}`);
      }
      expect(found).toEqual([]);
    });
  }
});

test('nothing leaves the device in the default configuration @NFR-14', async ({ app, outbound }) => {
  await app.getByRole('button', { name: 'Try it with a sample PDF' }).click();
  await expect(app.locator('.pv canvas').first()).toBeVisible();
  await dismissCoach(app);
  await mode(app, 'Fill & Sign');
  await app.getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('dialog').getByRole('button', { name: 'About' }).click();
  await app.waitForTimeout(1000);
  expect(outbound).toEqual([]);
});
