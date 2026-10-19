import { describe, expect, it } from 'vitest';
import { NodeImageCodec, fixture, pdfcpuValidate, pdftotext, qpdfCheck, sharedEngine } from '@folio/testkit';
import { COMPRESS_PRESETS, CompressService, downsample, normalizeSettings } from './compress.ts';
import { openFixture } from './testing.ts';

const svc = async (): Promise<CompressService> => new CompressService({ engine: await sharedEngine(), images: new NodeImageCodec() });

describe('Reduce file size @FR-OPT-01', () => {
  it('lists images with their effective resolution; the highest use wins and masks stay out @FR-OPT-01', async () => {
    const { doc } = await openFixture('photos');
    const images = await (await svc()).images(doc);
    expect(images.length).toBe(3);
    const colour = images.find((i) => i.width === 900)!;
    expect(colour.uses).toBe(2);
    expect(Math.round(colour.dpi)).toBe(300);
    expect(colour.bytes).toBeGreaterThan(50_000);
    expect(images.find((i) => i.width === 600)!.dpi).toBeCloseTo(300, -1);
  });

  it('Balanced brings images to 150 dpi, shrinks the file and keeps text and validity @FR-OPT-01 @FR-OPT-09 @FR-OPT-07', async () => {
    const { doc } = await openFixture('photos');
    const original = await fixture('photos');
    const s = await svc();
    const res = await s.run(doc, COMPRESS_PRESETS.balanced, { originalBytes: original.length });
    expect(res.bytes).not.toBeNull();
    expect(res.after).toBeLessThan(res.before * 0.6);
    expect(res.saved).toBeGreaterThan(0.4);
    expect(res.replaced).toBe(2);
    expect(res.warnings).toEqual([]);
    const out = res.bytes!;
    await expect(out).toBeValidPdf();
    const again = (await sharedEngine().then((e) => e.open(out)))!;
    expect(again.pageCount).toBe(2);
    const imgs = await s.images(again);
    const colour = imgs.find((i) => i.uses === 2)!;
    // Drawn largest at 3 in: 150 dpi target → 450 px wide (from 900); never upsampled.
    expect(colour.width).toBe(450);
    expect(colour.dpi).toBeCloseTo(150, -1);
    expect(Math.max(...imgs.filter((i) => i.width !== 300).map((i) => i.dpi))).toBeLessThanOrEqual(158);
    // The image with transparency is exactly as before.
    expect(imgs.some((i) => i.width === 300 && i.height === 150)).toBe(true);
    // Text is untouched.
    expect((await again.getTextLayer(0)).text).toBe((await doc.getTextLayer(0)).text);
    expect((await again.listObjects(0)).filter((o) => o.type === 'text').length).toBe((await doc.listObjects(0)).filter((o) => o.type === 'text').length);
    expect((await qpdfCheck(out)).ok).toBe(true);
    expect((await pdfcpuValidate(out)).ok).toBe(true);
    expect(await pdftotext(out)).toEqual(await pdftotext(original));
  });

  it('presets are ordered: Strong is smaller than Balanced, smaller than Light; never larger than the input @FR-OPT-01', async () => {
    const { doc } = await openFixture('photos');
    const size = (await fixture('photos')).length;
    const s = await svc();
    const sizes: number[] = [];
    for (const p of ['light', 'balanced', 'strong'] as const) {
      const r = await s.run(doc, COMPRESS_PRESETS[p], { originalBytes: size });
      sizes.push(r.after);
    }
    expect(sizes[2]!).toBeLessThan(sizes[1]!);
    expect(sizes[1]!).toBeLessThan(sizes[0]!);
    expect(sizes[0]!).toBeLessThan(size);
    // Asking for more than the file has (a 600 dpi target) changes no image and saves only the lossless part.
    const same = await s.run(doc, { colorDpi: 600, grayDpi: 600, jpegQuality: 0.95 }, { originalBytes: size });
    expect(same.replaced).toBe(0);
  });

  it('the estimate is within 20 % of the real result for every preset @FR-OPT-01', async () => {
    const { doc } = await openFixture('photos');
    const size = (await fixture('photos')).length;
    const s = await svc();
    const analysis = await s.analyze(doc, size);
    expect(analysis.losslessBytes).toBeLessThanOrEqual(size);
    for (const p of ['light', 'balanced', 'strong'] as const) {
      const estimated = await s.estimate(doc, analysis, COMPRESS_PRESETS[p]);
      const real = (await s.run(doc, COMPRESS_PRESETS[p], { originalBytes: size })).after;
      expect(Math.abs(estimated - real) / real, `${p}: estimated ${estimated}, real ${real}`).toBeLessThan(0.2);
    }
  });

  it('writes nothing when the result is not smaller @FR-OPT-01', async () => {
    const { doc } = await openFixture('text');
    const size = (await fixture('text')).length;
    // A document with no images: the lossless pass cannot win against a tiny file's own overhead only if it is larger.
    const r = await (await svc()).run(doc, COMPRESS_PRESETS.strong, { originalBytes: 1 });
    expect(r.bytes).toBeNull();
    expect(r.saved).toBe(0);
    expect(size).toBeGreaterThan(1);
  });

  it('signed files can only be compressed as a copy; encrypted ones warn @FR-OPT-11', async () => {
    const s = await svc();
    const signed = await openFixture('signed');
    expect(s.canReplace((await signed.doc.getMeta()))).toBe(false);
    expect(s.canReplace({ hasSignatures: false })).toBe(true);
    const r = await s.run(signed.doc, COMPRESS_PRESETS.balanced, { originalBytes: 10 ** 7 });
    expect(r.warnings).toEqual(['signed']);
    // The signed original is not modified by the run.
    expect((await signed.doc.getMeta()).hasSignatures).toBe(true);
    const enc = await openFixture('encrypted', 'open-sesame');
    const e = await s.run(enc.doc, COMPRESS_PRESETS.balanced, { originalBytes: 10 ** 7, password: 'open-sesame' });
    expect(e.warnings).toContain('encrypted');
    // The copy keeps the password.
    await expect((await sharedEngine()).open(e.bytes!)).rejects.toMatchObject({ code: 'passwordRequired' });
    expect(s.copyName('Report.PDF')).toBe('Report-compressed.pdf');
    expect(s.copyName('notes')).toBe('notes-compressed.pdf');
  });

  it('can be cancelled between images and settings are clamped @FR-OPT-01', async () => {
    const { doc } = await openFixture('photos');
    const ac = new AbortController();
    ac.abort();
    await expect((await svc()).run(doc, COMPRESS_PRESETS.light, { originalBytes: 10 ** 6, signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(normalizeSettings({ colorDpi: 5000, grayDpi: 1, jpegQuality: 2 })).toEqual({ colorDpi: 600, grayDpi: 36, jpegQuality: 0.95 });
  });

  it('downsample averages areas and never upsamples @FR-OPT-01', () => {
    const src = { width: 4, height: 2, data: new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 40, 40, 40, 255, 0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 40, 40, 40, 255]) };
    const half = downsample(src, 2, 1);
    expect([...half.data]).toEqual([50, 50, 50, 255, 120, 120, 120, 255]);
    expect(downsample(src, 40, 20)).toMatchObject({ width: 4, height: 2 });
  });

  it('two different images with the same size and stored length are not taken for one @FR-OPT-01', async () => {
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    // Uncompressed images: the stored length depends on the size only, so it is equal for both.
    const raw = (seed: number): Uint8Array => Uint8Array.from({ length: 200 * 200 * 3 }, (_, i) => ((i * seed) >> 3) & 255);
    const names = [1, 7].map((seed, k) => {
      const ref = pdf.context.register(
        pdf.context.stream(raw(seed), { Type: 'XObject', Subtype: 'Image', Width: 200, Height: 200, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }),
      );
      return page.node.newXObject(`Im${k}`, ref);
    });
    const ops = names.map((n, k) => `q 144 0 0 144 ${72 + k * 200} 400 cm ${n.toString()} Do Q`).join('\n');
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(ops)));
    const engine = await sharedEngine();
    const doc = await engine.open(await pdf.save());
    const s = await svc();
    const listed = await s.images(doc);
    expect(listed.length).toBe(2);
    const res = await s.run(doc, COMPRESS_PRESETS.balanced, { originalBytes: 10 ** 7 });
    const out = await engine.open(res.bytes!);
    const objs = (await out.listObjects(0)).filter((o) => o.type === 'image');
    const [a, b] = await Promise.all(objs.map((o) => out.getImage(0, o.id)));
    // Each place keeps its own picture.
    expect(Buffer.from(a!.data).equals(Buffer.from(b!.data))).toBe(false);
  });
});
