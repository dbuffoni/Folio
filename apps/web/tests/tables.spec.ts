import { readFileSync } from 'node:fs';
import { downloads, expect, openPdf, test, tool } from './helpers.ts';

test('extract table: draw a rectangle, check the grid, edit a cell, save CSV and copy @FR-OPT-12 @NFR-11', async ({ app }) => {
  await openPdf(app, 'tables.pdf');
  await tool(app, 'Extract table').click();
  const box = (await app.locator('.pv').first().boundingBox())!;
  const z = box.width / 612;
  const at = (x: number, y: number) => ({ x: box.x + x * z, y: box.y + (792 - y) * z });
  const a = at(60, 720);
  const b = at(480, 560);
  await app.mouse.move(a.x, a.y);
  await app.mouse.down();
  await app.mouse.move(b.x, b.y, { steps: 5 });
  await app.mouse.up();

  const dialog = app.getByRole('dialog', { name: 'Extract table' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Row 1, column 1' })).toHaveValue('Item');
  await expect(dialog.getByRole('textbox', { name: 'Row 3, column 1' })).toHaveValue('Gadget with a long name');
  await expect(dialog.getByRole('textbox', { name: 'Row 3, column 3' })).toHaveValue('3,20');
  await expect(dialog.getByText('Found from the ruled lines')).toBeVisible();

  const cell = dialog.getByRole('textbox', { name: 'Row 2, column 1' });
  await cell.fill('Widget, large');
  await cell.blur();
  await dialog.getByLabel('Separator').selectOption(';');
  const [saved] = await downloads(app, 1, () => dialog.getByRole('button', { name: 'Save CSV…' }).click());
  expect(saved!.name).toMatch(/^tables[ _]page[ _]1[ _]table\.csv$/);
  expect(readFileSync(saved!.path, 'utf8')).toBe('Item;Qty;Price\r\nWidget, large;2;10.50\r\nGadget with a long name;5;3,20\r\nTotal;7;13.70\r\n');
  // Copy needs the browser's clipboard permission, which a headless run may not grant; the text itself
  // is checked at the application layer. The dialog must stay usable either way.
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog).toBeVisible();
});
