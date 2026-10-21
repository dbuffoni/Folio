// UI-level acceptance of the epics in SPEC §17 against the web build. Each scenario was accepted at
// service level first (packages/app/src/epics.test.ts); here only the binding of the screens counts.
import { tabs, choose, downloads, expect, firstPage, menu, mode, openPdf, pageCount, qdf, qpdfCheck, save, test, textOf, tool } from './helpers.ts';

test('E1 merge two open files in a chosen order @FR-MRG-01 @FR-MRG-02', async ({ app }) => {
  await openPdf(app, 'text.pdf', 'invoice.pdf');
  await menu(app, 'Merge files…');
  const dialog = app.getByRole('dialog', { name: 'Merge files' });
  await expect(dialog.getByRole('button', { name: 'Merge & open' })).toBeEnabled();
  // Keyboard path of drag-to-reorder: move the invoice first.
  await dialog.getByRole('button', { name: '↑ invoice.pdf' }).click();
  await expect(dialog.getByRole('button', { name: '↑ invoice.pdf' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Merge & open' }).click();
  await expect(dialog).toBeHidden();
  await expect(tabs(app).locator('.tabb')).toHaveCount(3);

  const merged = await save(app);
  expect(pageCount(merged)).toBeGreaterThan(1);
  expect(textOf(merged, 1)).toContain('Invoce');
  expect(qdf(merged)).toMatch(/\/Outlines/);
  qpdfCheck(merged);
});

test('E2 create a signature, place it, reuse it in a second document @FR-STM-01 @FR-STM-05', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Fill & Sign');
  await tool(app, 'Sign').click();
  await app.getByRole('menuitem', { name: 'Create new signature…' }).click();
  const dialog = app.getByRole('dialog');
  const pad = dialog.locator('canvas').first();
  const box = (await pad.boundingBox())!;
  await app.mouse.move(box.x + 40, box.y + box.height / 2);
  await app.mouse.down();
  for (let i = 1; i <= 12; i++) await app.mouse.move(box.x + 40 + i * 18, box.y + box.height / 2 + Math.sin(i) * 25);
  await app.mouse.up();
  await dialog.getByRole('button', { name: 'Use now' }).click();
  await expect(app.getByRole('dialog', { name: 'Create signature' })).toBeHidden();
  // The one-time note about electronic versus certified signatures.
  const note = app.getByRole('dialog', { name: 'Sign' });
  if (await note.isVisible().catch(() => false)) await note.getByRole('button').last().click();

  // A ghost follows the pointer; a click places the signature.
  const page = (await firstPage(app).boundingBox())!;
  await app.mouse.move(page.x + 300, page.y + 400);
  await expect(app.locator('.pghost')).toBeVisible();
  await app.mouse.click(page.x + 300, page.y + 400);
  await expect(app.getByRole('status').filter({ hasText: /Unsaved|Edited|changes/i }).first()).toBeVisible();

  const signed = await save(app);
  expect(qdf(signed)).toMatch(/\/Subtype \/Stamp/);
  qpdfCheck(signed);

  await openPdf(app, 'invoice.pdf');
  await mode(app, 'Fill & Sign');
  await tool(app, 'Sign').click();
  await expect(app.getByRole('menuitem', { name: 'No signature yet' })).toHaveCount(0);
  await expect(app.getByRole('menu').getByRole('menuitem').first()).toBeEnabled();
});

test('E3 fix a typo in place and undo it @FR-EDT-01 @FR-EDT-03', async ({ app }) => {
  await openPdf(app, 'subset-font.pdf');
  await mode(app, 'Edit');
  await tool(app, 'Edit text').click();
  const page = (await firstPage(app).boundingBox())!;
  const k = page.width / 816;
  // Hovering a line outlines it and names its font; a click then opens the inline editor.
  await expect(async () => {
    await app.mouse.move(page.x + 130 * k, page.y + 110 * k);
    await app.mouse.move(page.x + 138 * k, page.y + 113 * k);
    await expect(app.locator('.lineh')).toBeVisible({ timeout: 500 });
  }).toPass();
  await app.mouse.click(page.x + 138 * k, page.y + 113 * k);
  const editor = app.getByRole('textbox', { name: 'Edit text' });
  await expect(editor).toHaveValue('Invoce');
  await editor.fill('Invoice');
  await editor.press('Enter');
  await expect(editor).toBeHidden();
  await expect(app.getByLabel('Undo', { exact: true })).toBeEnabled();

  const fixed = await save(app);
  expect(textOf(fixed)).toContain('Invoice');
  qpdfCheck(fixed);

  await app.getByLabel('Undo', { exact: true }).click();
  const undone = await save(app);
  expect(textOf(undone)).toContain('Invoce');
  expect(textOf(undone)).not.toContain('Invoice');
});

test('E4 fill a form with the keyboard and save it @FR-FRM-01 @FR-FRM-02', async ({ app }) => {
  await openPdf(app, 'acroform.pdf');
  await mode(app, 'Fill & Sign');
  await expect(app.getByRole('status').filter({ hasText: 'This form has' })).toBeVisible();
  const boxes = app.locator('.pv').getByRole('textbox');
  await boxes.first().focus();
  await app.keyboard.type('Ada Lovelace');
  await app.keyboard.press('Tab');
  await app.keyboard.type('A-17');
  await app.keyboard.press('Tab');
  await app.locator('.pv').getByRole('checkbox').first().check();

  const filled = await save(app);
  qpdfCheck(filled);
  const dump = qdf(filled);
  expect(dump).toContain('(Ada Lovelace)');
  expect(dump).toContain('(A-17)');
  // Appearance streams are present, so other viewers show the values.
  expect(dump).not.toMatch(/\/NeedAppearances true/);
  expect(textOf(filled)).toContain('Ada Lovelace');
});

test('E4 Tab walks a two-page form from the keyboard, commits each value and leaves the form @FR-FRM-02', async ({ app }) => {
  await openPdf(app, 'acroform-multipage.pdf');
  await mode(app, 'Fill & Sign');
  await expect(app.getByRole('status').filter({ hasText: 'This form has' })).toBeVisible();
  const field = (name: string) => app.locator(`.fld[aria-label="${name}"]`);
  await field('p1.first').focus();
  await app.keyboard.type('One');
  await app.keyboard.press('Tab');
  await expect(field('p1.second')).toBeFocused();
  await app.keyboard.type('Two');
  // The next field is on the second page: Tab brings it into view and focuses it.
  await app.keyboard.press('Tab');
  await expect(field('p2.first')).toBeFocused();
  await expect(field('p2.first')).toBeInViewport();
  await app.keyboard.type('Three');
  await app.keyboard.press('Tab');
  await expect(field('kind: a')).toBeFocused();
  await app.keyboard.press('Space');
  await app.keyboard.press('Tab');
  await expect(field('p2.last')).toBeFocused();
  await app.keyboard.type('Four');
  // Shift+Tab goes back, across the page boundary as well.
  await app.keyboard.press('Shift+Tab');
  await expect(field('kind: a')).toBeFocused();
  await app.keyboard.press('Shift+Tab');
  await expect(field('p2.first')).toBeFocused();
  await app.keyboard.press('Shift+Tab');
  await expect(field('p1.second')).toBeFocused();
  // Past the last field Tab leaves the form instead of looping.
  await field('p2.last').focus();
  await app.keyboard.press('Tab');
  await expect.poll(() => app.evaluate(() => document.activeElement?.classList.contains('fld'))).toBe(false);

  const dump = qdf(await save(app));
  for (const v of ['One', 'Two', 'Three', 'Four']) expect(dump).toContain(`(${v})`);
  expect(dump).toMatch(/\/V \/0/); // the radio group has its first button selected
});

test('E5 Smart Fill without a key maps a flat form on the device @FR-AIF-07 @FR-AIF-05 @NFR-14', async ({ app, outbound }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Personal');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  const values: Record<string, string> = { 'First name': 'Ada', 'Last name': 'Lovelace', Email: 'ada@example.org' };
  for (const [label, value] of Object.entries(values)) {
    const input = settings.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.blur();
  }
  await settings.getByRole('button', { name: 'Done' }).click();

  await openPdf(app, 'flat-form.pdf');
  await mode(app, 'Fill & Sign');
  await tool(app, 'Smart Fill').click();
  const panel = app.getByRole('complementary', { name: 'Inspector' });
  const apply = panel.getByRole('button', { name: /^Apply selected/ });
  await expect(apply).toBeEnabled();
  await expect(panel.getByRole('textbox', { name: 'Last name' })).toHaveValue('Lovelace');
  await apply.click();
  await expect(app.getByLabel('Undo', { exact: true })).toBeEnabled();

  const filled = await save(app);
  expect(textOf(filled)).toContain('Lovelace');
  // One Undo removes every box Smart Fill created.
  await app.getByLabel('Undo', { exact: true }).click();
  await expect(app.getByLabel('Undo', { exact: true })).toBeDisabled();
  expect(textOf(await save(app))).not.toContain('Lovelace');
  expect(outbound).toEqual([]);
});

test('E6 three photos become a three-page PDF @FR-MRG-03 @FR-OPT-03', async ({ app }) => {
  await app.getByRole('button', { name: /^Images to PDF/ }).click();
  const dialog = app.getByRole('dialog', { name: 'Images to PDF' });
  await choose(app, () => dialog.getByRole('button', { name: 'Add images…' }).click(), 'photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg');
  await expect(dialog.getByRole('button', { name: /^↓ photo-/ })).toHaveCount(3);
  await dialog.getByRole('button', { name: '↓ photo-1.jpg' }).click();
  await dialog.getByLabel('Margin').selectOption({ label: 'Small' });
  await dialog.getByRole('button', { name: 'Create & open' }).click();
  await expect(dialog).toBeHidden();
  await expect(app.getByRole('contentinfo').getByText('/ 3')).toBeVisible();

  const pdf = await save(app);
  expect(pageCount(pdf)).toBe(3);
  expect(qdf(pdf).match(/\/Subtype \/Image/g)).toHaveLength(3);
  qpdfCheck(pdf);
});

test('E7 split 25 pages every 10 @FR-MRG-04 @FR-MRG-05 @FR-MRG-06', async ({ app }) => {
  await openPdf(app, 'text-25.pdf');
  await menu(app, 'Split document…');
  const dialog = app.getByRole('dialog', { name: 'Split document' });
  await dialog.getByRole('radio', { name: /^Every N pages/ }).check();
  await dialog.getByRole('spinbutton', { name: 'Pages per file' }).fill('10');
  await expect(dialog.getByRole('listitem')).toHaveText([/text-25_1\.pdf\s*pages 1–10/, /text-25_2\.pdf\s*pages 11–20/, /text-25_3\.pdf\s*pages 21–25/]);
  await dialog.getByRole('button', { name: 'Choose…' }).click();
  const files = await downloads(app, 3, () => dialog.getByRole('button', { name: 'Split into 3 files' }).click());
  const byName = Object.fromEntries(files.map((f) => [f.name, pageCount(f)]));
  expect(byName).toEqual({ 'text-25_1.pdf': 10, 'text-25_2.pdf': 10, 'text-25_3.pdf': 5 });
  for (const f of files) qpdfCheck(f);
});
