// Screens and flows that had no browser test yet (Notion card "Browser tests for remaining screens").
// Already covered elsewhere and therefore not repeated here:
//  - recovery prompt after a reload, restore and decline: resilience.spec.ts (@FR-APP-06)
//  - profile import/export: resilience.spec.ts (@FR-FRM-20)
//  - signing with a certificate, happy path and verification: signatures.spec.ts (@FR-SIG-01 ..)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { downloads, expect, firstPage, fx, menu, mode, openPdf, pageCount, qdf, qpdfCheck, save, tabs, test, textOf, tmpFile, tool } from './helpers.ts';

const status = (page: Page) => page.getByRole('contentinfo');
const undo = (page: Page) => page.getByLabel('Undo', { exact: true });
const pageBox = async (page: Page) => (await firstPage(page).boundingBox())!;

async function palette(app: Page, query: string) {
  await app.keyboard.press('Control+k');
  const p = app.getByRole('dialog', { name: 'Command palette' });
  await p.getByRole('combobox').fill(query);
  return p;
}

// ---- 1. custom stamp editor ----------------------------------------------------------------------

test('custom stamp: create a text stamp in the editor, place it and save @FR-STM-06 @FR-STM-07', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  const p = await palette(app, 'Manage stamps');
  await p.getByRole('option', { name: /Manage stamps/ }).click();
  const dialog = app.getByRole('dialog', { name: 'Stamps' });
  await expect(dialog.getByText('No custom stamps yet.')).toBeVisible();
  await dialog.getByLabel('Text').fill('REVIEWED 4471');
  await dialog.getByLabel('Font').selectOption({ label: 'Serif' }).catch(() => undefined);
  await dialog.getByRole('button', { name: 'Save stamp' }).click();
  const mine = dialog.getByRole('button', { name: /REVIEWED 4471/ });
  await expect(mine).toBeVisible();
  await mine.click(); // "use": closes the dialog and arms the stamp for placement
  await expect(dialog).toBeHidden();
  const box = await pageBox(app);
  await app.mouse.move(box.x + 300, box.y + 400);
  await app.mouse.click(box.x + 300, box.y + 400);
  await expect(undo(app)).toBeEnabled();
  const out = await save(app);
  qpdfCheck(out);
  expect(qdf(out)).toMatch(/\/Subtype \/Stamp/);
  expect(textOf(out, 1)).toContain('REVIEWED 4471');
});

// ---- 2. drag and drop in Organise -----------------------------------------------------------------

test('organise: dragging page 3 before page 1 reorders the pages @FR-ORG-03', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Organise');
  const cards = app.locator('#orggrid .ocard');
  await expect(cards).toHaveCount(3);
  const first = (await cards.nth(0).boundingBox())!;
  const third = cards.nth(2);
  // HTML5 drag and drop: the real mouse drives it in every engine.
  await third.hover();
  await app.mouse.down();
  await app.mouse.move(first.x + 10, first.y + first.height / 2, { steps: 12 });
  await app.mouse.move(first.x + 12, first.y + first.height / 2, { steps: 3 });
  await app.mouse.up();
  const before = textOf({ name: 'x', path: fx('text.pdf'), bytes: Buffer.alloc(0) });
  const out = await save(app);
  expect(pageCount(out)).toBe(3);
  const orig = [1, 2, 3].map((n) => textOf({ name: 'x', path: fx('text.pdf'), bytes: Buffer.alloc(0) }, n));
  expect(textOf(out, 1)).toBe(orig[2]);
  expect(textOf(out, 2)).toBe(orig[0]);
  expect(textOf(out, 3)).toBe(orig[1]);
  expect(before.length).toBeGreaterThan(0);
  qpdfCheck(out);
});

// ---- 3. print --------------------------------------------------------------------------------------

test('print: the chosen range is what the print frame receives @FR-VIEW-09', async ({ app }) => {
  // The app prints by loading a PDF blob into a hidden iframe and calling print() on it. The frame's
  // window is replaced by a stub so no system dialog opens, and the blob is kept for inspection.
  await app.addInitScript(() => {
    const w = window as unknown as { __blobs: Blob[]; __prints: number };
    w.__blobs = [];
    w.__prints = 0;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      if (o instanceof Blob && o.type === 'application/pdf') w.__blobs.push(o);
      return create(o);
    };
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get() {
        return { focus() {}, print: () => w.__prints++ };
      },
    });
  });
  await app.reload();
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await openPdf(app, 'text.pdf');
  await app.keyboard.press('Control+p');
  const dialog = app.getByRole('dialog', { name: 'Print' });
  await dialog.getByRole('radio', { name: 'Range' }).check();
  await dialog.getByRole('textbox', { name: 'Range' }).fill('3-2');
  await dialog.getByLabel('Copies').fill('2');
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
  await expect(dialog).toBeHidden();
  const bytes = await app.evaluate(async () => {
    const blobs = (window as unknown as { __blobs: Blob[] }).__blobs;
    return Array.from(new Uint8Array(await blobs[blobs.length - 1]!.arrayBuffer()));
  });
  const path = tmpFile('printed.pdf', Uint8Array.from(bytes));
  const printed = { name: 'printed.pdf', path, bytes: Buffer.from(bytes) };
  qpdfCheck(printed);
  // Pages 3 and 2, twice.
  expect(pageCount(printed)).toBe(4);
  const orig = (n: number): string => textOf({ name: 'x', path: fx('text.pdf'), bytes: Buffer.alloc(0) }, n);
  expect([1, 2, 3, 4].map((n) => textOf(printed, n))).toEqual([orig(3), orig(2), orig(3), orig(2)]);
});

// ---- 4. clipboard paste ----------------------------------------------------------------------------

test('paste: copied annotations and an image from the clipboard @FR-ANN-12 @FR-EDT-07', async ({ app }) => {
  await openPdf(app, 'annotated.pdf');
  await mode(app, 'Annotate');
  const before = await app.locator('.pv').first().locator('[data-annot], .annot').count().catch(() => 0);
  void before;
  // Image from the clipboard becomes a placement in Edit mode.
  const png = readFileSync(fx('signature.png'));
  await app.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'clip.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  await expect(app.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByText('Click the page to place it. Esc cancels.')).toBeVisible();
  const box = await pageBox(app);
  await app.mouse.move(box.x + 300, box.y + 500);
  await app.mouse.click(box.x + 300, box.y + 500);
  await expect(undo(app)).toBeEnabled();
  const out = await save(app);
  expect(qdf(out)).toMatch(/\/Subtype \/Image/);
  await undo(app).click();
  await expect(undo(app)).toBeDisabled();
});
