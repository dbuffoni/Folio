import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import { opensslPkcs12, pki, qpdfCheck, textDoc } from '@folio/testkit';
import {
  CertificateError,
  SigningError,
  listSignatureFields,
  openPkcs12,
  signPdf,
  validateSignatures,
} from './index.ts';

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const rect = { x: 72, y: 100, width: 200, height: 50 };

/** A one-page file with the given AcroForm built by `build`. */
async function withForm(
  build: (
    ctx: PDFDocument['context'],
    page: ReturnType<PDFDocument['getPages']>[number],
    doc: PDFDocument,
  ) => unknown[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await textDoc({ pages: 1 }));
  const page = doc.getPages()[0]!;
  const fields = build(doc.context, page, doc);
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: fields as never }));
  return doc.save({ useObjectStreams: false });
}
const widget = (ctx: PDFDocument['context'], page: { ref: never }, extra: Record<string, unknown>) =>
  ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [72, 100, 272, 150], F: 4, P: page.ref, ...extra }),
  );

describe('Signature fields in unusual files @FR-SIG-03 @FR-SIG-02', () => {
  it('a signature widget below a parent field is found and can be signed by its full name @FR-SIG-03', async () => {
    const pdf = await withForm((ctx, page) => {
      const kid = widget(ctx, page as never, { T: PDFString.of('Sig1'), FT: 'Sig' });
      const parent = ctx.register(ctx.obj({ T: PDFString.of('Form'), Kids: [kid] }));
      (ctx.lookup(kid, PDFDict) as PDFDict).set(PDFName.of('Parent'), parent);
      page.node.set(PDFName.of('Annots'), ctx.obj([kid]));
      return [parent];
    });
    const fields = await listSignatureFields(pdf);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ signed: false, page: 0 });
    expect(fields[0]!.name).toMatch(/Sig1$/);
    const signed = await signPdf(pdf, {
      identity: (await pki()).identity,
      fieldName: fields[0]!.name,
      appearance: { page: 0, rect, lines: ['x'] },
    });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    expect((await listSignatureFields(signed))[0]).toMatchObject({ signed: true });
    expect((await validateSignatures(signed))[0]).toMatchObject({ integrity: 'ok' });
  });

  it('a field type inherited from the parent and a field without a name are tolerated @FR-SIG-03', async () => {
    const pdf = await withForm((ctx, page) => {
      const kid = widget(ctx, page as never, {});
      const parent = ctx.register(ctx.obj({ T: PDFString.of('Inherited'), FT: 'Sig', Kids: [kid] }));
      (ctx.lookup(kid, PDFDict) as PDFDict).set(PDFName.of('Parent'), parent);
      const nameless = widget(ctx, page as never, { FT: 'Sig' });
      page.node.set(PDFName.of('Annots'), ctx.obj([kid, nameless]));
      return [parent, nameless];
    });
    const fields = await listSignatureFields(pdf);
    expect(fields.length).toBeGreaterThanOrEqual(1);
    expect(fields.every((f) => f.signed === false)).toBe(true);
    const signed = await signPdf(pdf, { identity: (await pki()).identity });
    expect((await qpdfCheck(signed)).ok).toBe(true);
  });

  it('a text field with the requested name is not a signature field; a new signature is still added @FR-SIG-03', async () => {
    const pdf = await withForm((ctx, page) => {
      const text = widget(ctx, page as never, { T: PDFString.of('Signature1'), FT: 'Tx' });
      const other = widget(ctx, page as never, { T: PDFString.of('Signature2'), FT: 'Btn' });
      page.node.set(PDFName.of('Annots'), ctx.obj([text, other]));
      return [text, other];
    });
    const { identity } = await pki();
    await expect(signPdf(pdf, { identity, fieldName: 'Signature1' })).rejects.toMatchObject({
      code: 'field-not-found',
    });
    const signed = await signPdf(pdf, { identity });
    const [sig] = await listSignatureFields(signed);
    // SPEC ambiguity (see report): the new field currently reuses the name of the text field.
    expect(sig!.signed).toBe(true);
    expect((await qpdfCheck(signed)).ok).toBe(true);
  });

  it('existing form flags, an indirect field list and /NeedAppearances survive signing @FR-SIG-02', async () => {
    const doc = await PDFDocument.load(await textDoc({ pages: 1 }));
    const ctx = doc.context;
    const fields = ctx.register(ctx.obj([]));
    doc.catalog.set(
      PDFName.of('AcroForm'),
      ctx.obj({ Fields: fields, NeedAppearances: true, DA: PDFString.of('/Helv 0 Tf 0 g') }),
    );
    const pdf = await doc.save({ useObjectStreams: false });
    const signed = await signPdf(pdf, { identity: (await pki()).identity });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    const form = (await PDFDocument.load(signed)).catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(form.lookup(PDFName.of('Fields'), PDFArray).size()).toBe(1);
    expect(form.get(PDFName.of('SigFlags'))?.toString()).toMatch(/^[1-3]$/);
    expect(form.lookup(PDFName.of('DA'))).toBeDefined();
  });

  it('rotated pages and offset media boxes still get a visible, valid signature @FR-SIG-02', async () => {
    const doc = await PDFDocument.load(await textDoc({ pages: 2 }));
    doc.getPages()[0]!.setRotation(degrees(90));
    doc.getPages()[1]!.setMediaBox(100, 100, 300, 400);
    const pdf = await doc.save({ useObjectStreams: false });
    const { identity } = await pki();
    for (const page of [0, 1]) {
      const signed = await signPdf(pdf, {
        identity,
        appearance: { page, rect: { x: 120, y: 120, width: 100, height: 40 }, lines: ['Rotated'] },
      });
      expect((await qpdfCheck(signed)).ok).toBe(true);
      expect((await listSignatureFields(signed))[0]).toMatchObject({ page, signed: true });
    }
  });

  it('files that are not usable PDFs fail with a typed signing error @FR-SIG-01', async () => {
    const { identity } = await pki();
    for (const bytes of [
      new Uint8Array(0),
      new TextEncoder().encode('%PDF-1.7\n'),
      new Uint8Array(500).fill(7),
    ]) {
      const err = await signPdf(bytes, { identity }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SigningError);
      expect(['damaged', 'encrypted']).toContain((err as SigningError).code);
    }
    expect(await listSignatureFields(new Uint8Array(0)).catch(() => 'threw')).toSatisfy(
      (v: unknown) => v === 'threw' || Array.isArray(v),
    );
  });

  it('trailing bytes after %%EOF do not stop a file from being signed @FR-SIG-02', async () => {
    const pdf = await textDoc({ pages: 1 });
    const padded = new Uint8Array(pdf.length + 6);
    padded.set(pdf);
    padded.set(new TextEncoder().encode('\n\n\n\n\n\n'), pdf.length);
    const { identity } = await pki();
    const signed = await signPdf(padded, { identity });
    expect((await qpdfCheck(signed)).ok).toBe(true);
    expect((await validateSignatures(signed))[0]).toMatchObject({
      integrity: 'ok',
      changedAfterSigning: false,
    });
  });
});

describe('Signing time and dates in the signature dictionary @FR-SIG-04', () => {
  it('odd /M date strings never throw and never produce an invalid timestamp @FR-SIG-04', async () => {
    const { identity } = await pki();
    const signed = await signPdf(await textDoc({ pages: 1 }), {
      identity,
      signingTime: new Date('2026-04-02T08:30:00Z'),
    });
    const text = latin1(signed);
    const at = text.search(/\/M \(D:/);
    expect(at).toBeGreaterThan(0);
    const start = at + 4;
    const original = text.slice(start, start + 17);
    expect(original).toMatch(/^D:\d{14}Z$/);
    for (const variant of [
      'D:2026040208Z    ',
      'D:2026           ',
      'garbage-garbage-g',
      '                 ',
    ]) {
      expect(variant).toHaveLength(17);
      const copy = signed.slice();
      for (let i = 0; i < 17; i++) copy[start + i] = variant.charCodeAt(i);
      const [r] = await validateSignatures(copy);
      expect(r, variant).toBeDefined();
      if (r!.signingTime !== null && r!.signingTime !== undefined)
        expect(Number.isNaN(Date.parse(r!.signingTime)), variant).toBe(false);
    }
  });
});

describe('Unsupported or foreign key types are named @FR-CRT-01', () => {
  it('P-521, Ed25519, Ed448 and RSA-PSS keys are refused as unsupported, with the right password @FR-CRT-01', async () => {
    for (const o of [
      { curve: 'secp521r1' },
      { ed25519: true },
      { newkey: ['ed448'] },
      { newkey: ['rsa-pss'] },
    ]) {
      const { p12 } = await opensslPkcs12({ cn: 'k', password: 'pw', ...o });
      const err = await openPkcs12(p12, 'pw').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CertificateError);
      expect((err as CertificateError).code).toBe('unsupported');
    }
  });

  it('RSA keys of other sizes import and sign @FR-CRT-01 @FR-SIG-01', async () => {
    for (const bits of [3072, 4096]) {
      const { p12 } = await opensslPkcs12({ cn: `RSA ${bits}`, password: 'pw', newkey: [`rsa:${bits}`] });
      const identity = await openPkcs12(p12, 'pw');
      expect(identity.info.keyAlgorithm).toBe('RSA');
      const signed = await signPdf(await textDoc({ pages: 1 }), { identity });
      expect((await validateSignatures(signed))[0]).toMatchObject({ integrity: 'ok' });
    }
  });
});
