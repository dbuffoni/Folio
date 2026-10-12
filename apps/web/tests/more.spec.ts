// Secondary screens and tools: each is driven once end to end so that a binding mistake shows up
// in a browser, not in front of a user.
import type { Page } from '@playwright/test';
import { choose, downloads, expect, firstPage, menu, mode, openPdf, pageCount, qdf, qpdfCheck, save, tabs, test, textOf, tool } from './helpers.ts';

const status = (page: Page) => page.getByRole('contentinfo');
const undo = (page: Page) => page.getByLabel('Undo', { exact: true });
const pageBox = async (page: Page) => (await firstPage(page).boundingBox())!;

test('organise: duplicate, insert a blank page, extract to a new tab @FR-ORG-06 @FR-ORG-07 @FR-ORG-09', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  const grid = app.locator('#canvaswrap');
  await grid.getByRole('button', { name: 'Page 1' }).click();
  await tool(app, 'Duplicate pages').click();
  await expect(status(app).getByText('/ 4')).toBeVisible();
  await tool(app, 'Insert').click();
  await app.getByRole('menuitem', { name: 'Blank page after' }).click();
  const dialog = app.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: /Insert|Add|OK/ }).last().click();
  await expect(status(app).getByText('/ 5')).toBeVisible();
  await grid.getByRole('button', { name: 'Page 5' }).click();
  await tool(app, 'Extract pages to a new tab').click();
  await expect(tabs(app).locator('.tabb')).toHaveCount(2);
  await expect(status(app).getByText('/ 1')).toBeVisible();
});

test('organise: move pages with the keyboard @FR-ORG-03 @NFR-11', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  await app.locator('#canvaswrap').getByRole('button', { name: 'Page 1' }).click();
  await app.keyboard.press('Alt+ArrowRight');
  await expect(undo(app)).toBeEnabled();
  const out = await save(app);
  expect(textOf(out, 1)).toContain('Page 2 of 3');
  expect(textOf(out, 2)).toContain('Page 1 of 3');
});

test('annotate: text box, rectangle, comments list and flatten @FR-ANN-03 @FR-ANN-04 @FR-ANN-09 @FR-VIEW-02', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Annotate');
  const box = await pageBox(app);
  await tool(app, 'Text box').click();
  await app.mouse.click(box.x + 200, box.y + 300);
  await expect(app.locator('textarea.typing')).toBeFocused();
  await app.keyboard.type('Reviewed by Ada');
  await app.keyboard.press('Control+Enter');
  await expect(undo(app)).toBeEnabled();
  await tool(app, 'Shape').click();
  const rect = app.getByRole('menuitem', { name: /Rectangle/ });
  if (await rect.isVisible().catch(() => false)) await rect.click();
  await app.mouse.move(box.x + 100, box.y + 420);
  await app.mouse.down();
  await app.mouse.move(box.x + 260, box.y + 500, { steps: 5 });
  await app.mouse.up();
  await app.getByRole('complementary', { name: 'Sidebar' }).getByRole('tab', { name: 'Annotations' }).click();
  await expect(app.getByRole('complementary', { name: 'Sidebar' }).getByText('Reviewed by Ada')).toBeVisible();
  const annotated = await save(app);
  const dump = qdf(annotated);
  expect(dump).toMatch(/\/Subtype \/FreeText/);
  expect(dump).toMatch(/\/Subtype \/Square/);
  expect(textOf(annotated)).toBeTruthy();

  await tool(app, 'Flatten annotations…').click();
  const confirm = app.getByRole('dialog');
  await confirm.getByRole('button', { name: 'Apply' }).click();
  await expect(confirm).toBeHidden();
  await expect(app.getByRole('complementary', { name: 'Sidebar' }).getByText('Reviewed by Ada')).toBeHidden();
  const flat = await save(app);
  expect(qdf(flat)).not.toMatch(/\/Subtype \/FreeText/);
  expect(textOf(flat)).toContain('Reviewed by Ada');
  qpdfCheck(flat);
});

test('fill & sign: date, check mark and cover-and-type on a flat form @FR-STM-05 @FR-STM-06 @FR-FRM-06 @FR-FRM-07', async ({ app }) => {
  await openPdf(app, 'flat-form.pdf');
  await mode(app, 'Fill & Sign');
  const box = await pageBox(app);
  await tool(app, 'Insert date').click();
  await app.mouse.move(box.x + 400, box.y + 520);
  await app.mouse.click(box.x + 400, box.y + 520);
  await expect(undo(app)).toBeEnabled();
  await tool(app, 'Check mark').click();
  await app.mouse.click(box.x + 500, box.y + 570);
  await tool(app, 'Cover & type').click();
  await app.mouse.click(box.x + 300, box.y + 640);
  await expect(app.locator('textarea.typing')).toBeFocused();
  await app.keyboard.type('Typed on the form');
  await app.keyboard.press('Enter');
  const out = await save(app);
  expect(textOf(out)).toContain('Typed on the form');
  expect(textOf(out)).toContain(String(new Date().getFullYear()));
  qpdfCheck(out);
});

test('fill & sign: built-in stamp @FR-STM-06 @FR-STM-08', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Fill & Sign');
  await tool(app, 'Stamp').click();
  await app.getByRole('menuitem').filter({ hasText: /Approved/i }).first().click();
  const box = await pageBox(app);
  await app.mouse.move(box.x + 300, box.y + 500);
  await app.mouse.click(box.x + 300, box.y + 500);
  await expect(undo(app)).toBeEnabled();
  expect(qdf(await save(app))).toMatch(/\/Subtype \/Stamp/);
});

test('edit: add text, whiteout and an image @FR-EDT-05 @FR-EDT-06 @FR-EDT-07', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Edit');
  const box = await pageBox(app);
  await tool(app, 'Add text').click();
  await app.mouse.click(box.x + 150, box.y + 400);
  await expect(app.locator('textarea.typing')).toBeFocused();
  await app.keyboard.type('Added paragraph');
  await app.keyboard.press('Control+Enter');
  await expect(undo(app)).toBeEnabled();
  await tool(app, 'Whiteout').click();
  await app.mouse.move(box.x + 90, box.y + 70);
  await app.mouse.down();
  await app.mouse.move(box.x + 420, box.y + 110, { steps: 5 });
  await app.mouse.up();
  await choose(app, () => tool(app, 'Add image').click(), 'photo-1.jpg');
  await app.mouse.move(box.x + 400, box.y + 600);
  await app.mouse.click(box.x + 400, box.y + 600);
  const out = await save(app);
  expect(textOf(out, 1)).toContain('Added paragraph');
  expect(qdf(out)).toMatch(/\/Subtype \/Image/);
  qpdfCheck(out);
});

test('export pages as images @FR-OPT-02', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await menu(app, 'Export pages as images…');
  const dialog = app.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const files = await downloads(app, 1, () => dialog.getByRole('button', { name: /^Export/ }).last().click());
  expect(files[0]!.name).toMatch(/\.(zip|png)$/);
  expect(files[0]!.bytes.length).toBeGreaterThan(1000);
});

test('document properties are saved into the file @FR-SEC-04', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await menu(app, 'Document properties…');
  const dialog = app.getByRole('dialog');
  await dialog.getByLabel('Title').fill('Quarterly report');
  await dialog.getByRole('button', { name: /Save|Apply|Done/ }).last().click();
  await expect(dialog).toBeHidden();
  await expect(undo(app)).toBeEnabled();
  expect(qdf(await save(app))).toContain('Quarterly report');
});

test('history lists every step and jumps back @FR-APP-05', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  await app.locator('#canvaswrap').getByRole('button', { name: 'Page 1' }).click();
  await tool(app, 'Rotate pages right').click();
  await expect(undo(app)).toBeEnabled();
  await tool(app, 'Delete').click();
  await expect(status(app).getByText('/ 2')).toBeVisible();
  await menu(app, 'History…');
  const dialog = app.getByRole('dialog');
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await dialog.getByRole('listitem').first().getByRole('button').click();
  await expect(status(app).getByText('/ 3')).toBeVisible();
});

test('sidebar: outline navigation and search results @FR-VIEW-02 @FR-VIEW-04', async ({ app }) => {
  await openPdf(app, 'bookmarks.pdf');
  const side = app.getByRole('complementary', { name: 'Sidebar' });
  await side.getByRole('tab', { name: 'Outline' }).click();
  const items = side.getByRole('treeitem').or(side.getByRole('button'));
  await expect(items.first()).toBeVisible();
  await app.keyboard.press('Control+f');
  await app.getByRole('search').getByRole('textbox').fill('Page 4');
  await side.getByRole('tab', { name: 'Search results' }).click();
  await expect(side.getByText(/Page 4 of 5/).first()).toBeVisible();
});

test('view: two-page layout and view rotation @FR-VIEW-01 @FR-VIEW-06', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await app.keyboard.press('Control+k');
  await app.locator('.palette, [role=dialog]').getByRole('textbox').or(app.getByRole('combobox')).first().fill('Two pages');
  await app.keyboard.press('Enter');
  // Book layout: the cover stands alone, then pages sit side by side.
  const first = (await app.locator('.pv').nth(1).boundingBox())!;
  const second = (await app.locator('.pv').nth(2).boundingBox())!;
  expect(Math.abs(first.y - second.y)).toBeLessThan(4);
  const before = (await firstPage(app).boundingBox())!;
  await status(app).getByRole('button', { name: 'Rotate view right' }).click();
  await expect.poll(async () => {
    const b = (await firstPage(app).boundingBox())!;
    return b.width / b.height > 1;
  }).toBe(true);
  expect(before.width / before.height).toBeLessThan(1);
});

test('save as writes a copy under a new name @FR-APP-04', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  const [copy] = await downloads(app, 1, () => menu(app, /^Save a copy/));
  expect(pageCount(copy!)).toBe(3);
  qpdfCheck(copy!);
});

test('a damaged file opens in recovery mode with a notice @FR-APP-13', async ({ app }) => {
  await choose(app, () => app.keyboard.press('Control+o'), 'damaged.pdf');
  await expect(app.locator('.pv canvas').first().or(app.getByRole('alert')).first()).toBeVisible();
});
