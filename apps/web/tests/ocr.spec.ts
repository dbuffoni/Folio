import { expect, menu, openPdf, pageCount, qpdfCheck, save, test, textOf } from './helpers.ts';

test('OCR: banner on a scan, recognise English offline, search finds the words, save, undo @FR-OCR-01 @FR-OCR-02 @FR-OCR-04 @FR-OCR-09 @NFR-14', async ({ app, outbound }) => {
  test.setTimeout(180_000);
  await openPdf(app, 'scanned-text.pdf');
  // The banner offers the action on a page that is only a picture.
  const banner = app.locator('#ocrbanner');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Recognise text' }).click();
  const dialog = app.getByRole('dialog', { name: 'Recognise text' });
  await expect(dialog.getByRole('checkbox', { name: /English/ })).toBeChecked();
  await expect(dialog.getByText('included').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Recognise', exact: true }).click();
  await expect(dialog.getByTestId('ocr-result')).toContainText('Text recognised on 1 page', { timeout: 150_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();

  // Search finds a word that only existed as a picture.
  await app.keyboard.press('Control+f');
  await app.getByRole('search').getByRole('textbox').fill('quick');
  const side = app.getByRole('complementary', { name: 'Sidebar' });
  await side.getByRole('tab', { name: 'Search results' }).click();
  await expect(side.getByText(/quick/i).first()).toBeVisible();
  await app.keyboard.press('Escape');

  const saved = await save(app);
  qpdfCheck(saved);
  expect(pageCount(saved)).toBe(1);
  expect(textOf(saved)).toMatch(/quick\s+brown\s+fox/i);
  // Nothing left the device: the language data and the engine are same-origin files.
  expect(outbound).toEqual([]);

  // One undo removes the whole layer.
  await app.getByLabel('Undo', { exact: true }).click();
  await expect(app.getByLabel('Undo', { exact: true })).toBeDisabled();
  await menu(app, 'Recognise text (OCR)…');
  await expect(app.getByRole('dialog', { name: 'Recognise text' })).toBeVisible();
});

test('OCR languages in Settings: bundled ones are included, others show their size and are not downloaded @FR-OCR-02 @NFR-14', async ({ app, outbound }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'OCR', exact: true }).click();
  const list = settings.getByRole('list', { name: 'OCR' });
  await expect(list.getByRole('listitem').filter({ hasText: 'English' })).toContainText('included');
  await expect(list.getByRole('listitem').filter({ hasText: 'Italiano' })).toContainText('included');
  await expect(list.getByRole('listitem').filter({ hasText: 'Deutsch' })).toContainText(/MB|KB/);
  await expect(list.getByRole('listitem').filter({ hasText: 'Deutsch' }).getByRole('button', { name: 'Download' })).toBeVisible();
  await app.waitForTimeout(500);
  expect(outbound).toEqual([]);
});
