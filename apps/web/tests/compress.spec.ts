import { statSync } from 'node:fs';
import { downloads, expect, fx, menu, openPdf, pageCount, qpdfCheck, test, textOf } from './helpers.ts';

test('reduce file size: estimates, Balanced copy, same text, qpdf clean @FR-OPT-01 @FR-OPT-09 @FR-OPT-07', async ({ app }) => {
  await openPdf(app, 'photos.pdf');
  await menu(app, 'Reduce file size…');
  const dialog = app.getByRole('dialog', { name: 'Reduce file size' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^Current size:/)).toBeVisible();
  // Estimates appear for the three presets.
  for (const p of ['light', 'balanced', 'strong']) await expect(dialog.getByTestId(`estimate-${p}`)).toContainText('about');
  await dialog.getByRole('radio', { name: /Balanced/ }).check();
  const [saved] = await downloads(app, 1, () => dialog.getByRole('button', { name: 'Reduce size' }).click());
  expect(saved!.name).toBe('photos-compressed.pdf');
  expect(saved!.bytes.length).toBeLessThan(statSync(fx('photos.pdf')).size * 0.6);
  qpdfCheck(saved!);
  expect(pageCount(saved!)).toBe(2);
  expect(textOf(saved!, 1)).toContain('Photos at 300 dpi');
  await expect(app.getByText(/smaller\./)).toBeVisible();
});

test('reduce file size: a signed file can only be copied @FR-OPT-11', async ({ app }) => {
  await openPdf(app, 'signed.pdf');
  await menu(app, 'Reduce file size…');
  const dialog = app.getByRole('dialog', { name: 'Reduce file size' });
  await expect(dialog.getByText(/digitally signed/)).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Replace this file/ })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /Save as a copy/ })).toBeChecked();
});
