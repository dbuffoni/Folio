// Screens and flows that had no browser test yet (Notion card "Browser tests for remaining screens").
// Already covered elsewhere and therefore not repeated here:
//  - recovery prompt after a reload, restore and decline: resilience.spec.ts (@FR-APP-06)
//  - profile import/export: resilience.spec.ts (@FR-FRM-20)
//  - signing with a certificate, happy path and verification: signatures.spec.ts (@FR-SIG-01 ..)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { choose, expect, firstPage, fx, menu, mode, openPdf, pageCount, qdf, qpdfCheck, save, tabs, test, textOf, tmpFile, tool } from './helpers.ts';

const status = (page: Page) => page.getByRole('contentinfo');
const undo = (page: Page) => page.getByLabel('Undo', { exact: true });
const pageBox = async (page: Page) => (await firstPage(page).boundingBox())!;

/** A fixture as a `Saved`, so that the same oracles can read it. */
const fixture = (name: string) => ({ name, path: fx(name), bytes: readFileSync(fx(name)) });
const original = (page: number): string => textOf(fixture('text.pdf'), page);

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
  await dialog.getByLabel('Font').selectOption('serif');
  await dialog.getByRole('button', { name: 'Save stamp' }).click();
  const mine = dialog.getByRole('button', { name: 'REVIEWED 4471', exact: true });
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
  const out = await save(app);
  expect(pageCount(out)).toBe(3);
  const orig = [1, 2, 3].map(original);
  expect(textOf(out, 1)).toBe(orig[2]);
  expect(textOf(out, 2)).toBe(orig[0]);
  expect(textOf(out, 3)).toBe(orig[1]);
  qpdfCheck(out);
});

// ---- 3. print --------------------------------------------------------------------------------------

test('print: the chosen range is what the print frame receives @FR-VIEW-09', async ({ app }) => {
  // The app prints by loading a PDF blob into a hidden iframe and calling print() on it. The frame's
  // window is replaced by a stub so no system dialog opens, and the blob is kept for inspection.
  await app.evaluate(() => {
    const w = window as unknown as { __blobs: Blob[]; __prints: number };
    w.__blobs = [];
    w.__prints = 0;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      // The PDF is kept for inspection; the frame gets about:blank so that it loads in every engine
      // (headless browsers have no PDF viewer and would turn the frame into a download).
      if (o instanceof Blob && o.type === 'application/pdf') {
        w.__blobs.push(o);
        return 'about:blank';
      }
      return create(o);
    };
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get() {
        return { focus() {}, print: () => w.__prints++ };
      },
    });
  });
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
  expect([1, 2, 3, 4].map((n) => textOf(printed, n))).toEqual([original(3), original(2), original(3), original(2)]);
});

// ---- 4. clipboard paste ----------------------------------------------------------------------------

test('paste: copied annotations and an image from the clipboard @FR-ANN-06 @FR-EDT-07', async ({ app }) => {
  await openPdf(app, 'annotated.pdf');
  await mode(app, 'Annotate');
  // Image from the clipboard becomes a placement in Edit mode.
  const png = readFileSync(fx('signature.png'));
  await app.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'clip.png', { type: 'image/png' }));
    // Firefox ignores `clipboardData` in the constructor, so it is defined on the event.
    const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: dt });
    document.body.dispatchEvent(e);
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

test('paste: a copied annotation is pasted back and undo removes it @FR-ANN-06', async ({ app }) => {
  // The clipboard itself is not readable in every engine; the copy is captured and replayed as a paste event.
  await app.evaluate(() => {
    const w = window as unknown as { __clip: string };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void (w.__clip = t) } });
  });
  await openPdf(app, 'text.pdf');
  await mode(app, 'Annotate');
  await tool(app, 'Note').click();
  const box = await pageBox(app);
  await app.mouse.click(box.x + 400, box.y + 300);
  await expect(undo(app)).toBeEnabled();
  await app.keyboard.press('Escape');
  await app.mouse.click(box.x + 400, box.y + 300); // select the note (the Note tool stays armed for the next click)
  await app.keyboard.press('Control+c');
  await expect.poll(() => app.evaluate(() => (window as unknown as { __clip?: string }).__clip ?? '')).not.toBe('');
  const text = await app.evaluate(() => (window as unknown as { __clip: string }).__clip);
  await app.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    // Firefox ignores `clipboardData` in the constructor, so it is defined on the event.
    const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: dt });
    document.body.dispatchEvent(e);
  }, text);
  await expect(app.getByRole('contentinfo').getByText(/Unsaved/)).toBeVisible();
  const notes = (f: Awaited<ReturnType<typeof save>>): number => (qdf(f).match(/\/Subtype \/Text\b/g) ?? []).length;
  await expect.poll(async () => notes(await save(app))).toBe(2);
  await undo(app).click();
  expect(notes(await save(app))).toBe(1);
});

// ---- 7. image resize handles ---------------------------------------------------------------------

/** Width and height in points of the first image drawn on page 1: the cm matrix in front of its Do. */
function imageSize(f: Awaited<ReturnType<typeof save>>): { w: number; h: number } {
  const m = /q\s+([\d.]+) 0 0 ([\d.]+) [\d.-]+ [\d.-]+ cm\s*\n?\s*\/\w+ Do/.exec(qdf(f));
  expect(m, 'an image draw operator').not.toBeNull();
  return { w: Number(m![1]), h: Number(m![2]) };
}

test('edit: dragging an image corner handle resizes it in the saved page @FR-EDT-07', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await mode(app, 'Edit');
  await choose(app, () => tool(app, 'Add image').click(), 'photo-1.jpg');
  const box = await pageBox(app);
  await app.mouse.move(box.x + 300, box.y + 400);
  await app.mouse.click(box.x + 300, box.y + 400);
  await expect(undo(app)).toBeEnabled();
  const placed = imageSize(await save(app));
  const handle = app.locator('.abox .h.br').first();
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await app.mouse.move(x, y);
  await app.mouse.down();
  await app.mouse.move(x + 60, y + 40, { steps: 8 });
  await app.mouse.up();
  const resized = imageSize(await save(app));
  expect(resized.w).toBeGreaterThan(placed.w + 20);
  expect(resized.h).toBeGreaterThan(placed.h + 5);
  expect(resized.w / resized.h).toBeCloseTo(placed.w / placed.h, 1); // corner drag keeps the proportions
});

// ---- 8. certificates: wrong password -------------------------------------------------------------
// The happy path (import, sign, verify with pdfsig) is signatures.spec.ts.

function makeP12(cn: string, password: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'folio-gaps-cert-'));
  const key = join(dir, 'k.pem');
  const crt = join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '30', '-subj', `/CN=${cn}`, '-addext', 'keyUsage=digitalSignature'], { stdio: 'ignore' });
  const out = join(dir, 'id.p12');
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', crt, '-out', out, '-passout', `pass:${password}`]);
  return out;
}

test('certificates: a wrong PKCS#12 password is refused with a clear message and can be retried @FR-CRT-01', async ({ app }) => {
  const p12 = makeP12('Grace Hopper', 'right-one');
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Certificates' }).click();
  const [chooser] = await Promise.all([app.waitForEvent('filechooser'), settings.getByRole('button', { name: /Import certificate/ }).click()]);
  await chooser.setFiles(p12);
  const prompt = app.getByRole('dialog', { name: /password/i });
  await prompt.getByLabel(/password/i).fill('wrong-one');
  await prompt.getByLabel(/password/i).press('Enter');
  // The prompt stays open and says what is wrong; nothing was imported.
  await expect(prompt.getByRole('alert')).toHaveText('That password is not correct.');
  await expect(settings.getByTestId('cert-identities').getByText('Grace Hopper')).toHaveCount(0);
  await prompt.getByLabel(/password/i).fill('right-one');
  await prompt.getByLabel(/password/i).press('Enter');
  await expect(settings.getByTestId('cert-identities').getByText('Grace Hopper')).toBeVisible();
});

// ---- 9. remove hidden data ----------------------------------------------------------------------

/** True when the dump holds `secret` as plain text or as a UTF-16BE hex string (how PDF writes non-ASCII-safe info strings). */
const holds = (dump: string, secret: string): boolean =>
  dump.includes(secret) || dump.toLowerCase().includes('feff' + [...secret].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
const SECRETS = ['SECRET-AUTHOR-7731', 'SECRET-XMP-4418', 'SECRET-SCRIPT-9902', 'SECRET-REVIEWER-5520', 'SECRET-ATTACHMENT-3306'];

test('remove hidden data: everything on by default, summary, nothing left in the saved file @FR-SEC-12', async ({ app }) => {
  expect(SECRETS.filter((x) => holds(qdf(fixture('hidden-data.pdf')), x)), 'the fixture carries every secret').toEqual(SECRETS);
  await openPdf(app, 'hidden-data.pdf');
  await (await palette(app, 'Remove hidden data')).getByRole('option', { name: /Remove hidden data/ }).click();
  const dialog = app.getByRole('dialog', { name: 'Remove hidden data' });
  const boxes = dialog.getByRole('checkbox');
  await expect(boxes).toHaveCount(6);
  for (const box of await boxes.all()) await expect(box).toBeChecked();
  await expect(boxes.first()).toHaveAccessibleName(/Attached files/); // attachments are listed first
  await expect(dialog.getByText('1 found').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove hidden data', exact: true }).click();
  const summary = dialog.getByRole('status');
  await expect(summary).toContainText('Removed from this file:');
  for (const line of ['Document info', 'XMP metadata', 'attached file', 'script', 'comment author']) await expect(summary).toContainText(line);
  await dialog.locator('[data-autofocus]').click(); // the footer Close
  await expect(dialog).toBeHidden();
  const out = await save(app);
  qpdfCheck(out);
  const info = execFileSync('pdfinfo', [out.path], { encoding: 'utf8' });
  expect(info).not.toMatch(/^Author:/m);
  expect(info).not.toMatch(/^Title:/m);
  const dump = qdf(out);
  for (const secret of SECRETS) expect(holds(dump, secret), secret).toBe(false);
  expect(textOf(out).length).toBeGreaterThan(0); // the visible content stays
});

test('remove hidden data on a signed file warns and offers a cleaned copy @FR-SEC-12', async ({ app }) => {
  await openPdf(app, 'signed.pdf');
  await (await palette(app, 'Remove hidden data')).getByRole('option', { name: /Remove hidden data/ }).click();
  const dialog = app.getByRole('dialog', { name: 'Remove hidden data' });
  await expect(dialog.getByText(/digitally signed/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save a cleaned copy…' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Remove and invalidate signatures' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(undo(app)).toBeDisabled(); // cancelling changed nothing
});

// ---- 10. protected file ------------------------------------------------------------------------------

test('protected file: lock icon, disabled tools with the reason, viewing still works, Properties lists the limits @FR-SEC-07', async ({ app }) => {
  await openPdf(app, 'restricted.pdf');
  await expect(tabs(app).getByRole('img', { name: /Password protected/ }).or(tabs(app).locator('.lock')).first()).toBeVisible();
  await expect(status(app).getByRole('img', { name: /Password protected: some actions are restricted by the file/ })).toBeVisible();

  // Viewing: zoom and find are not affected.
  const zoom = status(app).getByText(/%/).first();
  const before = await zoom.textContent();
  await app.getByRole('button', { name: 'Zoom in' }).first().click();
  await expect(zoom).not.toHaveText(before!);
  await app.keyboard.press('Control+f');
  await app.getByRole('textbox', { name: 'Find' }).first().fill('Total');
  await expect(app.getByText(/^\d+ of \d+$/).first()).toBeVisible();
  await app.keyboard.press('Escape');

  // Printing is refused: the toolbar button says why and the dialog does not open.
  const print = app.getByRole('toolbar').getByRole('button', { name: /^Print/ });
  await expect(print).toHaveAttribute('aria-disabled', 'true');
  await print.hover();
  await expect(app.getByRole('tooltip')).toContainText('This file does not allow printing');
  await app.keyboard.press('Control+p');
  await expect(app.getByRole('dialog', { name: 'Print' })).toHaveCount(0);

  // Annotate and Edit tools are aria-disabled with their reasons.
  await mode(app, 'Annotate');
  const highlight = tool(app, 'Highlight');
  await expect(highlight).toHaveAttribute('aria-disabled', 'true');
  await highlight.hover();
  await expect(app.getByRole('tooltip')).toContainText('This file does not allow comments or markup');
  await mode(app, 'Edit');
  const addText = tool(app, 'Add text');
  await expect(addText).toHaveAttribute('aria-disabled', 'true');
  await addText.hover();
  await expect(app.getByRole('tooltip')).toContainText('This file does not allow editing');
  await expect(undo(app)).toBeDisabled();

  // The command palette lists the commands but does not run them.
  const p = await palette(app, 'Print');
  await expect(p.getByRole('option', { name: /Print/ }).first()).toBeVisible();
  await p.getByRole('option', { name: /Print/ }).first().click();
  await expect(app.getByRole('dialog', { name: 'Print' })).toHaveCount(0);

  // Properties lists what the file forbids.
  await menu(app, 'Document properties…');
  const props = app.getByRole('dialog');
  await expect(props).toContainText('Restrictions');
  for (const what of ['Printing', 'Copying text and images', 'Editing', 'Comments and markup']) await expect(props).toContainText(what);
});
