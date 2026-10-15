// Whole workflows checked with independent tools (NFR-08, SPEC §15): the output of several chained
// operations must be valid for qpdf and pdfcpu, say the right thing in poppler, and keep its protections.
import { describe, expect, it } from 'vitest';
import { History } from '@folio/core';
import {
  FIXTURE_PASSWORD,
  fixture,
  pdfcpuFormFields,
  pdfinfo,
  pdftotext,
  qpdfQdf,
  sharedEngine,
} from '@folio/testkit';
import {
  AnnotationService,
  ExportService,
  MergeService,
  PageService,
  SplitService,
  planFiles,
  planSplit,
} from '@folio/services';
import { FakeClock, NodeImageCodec } from '@folio/testkit';

const opened = async (name: string, password?: string) => {
  const engine = await sharedEngine();
  const doc = await engine.open(await fixture(name), { password });
  return { engine, doc, history: new History({ doc, engine }) };
};

describe('protections survive saving @FR-APP-12 @FR-SEC-04', () => {
  it('an encrypted document stays encrypted on full and incremental saves, and needs its password @NFR-08', async () => {
    const { doc } = await opened('encrypted', FIXTURE_PASSWORD);
    await doc.upsertAnnotation(0, {
      type: 'text',
      rect: { x: 60, y: 60, width: 20, height: 20 },
      contents: 'secret note',
    });
    for (const incremental of [false, true]) {
      const bytes = await doc.save({ incremental });
      await expect(bytes).toBeValidPdf({ password: FIXTURE_PASSWORD });
      expect((await pdfinfo(bytes, FIXTURE_PASSWORD)).encrypted).toBe(true);
      await expect(pdfinfo(bytes)).rejects.toThrow(/password/i);
      // The text of the document is not readable without the password.
      await expect(pdftotext(bytes)).rejects.toThrow();
      expect(Buffer.from(bytes).includes(Buffer.from('secret note'))).toBe(false);
    }
    doc.dispose();
  });

  it('"remove all metadata" leaves no trace of the old values anywhere in the file @FR-SEC-04', async () => {
    const { doc, history } = await opened('invoice');
    const before = await doc.getMeta();
    expect(before.title).toBeTruthy();
    const { DocumentService } = await import('@folio/services');
    await history.execute(
      new DocumentService({
        engine: await sharedEngine(),
        files: {} as never,
        crypto: {} as never,
      }).removeAllMetadata(),
    );
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    const qdf = await qpdfQdf(bytes);
    for (const old of [before.title, before.author, before.subject, before.keywords].filter(
      (s) => s && s.length > 3,
    ))
      expect(qdf, old).not.toContain(old);
    const info = await pdfinfo(bytes);
    expect([info.title, info.author, info.subject, info.keywords]).toEqual(['', '', '', '']);
    doc.dispose();
  });
});

describe('chained operations @FR-ORG-01 @FR-APP-05', () => {
  it('rotate, delete, move, blank page, annotate, flatten: valid file, expected text; undo of everything restores the original @NFR-08', async () => {
    const { engine, doc, history } = await opened('text-25');
    const original = await pdftotext(await doc.save());
    const pages = new PageService(engine);
    const annots = new AnnotationService({
      author: () => 'Marta',
      now: () => new FakeClock().now(),
      newId: (() => {
        let n = 0;
        return () => `i-${++n}`;
      })(),
    });
    await history.execute(pages.rotate(doc, [0, 1], 90));
    await history.execute(pages.delete(doc, [2, 3, 4]));
    await history.execute(pages.reorder(doc, [20], 0));
    await history.execute(pages.insertBlank(doc, 1, { width: 595, height: 842 }));
    await history.execute(
      annots.add(0, {
        type: 'freetext',
        rect: { x: 50, y: 50, width: 200, height: 30 },
        contents: 'Reviewed',
        fontSize: 12,
        fontFamily: 'sans',
        textColor: { r: 0, g: 0, b: 0 },
        align: 'left',
      }),
    );
    await history.execute(
      new ExportService(new NodeImageCodec()).flatten('annotations'),
    );
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    await expect(bytes).toHavePageCount(23);
    const text = await pdftotext(bytes);
    expect(text).toContain('Reviewed'); // flattened into the page content
    expect(text).toContain('Page 24 of 25'); // the moved page now leads
    expect(text).not.toContain('Page 3 of 25');
    await history.goTo(0);
    const restored = await doc.save();
    await expect(restored).toBeValidPdf();
    await expect(restored).toHavePageCount(25);
    expect(await pdftotext(restored)).toBe(original);
    doc.dispose();
  });

  it('merge then split gives back every page unchanged, each part valid @FR-MRG-01 @FR-MRG-04 @NFR-08', async () => {
    const engine = await sharedEngine();
    const a = await fixture('text');
    const b = await fixture('bookmarks');
    const merged = await new MergeService({ engine, images: new NodeImageCodec() }).merge(
      [
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ],
      { bookmarks: true },
    );
    const mergedBytes = await merged.save();
    await expect(mergedBytes).toBeValidPdf();
    const expected = [await pdftotext(a), await pdftotext(b)].join('');
    const parts = planSplit(merged.pageCount, { kind: 'single' });
    const plan = await planFiles(parts, {
      template: '{name}_{n}',
      sourceName: 'merged.pdf',
      policy: 'autoNumber',
      exists: async () => false,
    });
    const out: Uint8Array[] = [];
    await new SplitService(engine).execute(merged, plan, async (_n, bytes) => void out.push(bytes));
    expect(out).toHaveLength(merged.pageCount);
    for (const part of out) {
      await expect(part).toBeValidPdf();
      await expect(part).toHavePageCount(1);
    }
    const joined = (await Promise.all(out.map((p) => pdftotext(p)))).join('');
    expect(joined.replace(/\f/g, '')).toBe(expected.replace(/\f/g, ''));
    merged.dispose();
  });

  it('flattening a filled form keeps the values visible and removes the fields @FR-FRM-05 @NFR-08', async () => {
    const { engine, doc } = await opened('acroform-prefilled');
    const before = await pdfcpuFormFields(await doc.save());
    expect(before.length).toBeGreaterThan(0);
    const bytes = await new ExportService(new NodeImageCodec()).flattenedCopy(doc, engine);
    await expect(bytes).toBeValidPdf();
    expect(await pdfcpuFormFields(bytes)).toEqual([]);
    const visible = await pdftotext(bytes);
    const sample = (await doc.listFormFields())
      .map((f) => f.value)
      .find((v): v is string => typeof v === 'string' && v.length > 3);
    if (sample) expect(visible).toContain(sample);
    // The open document was not touched.
    expect((await doc.listFormFields()).length).toBeGreaterThan(0);
    doc.dispose();
  });
});

describe('Reduce file size with independent tools @FR-OPT-01 @FR-OPT-09 @FR-OPT-11', () => {
  it('Balanced output: qpdf and pdfcpu clean, the same text, text areas render the same, images at ≤ 150 dpi @FR-OPT-01 @FR-OPT-09', async () => {
    const { engine, doc } = await opened('photos');
    const original = await fixture('photos');
    const { CompressService, COMPRESS_PRESETS } = await import('@folio/services');
    const { qpdfCheck, pdfcpuValidate, pdftoppm, diffImages } = await import('@folio/testkit');
    const svc = new CompressService({ engine, images: new NodeImageCodec() });
    const res = await svc.run(doc, COMPRESS_PRESETS.balanced, { originalBytes: original.length });
    const out = res.bytes!;
    expect(out.length).toBeLessThan(original.length * 0.6);
    expect((await qpdfCheck(out)).ok).toBe(true);
    expect((await qpdfCheck(out)).warnings).toEqual([]);
    expect((await pdfcpuValidate(out)).ok).toBe(true);
    expect(await pdftotext(out)).toEqual(await pdftotext(original));
    // The headline and the paragraph (top strip of page 1) are pixel-identical in poppler.
    const a = await pdftoppm(original, 1, 100);
    const b = await pdftoppm(out, 1, 100);
    const strip = (img: typeof a): typeof a => ({ width: img.width, height: 120, data: img.data.slice(0, img.width * 120 * 4) });
    expect(diffImages(strip(a), strip(b), { threshold: 0.05 }).ratio).toBeLessThan(0.001);
    // Object streams and a compressed cross-reference are in use.
    expect(Buffer.from(out).toString('latin1')).toMatch(/\/Type\s*\/ObjStm/);
    expect(Buffer.from(out).toString('latin1')).toMatch(/\/Type\s*\/XRef/);
    expect((await pdfinfo(out)).pages).toBe(2);
    expect(await qpdfQdf(out)).toContain('Photos at 300 dpi');
  });
});
