// The menu on a recent-file card runs its actions (it used to close first and lose the card).
import { expect, openPdf, test } from './helpers.ts';

test('recent file menu: Open and Remove from list work @FR-APP-03 @NFR-11', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await app.getByRole('button', { name: 'Close text.pdf' }).click();
  await app.getByRole('button', { name: 'Home' }).click();
  const card = app.locator('.rcard', { hasText: 'text.pdf' });
  await expect(card).toBeVisible();

  // Open from the ⋯ button.
  await card.hover();
  await card.getByRole('button', { name: 'More actions' }).click();
  await app.getByRole('menuitem', { name: 'Open', exact: true }).click();
  // The browser build keeps no path for a file, so the action's visible result is the "no longer there" notice.
  await expect(app.getByText('text.pdf is no longer where it was.')).toBeVisible();

  // Remove from the context menu.
  await card.click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Remove from list' }).click();
  await expect(card).toHaveCount(0);
});
