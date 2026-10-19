import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { InvalidPdfError } from '@folio/core';
import { opensslPkcs12 } from '@folio/testkit';
import { describeError } from './app.ts';
import { createTestApp, type TestApp } from './testing.ts';

const en = JSON.parse(
  readFileSync(new URL('../../../apps/web/src/lib/i18n/messages/en.json', import.meta.url), 'utf8'),
) as Record<string, string>;

async function signedPanel(): Promise<{ t: TestApp; p: ReturnType<TestApp['signatures']> }> {
  const t = await createTestApp();
  (t.services.platform.clock as unknown as { set(d: Date): void }).set(new Date(Date.now() + 3600e3));
  const { p12 } = await opensslPkcs12({ cn: 'Ada Lovelace', password: 'pw' });
  t.files.put('/keys/id.p12', p12);
  t.prompts.passwords.push('pw');
  await t.certificates().importIdentityFrom(t.files.ref('/keys/id.p12'));
  const sign = t.digitalSign(await t.open('multilingual'));
  await sign.start();
  t.files.nextSave.push('/out/signed.pdf');
  await sign.run();
  const p = t.signatures((await t.app.openRef(t.files.ref('/out/signed.pdf')))!);
  await p.validate();
  return { t, p };
}

describe('Revocation that could not be checked (R18) @FR-SIG-06', () => {
  it('a valid signature whose revocation is unknown is not shown as plain Valid @FR-SIG-06 @FR-SIG-04', async () => {
    const { p } = await signedPanel();
    const base = p.reports[0]!;
    p.reports = [{ ...base, status: 'valid', trust: 'trusted', changedAfterSigning: false, revocation: 'unknown', index: 0 }];
    expect(p.statusKey(p.reports[0]!)).toBe('sigpanel.status.valid-revocation-unknown');
    expect(p.noteKey(p.reports[0]!)).toBe('sigpanel.note.revocationUnknown');
    expect(p.summary).toBe('warning');
    for (const key of ['sigpanel.status.valid-revocation-unknown', 'sigpanel.note.revocationUnknown']) expect(en[key]).toBeTruthy();
    // Checked and good, or not checked at all: plain Valid as before.
    for (const revocation of ['good', 'not-checked'] as const) {
      p.reports = [{ ...base, status: 'valid', trust: 'trusted', changedAfterSigning: false, revocation, index: 0 }];
      expect(p.statusKey(p.reports[0]!)).toBe('sigpanel.status.valid');
      expect(p.noteKey(p.reports[0]!)).toBeUndefined();
      expect(p.summary).toBe('valid');
    }
    p.reports = [{ ...base, status: 'valid-untrusted', revocation: 'unknown', index: 0 }];
    expect(p.statusKey(p.reports[0]!)).toBe('sigpanel.status.valid-untrusted');
  });
});

describe('Field authoring on an unreadable file (R7) @FR-FRM-08', () => {
  it('has its own message, not the encrypted-file one @FR-FRM-08', () => {
    const { message } = describeError(new InvalidPdfError('No PDF header found', 'formEdit'));
    expect(message.key).toBe('error.invalidPdf.formEdit');
    expect(en['error.invalidPdf.formEdit']).toBeTruthy();
    expect(describeError(new InvalidPdfError()).message.key).toBe('error.invalidPdf');
  });
});
