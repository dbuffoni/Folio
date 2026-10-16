import { expect, mode, openPdf, pageCount, qdf, qpdfCheck, save, test, tool } from './helpers.ts';

test('Edit form: draw a text field and a check box, name, save, fill again; qpdf clean @FR-FRM-08 @FR-FRM-11 @FR-FRM-17 @NFR-11', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Fill & Sign');
  await app.getByRole('button', { name: 'Edit form', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Fill form', exact: true })).toBeVisible();

  const page = app.locator('.pv').first();
  const box = (await page.boundingBox())!;
  await app.getByRole('button', { name: 'Text', exact: true }).click();
  await app.mouse.move(box.x + 120, box.y + 200);
  await app.mouse.down();
  await app.mouse.move(box.x + 320, box.y + 232, { steps: 4 });
  await app.mouse.up();
  const panel = app.getByRole('complementary', { name: 'Inspector' });
  await expect(panel.getByLabel('Name', { exact: true })).toHaveValue('Text1');
  await panel.getByLabel('Name', { exact: true }).fill('Customer');
  await panel.getByLabel('Name', { exact: true }).press('Enter');
  await expect(page.locator('.afld.sel')).toHaveAttribute('aria-label', 'Customer');
  await panel.getByLabel('Tooltip').fill('Customer name');
  await panel.getByLabel('Tooltip').press('Enter');
  await expect(page.locator('.afld.sel')).toHaveAttribute('title', 'Customer name');
  await panel.getByRole('checkbox', { name: 'Required' }).check();
  await expect(panel.getByRole('checkbox', { name: 'Required' })).toBeChecked();

  await app.getByRole('button', { name: 'Check box', exact: true }).click();
  await app.mouse.click(box.x + 150, box.y + 300);
  await expect(panel.getByLabel('Name', { exact: true })).toHaveValue('Checkbox1');

  // Arrow keys move the selected field.
  const sel = page.locator('.afld.sel');
  const before = (await sel.boundingBox())!;
  await sel.focus();
  await app.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await page.locator('.afld.sel').boundingBox())!.x).toBeGreaterThan(before.x + 5);

  await app.getByRole('button', { name: 'Fill form', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Customer name' });
  await expect(field).toBeVisible();
  await field.fill('Ada Lovelace');
  await field.blur();

  const saved = await save(app);
  qpdfCheck(saved);
  expect(pageCount(saved)).toBe(3);
  const dump = qdf(saved);
  expect(dump).toMatch(/\/FT \/Tx/);
  expect(dump).toMatch(/\/FT \/Btn/);
  expect(dump).toContain('(Customer)');
  expect(dump).toContain('(Ada Lovelace)');
  await tool(app, 'Select').count();
});

async function editForm(app: import('@playwright/test').Page, file: string): Promise<void> {
  await openPdf(app, file);
  await mode(app, 'Fill & Sign');
  await app.getByRole('button', { name: 'Edit form', exact: true }).click();
  await app.getByRole('button', { name: 'Detect fields', exact: true }).click();
}

test('Detect fields: a vector form gets its fields, a plain paper scan gets them from the image, a page with none says so @FR-FRM-15', async ({ app }) => {
  await editForm(app, 'flat-form.pdf');
  const panel = app.getByRole('complementary', { name: 'Inspector' });
  await expect(panel.getByText('6 fields proposed')).toBeVisible();
  await panel.getByRole('button', { name: 'Create 6 fields' }).click();
  await expect(app.locator('.afld')).toHaveCount(6);

  // A word-processor form with dotted leaders ("name ………").
  await editForm(app, 'dotted-form.pdf');
  await expect(panel.getByText('3 fields proposed')).toBeVisible();
  await expect(panel.getByText('Il/la sottoscritto/a · Text')).toBeVisible();

  // A scan with no text: the shapes in the image, labelled as a guess.
  await editForm(app, 'scanned-form.pdf');
  await expect(panel.getByText('7 fields proposed')).toBeVisible();
  await expect(panel.getByText(/Found by looking at the page image/)).toBeVisible();
  await expect(app.locator('.aprop')).toHaveCount(7);

  // Nothing that looks like a field: a message, not silence.
  await editForm(app, 'invoice.pdf');
  await expect(panel.getByText('No fields found on this page. Draw them by hand, or try Detect with AI.')).toBeVisible();
});
