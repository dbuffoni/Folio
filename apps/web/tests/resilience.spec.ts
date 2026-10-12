// What happens around the edges: signed files, crash recovery, invalid input, keyboard undo, profile files.
// Each scenario ends in a file or a dialog state that an independent check can judge.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  choose,
  downloads,
  expect,
  firstPage,
  fx,
  mode,
  menu,
  openPdf,
  pageCount,
  qdf,
  qpdfCheck,
  save,
  tabs,
  test,
  textOf,
  tmpFile,
  tool,
} from './helpers.ts';

const status = (page: Page) => page.getByRole('contentinfo');
const undo = (page: Page) => page.getByLabel('Undo', { exact: true });
const pageBox = async (page: Page) => (await firstPage(page).boundingBox())!;

test('saving a signed file asks first; "append changes" keeps the signed bytes intact @FR-APP-11', async ({
  app,
}) => {
  await openPdf(app, 'signed.pdf');
  await mode(app, 'Annotate');
  await tool(app, 'Note').click();
  const box = await pageBox(app);
  await app.mouse.click(box.x + 400, box.y + 300);
  await expect(undo(app)).toBeEnabled();

  const [out] = await downloads(app, 1, async () => {
    await app.keyboard.press('Control+s');
    const dialog = app.getByRole('dialog', { name: 'This file is digitally signed' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^Append changes/ }).click();
  });
  const original = readFileSync(fx('signed.pdf'));
  expect(out!.bytes.length).toBeGreaterThan(original.length);
  expect(out!.bytes.subarray(0, original.length).equals(original)).toBe(true);
  qpdfCheck(out!);
  expect(qdf(out!)).toMatch(/\/Subtype \/Text/);
});

test('cancelling the signed-file warning writes nothing and keeps the edit @FR-APP-11', async ({ app }) => {
  await openPdf(app, 'signed.pdf');
  await mode(app, 'Annotate');
  await tool(app, 'Note').click();
  const box = await pageBox(app);
  await app.mouse.click(box.x + 400, box.y + 300);
  let written = 0;
  app.on('download', () => written++);
  await app.keyboard.press('Control+s');
  const dialog = app.getByRole('dialog', { name: 'This file is digitally signed' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await app.waitForTimeout(300);
  expect(written).toBe(0);
  await expect(undo(app)).toBeEnabled();
  // The window still knows there is unsaved work: closing asks.
  await app.keyboard.press('Control+w');
  await expect(app.getByRole('dialog', { name: 'Save changes?' })).toBeVisible();
  await app.getByRole('button', { name: /Discard|Don.t save/ }).click();
  await expect(tabs(app).locator('.tabb')).toHaveCount(0);
});

test('print dialog accepts only ranges that exist in the document @FR-VIEW-09', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await app.keyboard.press('Control+p');
  const dialog = app.getByRole('dialog', { name: 'Print' });
  await expect(dialog).toBeVisible();
  const print = dialog.getByRole('button', { name: 'Print', exact: true });
  await expect(print).toBeEnabled();
  await dialog.getByRole('radio', { name: 'Range' }).check();
  const range = dialog.getByRole('textbox', { name: 'Range' });
  await expect(print).toBeDisabled(); // empty range
  for (const bad of ['9', '0', '3-1-2', 'a', '1,,2', '-']) {
    await range.fill(bad);
    await expect(print, `range "${bad}"`).toBeDisabled();
    await expect(range).toHaveAttribute('aria-invalid', 'true');
  }
  for (const good of ['1-2', '3', '1,3', '3-1', '2-']) {
    await range.fill(good);
    await expect(print, `range "${good}"`).toBeEnabled();
  }
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('unsaved work is offered back after the page is reloaded without saving @FR-APP-06', async ({ app }) => {
  app.on('dialog', (d) => void d.accept()); // the "leave site?" prompt of a dirty document
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'General' }).click();
  const interval = settings.getByLabel('Recovery interval (seconds)');
  await interval.fill('5');
  await interval.blur();
  await settings.getByRole('button', { name: 'Done' }).click();

  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  await app.locator('#canvaswrap').getByRole('button', { name: 'Page 1' }).click();
  await tool(app, 'Rotate pages right').click();
  await expect(undo(app)).toBeEnabled();
  await app.waitForTimeout(7500); // one timer tick plus the write to private storage

  await app.reload();
  const prompt = app.getByRole('dialog', { name: 'Restore unsaved changes?' });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt.getByText('text.pdf')).toBeVisible();
  await prompt.getByRole('button', { name: 'Restore' }).click();
  await expect(tabs(app).getByRole('button', { name: /^text\.pdf/ })).toBeVisible();
  await expect(app.locator('.pv canvas').first()).toBeVisible();
  await expect(undo(app)).toBeDisabled(); // restored work is the new baseline: unsaved, but nothing to undo
  const out = await save(app);
  expect(qdf(out)).toMatch(/\/Rotate 90/);
  qpdfCheck(out);

  // Once saved, the snapshot is gone: another reload offers nothing.
  await app.reload();
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByRole('dialog', { name: 'Restore unsaved changes?' })).toHaveCount(0);
});

test('declining recovery discards the snapshot @FR-APP-06', async ({ app }) => {
  app.on('dialog', (d) => void d.accept());
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'General' }).click();
  const interval = settings.getByLabel('Recovery interval (seconds)');
  await interval.fill('5');
  await interval.blur();
  await settings.getByRole('button', { name: 'Done' }).click();
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  await app.locator('#canvaswrap').getByRole('button', { name: 'Page 2' }).click();
  await tool(app, 'Delete').click();
  await expect(status(app).getByText('/ 2')).toBeVisible();
  await app.waitForTimeout(7500);
  await app.reload();
  const prompt = app.getByRole('dialog', { name: 'Restore unsaved changes?' });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole('button', { name: 'Discard' }).click();
  await expect(tabs(app).locator('.tabb')).toHaveCount(0);
  await app.reload();
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByRole('dialog', { name: 'Restore unsaved changes?' })).toHaveCount(0);
});

test('undo and redo from the keyboard change what is saved @FR-APP-05 @NFR-11', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  await app.locator('#canvaswrap').getByRole('button', { name: 'Page 2' }).click();
  await app.keyboard.press('Delete');
  await expect(status(app).getByText('/ 2')).toBeVisible();
  await app.keyboard.press('Control+z');
  await expect(status(app).getByText('/ 3')).toBeVisible();
  await expect(undo(app)).toBeDisabled();
  expect(pageCount(await save(app))).toBe(3);
  await app.keyboard.press('Control+Shift+z');
  await expect(status(app).getByText('/ 2')).toBeVisible();
  const out = await save(app);
  expect(pageCount(out)).toBe(2);
  expect(textOf(out, 2)).toContain('Page 3 of 3');
  // Nothing more to redo or undo past the ends: extra presses are harmless.
  await app.keyboard.press('Control+Shift+z');
  await app.keyboard.press('Control+z');
  await app.keyboard.press('Control+z');
  await app.keyboard.press('Control+z');
  await expect(status(app).getByText('/ 3')).toBeVisible();
});

test('insert a landscape A5 page with the dialog @FR-ORG-07', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  await app.locator('#canvaswrap').getByRole('button', { name: 'Page 1' }).click();
  await tool(app, 'Insert').click();
  await app.getByRole('menuitem', { name: 'Insert blank page…' }).first().click();
  const dialog = app.getByRole('dialog', { name: 'Insert blank page' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Size').selectOption('A5');
  await dialog.getByLabel('Orientation').selectOption({ label: 'Landscape' });
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(status(app).getByText('/ 4')).toBeVisible();
  const out = await save(app);
  expect(pageCount(out)).toBe(4);
  // A5 landscape is 595.28 × 419.53 pt: width above height.
  const boxes = [...qdf(out).matchAll(/\/MediaBox \[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as const,
  );
  expect(boxes.some(([w, h]) => Math.abs(w - 595.28) < 1 && Math.abs(h - 419.53) < 1)).toBe(true);
  qpdfCheck(out);
});

test('a search with no match says so and keeps the keyboard usable @FR-VIEW-04', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await app.keyboard.press('Control+f');
  const find = app.getByRole('search');
  await find.getByRole('textbox').fill('zzzzqqq');
  await expect(find.getByText('No matches')).toBeVisible();
  await expect(find.getByRole('button', { name: 'Next match' })).toBeDisabled();
  await find.getByRole('textbox').press('Enter');
  await find.getByRole('textbox').press('Shift+Enter');
  await find.getByRole('textbox').fill('Page');
  await expect(find.getByText(/1 of 3/)).toBeVisible();
  await find.getByRole('button', { name: 'Match case' }).click();
  await find.getByRole('textbox').fill('page');
  await expect(find.getByText('No matches')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('search')).toHaveCount(0);
});

test('two documents stay independent and closing one activates the other @FR-APP-02', async ({ app }) => {
  await openPdf(app, 'text.pdf', 'invoice.pdf');
  await expect(tabs(app).locator('.tabb')).toHaveCount(2);
  await mode(app, 'Organise');
  await app.locator('#canvaswrap').getByRole('button', { name: 'Page 1' }).click();
  await tool(app, 'Delete').click();
  await expect(status(app).getByText('/ 0').or(status(app).getByText('/ 1'))).toBeVisible();
  await tabs(app).getByRole('button', { name: 'text.pdf', exact: true }).click();
  await expect(status(app).getByText('/ 3')).toBeVisible(); // text.pdf untouched
  await app.keyboard.press('Control+w');
  await expect(tabs(app).locator('.tabb')).toHaveCount(1);
  await expect(tabs(app).getByRole('button', { name: 'invoice.pdf', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('a profile exports to a file and imports back unchanged @FR-AIF-01', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  let settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Backup test');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  const first = settings.getByLabel('First name', { exact: true });
  await first.fill('Grace');
  await first.blur();
  const [exported] = await downloads(app, 1, () => settings.getByRole('button', { name: 'Export…' }).click());
  const json = JSON.parse(exported!.bytes.toString('utf8')) as {
    version: number;
    name: string;
    fields: Array<{ key: string; value: string }>;
  };
  expect(json).toMatchObject({ version: 1, name: 'Backup test' });
  expect(json.fields.find((f) => f.key === 'first_name')?.value).toBe('Grace');

  json.name = 'Imported copy';
  const file = tmpFile('profile-import.json', JSON.stringify(json));
  await settings.getByRole('button', { name: 'Done' }).click();
  await app.getByRole('button', { name: 'Settings' }).click();
  settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await choose(app, () => settings.getByRole('button', { name: 'Import…' }).click(), file);
  await expect(settings.getByText('Imported copy')).toBeVisible();
  await expect(settings.getByText('Backup test')).toBeVisible();

  // A file that is not a profile is refused with a message, not a crash.
  const bad = tmpFile('not-a-profile.json', '{"hello":"world"}');
  await choose(app, () => settings.getByRole('button', { name: 'Import…' }).click(), bad);
  await expect(
    app
      .getByRole('alert')
      .or(app.getByRole('status'))
      .filter({ hasText: /not a Folio profile|profile/i })
      .first(),
  ).toBeVisible();
  await expect(settings.getByText('Imported copy')).toHaveCount(1);

  // A file that is not even JSON gets the same clear message, not "Something went wrong".
  const garbage = tmpFile('garbage-profile.json', 'this is not json');
  await app.getByRole('alert').getByRole('button', { name: 'Dismiss' }).first().click();
  await choose(app, () => settings.getByRole('button', { name: 'Import…' }).click(), garbage);
  await expect(app.getByRole('alert').filter({ hasText: 'This is not a Folio profile file.' }).first()).toBeVisible();
  await expect(app.getByText('Something went wrong')).toHaveCount(0);
});

test('mode tabs and toolbar buttons keep their names when the window is narrow @NFR-11', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await app.setViewportSize({ width: 800, height: 600 });
  for (const name of ['View', 'Organise', 'Annotate', 'Fill & Sign', 'Edit'] as const)
    await expect(app.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name })).toBeVisible();
  await mode(app, 'Annotate');
  const unnamed = await app.getByRole('toolbar').getByRole('button').evaluateAll((els) =>
    els.filter((e) => !(e.getAttribute('aria-label') || e.textContent || '').trim()).length,
  );
  expect(unnamed).toBe(0);
});

test('shrinking the window does not hide a Smart Fill review in progress @FR-AIF-05', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Personal');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  const input = settings.getByLabel('First name', { exact: true });
  await input.fill('Ada');
  await input.blur();
  await settings.getByRole('button', { name: 'Done' }).click();

  await openPdf(app, 'flat-form.pdf');
  await mode(app, 'Fill & Sign');
  await app.setViewportSize({ width: 1280, height: 720 });
  await tool(app, 'Smart Fill').click();
  const panel = app.getByRole('complementary', { name: 'Inspector' });
  const apply = panel.getByRole('button', { name: /^Apply selected/ });
  await expect(apply).toBeEnabled();
  await app.setViewportSize({ width: 1024, height: 768 });
  await expect(apply).toBeVisible();
  await app.setViewportSize({ width: 1280, height: 720 });
  await expect(apply).toBeEnabled();
});

test('clearing a profile name keeps the old name and raises no page error @FR-APP-10', async ({ app }) => {
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Personal');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  const name = settings.getByRole('textbox', { name: 'Profile name' });
  await name.fill('');
  await name.blur();
  await expect(name).toHaveValue('Personal');
  expect(errors).toEqual([]);
});

test('profile suggestions can be chosen with the keyboard alone @NFR-11 @FR-FRM-02', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Profiles' }).click();
  await settings.getByRole('textbox', { name: 'New profile' }).fill('Personal');
  await settings.getByRole('button', { name: 'Add', exact: true }).click();
  const full = settings.getByLabel('First name', { exact: true });
  await full.fill('Ada');
  await full.blur();
  await settings.getByRole('button', { name: 'Done' }).click();

  await openPdf(app, 'acroform.pdf');
  await mode(app, 'Fill & Sign');
  const first = app.locator('.pv').getByRole('textbox').first();
  await first.focus();
  await app.keyboard.type('Ad');
  const list = app.locator('.sugg');
  await expect(list.getByRole('option', { name: 'Ada' })).toBeVisible();
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(list).toBeHidden();
  const filled = await save(app);
  expect(qdf(filled)).toContain('(Ada)');
});

test('tools and options stay inside the window at 600 px wide @NFR-11', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await app.setViewportSize({ width: 600, height: 800 });
  const outside = async (): Promise<string[]> =>
    app.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#toolbar button, #toolbar label, #modebar button')]
        .filter((e) => e.offsetParent !== null)
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 2 && (r.right > window.innerWidth + 0.5 || r.left < -0.5);
        })
        .map((e) => e.getAttribute('aria-label') || e.textContent?.trim() || e.className),
    );
  for (const name of ['Annotate', 'Fill & Sign', 'Edit'] as const) {
    await mode(app, name);
    expect(await outside(), name).toEqual([]);
  }
  await mode(app, 'Edit');
  await tool(app, 'Whiteout').click();
  expect(await outside(), 'whiteout options').toEqual([]);
  await mode(app, 'Organise');
  await expect(app.getByRole('button', { name: 'Clear selection' })).toBeInViewport();
});

test('the current search match is brought below the find bar @FR-VIEW-04', async ({ app }) => {
  await openPdf(app, 'mixed-sizes.pdf');
  await app.setViewportSize({ width: 600, height: 800 });
  await app.keyboard.press('Control+f');
  const find = app.getByRole('search');
  await find.getByRole('textbox').fill('Size 1');
  const hit = app.locator('.hit.cur').first();
  await expect(hit).toBeVisible();
  await expect(async () => {
    const h = (await hit.boundingBox())!;
    const bar = (await find.boundingBox())!;
    const canvas = (await app.locator('#canvas').boundingBox())!;
    expect(h.y).toBeGreaterThanOrEqual(canvas.y);
    expect(h.y + h.height).toBeLessThanOrEqual(canvas.y + canvas.height);
    // never underneath the bar
    const under = h.x < bar.x + bar.width && h.x + h.width > bar.x && h.y < bar.y + bar.height && h.y + h.height > bar.y;
    expect(under).toBe(false);
  }).toPass();
});

test('the active tab is scrolled into view when many documents are open @FR-APP-02', async ({ app }) => {
  await app.setViewportSize({ width: 800, height: 600 });
  const names = ['text', 'invoice', 'acroform', 'flat-form', 'bookmarks', 'links', 'mixed-sizes', 'annotated', 'text-25', 'unicode'].map((n) => `${n}.pdf`);
  await openPdf(app, ...names);
  await expect(tabs(app).getByRole('button', { name: 'unicode.pdf', exact: true })).toBeInViewport();
});

test('shrinking the window closes the side panels the same way a narrow start does @NFR-11', async ({ app }) => {
  await app.setViewportSize({ width: 1920, height: 1080 });
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  await expect(app.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await app.setViewportSize({ width: 600, height: 800 });
  await expect(app.getByRole('complementary', { name: 'Inspector' })).toBeHidden();
  await expect(app.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
});

test('split by ranges names non-contiguous pages exactly @FR-MRG-04', async ({ app }) => {
  await openPdf(app, 'text-25.pdf');
  await menu(app, 'Split document…');
  const dialog = app.getByRole('dialog', { name: 'Split document' });
  await dialog.getByRole('radio', { name: /^Ranges|^By ranges|^Page ranges/ }).check();
  await dialog.getByRole('textbox', { name: /range 1/i }).fill('2-4, 8-10');
  await expect(dialog.getByRole('listitem').first()).toContainText('pages 2-4,8-10 · 6 pages');
});

test('characters no font has are announced next to the edited line @FR-EDT-02', async ({ app }) => {
  await openPdf(app, 'subset-font.pdf');
  await mode(app, 'Edit');
  await tool(app, 'Edit text').click();
  const page = (await firstPage(app).boundingBox())!;
  const k = page.width / 816;
  await expect(async () => {
    await app.mouse.move(page.x + 130 * k, page.y + 110 * k);
    await app.mouse.move(page.x + 138 * k, page.y + 113 * k);
    await expect(app.locator('.lineh')).toBeVisible({ timeout: 500 });
  }).toPass();
  await app.mouse.click(page.x + 138 * k, page.y + 113 * k);
  const editor = app.getByRole('textbox', { name: 'Edit text' });
  await editor.fill('Invoice 日本語');
  await editor.press('Enter');
  const notice = app.getByRole('status').filter({ hasText: 'Some characters could not be drawn with this font.' });
  await expect(notice).toBeVisible();
  await expect(notice).toBeInViewport();
});
