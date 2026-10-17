// Digital signatures end to end: import a certificate, sign, verify with an independent viewer (pdfsig),
// check the signatures dialog. Screenshots of the new screens go to docs/screenshots/0.1.2.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { downloads, expect, fx, menu, openPdf, qpdfCheck, tabs, test } from './helpers.ts';
import { ROOT } from './paths.ts';
import type { Page } from '@playwright/test';

const SHOTS = join(ROOT, 'docs/screenshots/0.1.2');

function makeP12(cn: string, password: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'folio-cert-'));
  const key = join(dir, 'k.pem');
  const crt = join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '30', '-subj', `/CN=${cn}`, '-addext', 'keyUsage=digitalSignature'], { stdio: 'ignore' });
  const out = join(dir, 'id.p12');
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', crt, '-out', out, '-passout', `pass:${password}`]);
  return out;
}
const pdfsig = (path: string): string => spawnSync('pdfsig', [path], { encoding: 'utf8' }).stdout;

async function importIdentity(app: Page, p12: string, password: string): Promise<void> {
  await app.getByRole('button', { name: 'Settings' }).click();
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Certificates' }).click();
  const [chooser] = await Promise.all([app.waitForEvent('filechooser'), settings.getByRole('button', { name: /Import certificate/ }).click()]);
  await chooser.setFiles(p12);
  const prompt = app.getByRole('dialog', { name: /password/i });
  await prompt.getByLabel(/password/i).fill(password);
  await prompt.getByLabel(/password/i).press('Enter');
  await expect(settings.getByTestId('cert-identities').getByText('Ada Lovelace')).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`sign with a certificate and check it (${scheme}) @FR-CRT-01 @FR-SIG-01 @FR-SIG-02 @FR-SIG-04 @FR-SIG-05`, async ({ app }) => {
    await app.emulateMedia({ colorScheme: scheme });
    const p12 = makeP12('Ada Lovelace', 'pw');
    await importIdentity(app, p12, 'pw');
    const settings = app.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByTestId('cert-detail')).toBeVisible();
    await app.screenshot({ path: join(SHOTS, `certificates-${scheme}.png`) });
    await settings.getByRole('button', { name: 'Close' }).click();

    await openPdf(app, 'text.pdf');
    await menu(app, 'Sign with a certificate…');
    const dialog = app.getByRole('dialog', { name: 'Sign with a certificate' });
    await expect(dialog.getByLabel('Certificate')).toContainText('Ada Lovelace');
    await dialog.getByLabel('Reason').fill('I approve this document');
    await app.screenshot({ path: join(SHOTS, `sign-dialog-${scheme}.png`) });
    const [signed] = await downloads(app, 1, () => dialog.getByRole('button', { name: 'Sign', exact: true }).click());
    expect(signed!.name).toMatch(/signed/i);
    qpdfCheck(signed!);
    const sig = pdfsig(signed!.path);
    expect(sig).toMatch(/Signature is Valid/);
    expect(sig).toMatch(/Ada Lovelace/);
    expect(readFileSync(signed!.path).length).toBeGreaterThan(readFileSync(fx('text.pdf')).length);

    // Open the signed copy; the signatures dialog explains what it sees.
    const [chooser] = await Promise.all([app.waitForEvent('filechooser'), app.keyboard.press('Control+o')]);
    await chooser.setFiles(signed!.path);
    await expect(tabs(app).getByRole('button', { name: basename(signed!.path), exact: true })).toHaveAttribute('aria-current', 'page');
    await menu(app, 'Check digital signatures…');
    const panel = app.getByRole('dialog', { name: 'Digital signatures' });
    await expect(panel.getByTestId('sig-summary')).toBeVisible();
    await app.screenshot({ path: join(SHOTS, `signatures-${scheme}.png`) });
    await app.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
}

test('no certificate: the sign dialog points to Settings @FR-SIG-01', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await menu(app, 'Sign with a certificate…');
  const dialog = app.getByRole('dialog', { name: 'Sign with a certificate' });
  await expect(dialog.getByTestId('dsig-noid')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sign', exact: true })).toBeDisabled();
  await app.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('an unsigned document says so in the signatures dialog @FR-SIG-04', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  await menu(app, 'Check digital signatures…');
  await expect(app.getByRole('dialog', { name: 'Digital signatures' }).getByTestId('sig-none')).toBeVisible();
});
