import { execFileSync } from 'node:child_process';
import { expect, mode, openPdf, qpdfCheck, save, test } from './helpers.ts';

const outlineOf = (path: string): string => execFileSync('mutool', ['show', path, 'outline'], { encoding: 'utf8' });

test('bookmark editor: add, rename with F2, nest with Tab, delete, save @FR-EDT-11 @FR-EDT-27 @NFR-11', async ({ app }) => {
  await openPdf(app, 'bookmarks.pdf');
  const side = app.getByRole('complementary', { name: 'Sidebar' });
  await side.getByRole('tab', { name: 'Outline' }).click();
  await side.getByRole('button', { name: 'Edit', exact: true }).click();
  const tree = side.getByRole('tree', { name: 'Outline' });

  // Chapter 2 selected: a bookmark for the current page lands right after it.
  await tree.getByRole('treeitem', { name: /^Chapter 2/ }).click();
  await side.getByRole('button', { name: 'Add bookmark at this page' }).click();
  const added = tree.getByRole('treeitem', { name: /^Page 1/ });
  await expect(added).toBeVisible();
  await added.focus();
  await app.keyboard.press('F2');
  const box = tree.getByRole('textbox', { name: 'Rename' });
  await box.fill('Summary');
  await box.press('Enter');
  await expect(tree.getByRole('treeitem', { name: /^Summary/ })).toHaveAttribute('aria-level', '1');
  await tree.getByRole('treeitem', { name: /^Summary/ }).focus();
  await app.keyboard.press('Tab');
  await expect(tree.getByRole('treeitem', { name: /^Summary/ })).toHaveAttribute('aria-level', '2');
  await tree.getByRole('treeitem', { name: /^Summary/ }).focus();
  await app.keyboard.press('Shift+Tab');
  await expect(tree.getByRole('treeitem', { name: /^Summary/ })).toHaveAttribute('aria-level', '1');
  await tree.getByRole('treeitem', { name: /^Summary/ }).focus();
  await app.keyboard.press('Alt+ArrowUp');

  await tree.getByRole('treeitem', { name: /^Appendix/ }).click();
  await side.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: /^Appendix/ })).toHaveCount(0);

  const saved = await save(app);
  qpdfCheck(saved);
  const out = outlineOf(saved.path);
  expect(out).toContain('Summary');
  expect(out).toContain('Chapter 1');
  expect(out).not.toContain('Appendix');

  // Undo from the keyboard brings the deleted bookmark back.
  await mode(app, 'View');
  await app.keyboard.press('Control+z');
  await expect(tree.getByRole('treeitem', { name: /^Appendix/ })).toBeVisible();
});
