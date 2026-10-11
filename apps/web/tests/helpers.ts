// Shared pieces of the web e2e suite. The UI is exercised through roles and labels only; results are
// checked with the same external oracles as the headless suites (qpdf, poppler).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base, type Download, type Locator, type Page } from '@playwright/test';
import { fx } from './paths.ts';

export { expect, fx };

interface Fixtures {
  /** Requests that left the app's own origin (NFR-14: must stay empty by default). */
  outbound: string[];
  app: Page;
}

export const test = base.extend<Fixtures>({
  outbound: async ({ page, baseURL }, use) => {
    const outbound: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      if (!url.startsWith(baseURL!) && !/^(data|blob|about):/.test(url)) outbound.push(url);
    });
    await use(outbound);
  },
  app: async ({ page, outbound }, use, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    // Without the File System Access API the app falls back to file inputs and downloads, which is
    // what Playwright can drive in every browser.
    await page.addInitScript(() => {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus && errors.length) console.warn('browser errors:\n' + errors.join('\n'));
    expect(errors, 'no errors in the browser console').toEqual([]);
    expect(outbound, 'no request leaves the device').toEqual([]);
  },
});

/** Runs `action`, which must open a file chooser, and answers it with fixture files. */
export async function choose(page: Page, action: () => Promise<unknown>, ...files: string[]): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), action()]);
  await chooser.setFiles(files.map(fx));
}

/** Opens fixtures in tabs through the Open command and waits for the last one to render. */
export async function openPdf(page: Page, ...files: string[]): Promise<void> {
  for (const file of files) {
    await choose(page, () => page.keyboard.press('Control+o'), file);
    await expect(tabs(page).getByRole('button', { name: file, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.pv canvas').first()).toBeVisible();
  }
  await dismissCoach(page);
}

/** The strip of open documents in the title bar. */
export const tabs = (page: Page): Locator => page.getByRole('navigation', { name: 'Open documents' });

export async function dismissCoach(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

export const mode = (page: Page, name: 'View' | 'Organise' | 'Annotate' | 'Fill & Sign' | 'Edit'): Promise<void> =>
  page.getByRole('tablist', { name: 'Mode' }).getByRole('tab', { name }).click();

export const tool = (page: Page, name: string): Locator => page.getByRole('toolbar').getByRole('button', { name, exact: true });

export async function menu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

export interface Saved {
  name: string;
  path: string;
  bytes: Buffer;
}
const outDir = mkdtempSync(join(tmpdir(), 'folio-e2e-'));
async function keep(d: Download): Promise<Saved> {
  const path = join(outDir, `${Date.now()}-${d.suggestedFilename()}`);
  await d.saveAs(path);
  return { name: d.suggestedFilename(), path, bytes: readFileSync(path) };
}
/** Runs `action` and collects the `count` files it downloads. */
export async function downloads(page: Page, count: number, action: () => Promise<unknown>): Promise<Saved[]> {
  const got: Array<Promise<Saved>> = [];
  const done = new Promise<void>((resolve) => {
    const on = (d: Download): void => {
      got.push(keep(d));
      if (got.length === count) {
        page.off('download', on);
        resolve();
      }
    };
    page.on('download', on);
  });
  await action();
  await done;
  return Promise.all(got);
}
/** Saves the active document (Ctrl+S) and returns the written file. */
export const save = async (page: Page): Promise<Saved> => (await downloads(page, 1, () => page.keyboard.press('Control+s')))[0]!;

// ---- oracles ---------------------------------------------------------------------------------------

const run = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
export const pageCount = (f: Saved): number => Number(/Pages:\s+(\d+)/.exec(run('pdfinfo', [f.path]))![1]);
/** Text as poppler reads it. Any complaint on stderr fails the test: other viewers must open our files cleanly. */
export function textOf(f: Saved, page?: number): string {
  const r = spawnSync('pdftotext', [...(page ? ['-f', String(page), '-l', String(page)] : []), '-layout', f.path, '-'], { encoding: 'utf8' });
  expect(r.stderr, `poppler warnings for ${f.name}`).toBe('');
  return r.stdout;
}
/** `qpdf --check` exits non-zero on structural errors. */
export const qpdfCheck = (f: Saved): string => run('qpdf', ['--check', f.path]);
/** Uncompressed object dump, for looking at dictionaries. */
export function qdf(f: Saved): string {
  const out = `${f.path}.qdf`;
  run('qpdf', ['--qdf', '--object-streams=disable', '--static-id', f.path, out]);
  return readFileSync(out, 'latin1');
}
export const tmpFile = (name: string, data: Uint8Array | string): string => {
  const p = join(outDir, name);
  writeFileSync(p, data);
  return p;
};

/** Page box of the first rendered page, for pointer work in page coordinates (CSS px from its top-left). */
export const firstPage = (page: Page): Locator => page.locator('.pv').first();
