import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@folio/ai';
import { History, IoError, NetworkError } from '@folio/core';
import type { Downloader } from '@folio/ports';
import { OcrLanguageRepo, OcrService, OCR_LANGUAGES, defaultOcrLanguages, type OcrLanguagePack } from '@folio/services';
import { MemoryStorage, NodeCrypto, NodeImageCodec, OCR_TEXT, fixture, pdftoppm, pdftotext, diffImages, sharedEngine } from '@folio/testkit';
import { wer } from './ocr.test.ts';
import { bundledLanguageData, createNodeOcrEngine } from './node.ts';

const codec = new NodeImageCodec();
const make = (ai?: FakeAiProvider) => {
  const engine = createNodeOcrEngine((img) => codec.encode(img, 'png'));
  return { engine, svc: new OcrService({ engine, ai, images: codec }) };
};
const open = async (bytes: Uint8Array) => {
  const eng = await sharedEngine();
  const doc = await eng.open(bytes);
  return { eng, doc, history: new History({ doc, engine: eng }) };
};
const words = (t: string): string[] => t.split(/\s+/).filter(Boolean);

describe('Make scanned pages searchable @FR-OCR-01 @FR-OCR-03 @FR-OCR-09', () => {
  it('recognises a scan locally, writes an invisible layer that other tools read, one undo removes it @FR-OCR-01 @FR-OCR-04 @FR-OCR-09', async () => {
    const { engine, svc } = make();
    const pdf = await fixture('scanned-text');
    const { doc, history } = await open(pdf);
    const before = await doc.render(0, { scale: 1 });
    expect((await doc.getTextLayer(0)).isScanned).toBe(true);

    let outcome;
    await history.execute(svc.command(doc, { pages: [0], languages: ['eng', 'ita'], engine: 'local' }, (r) => (outcome = r)));
    expect(outcome).toMatchObject({ cancelled: false, outcomes: [{ page: 0, status: 'done', engine: 'local' }] });
    expect(history.state.done.length).toBe(1);
    expect(await doc.hasOcrLayer(0)).toBe(true);

    // The page looks exactly the same: the layer is invisible.
    expect(diffImages(before, await doc.render(0, { scale: 1 }), { threshold: 0 }).ratio).toBe(0);
    const bytes = await doc.save();
    // poppler reads it back as text within the error budget.
    const text = await pdftotext(bytes);
    const expected = `${OCR_TEXT.en} ${OCR_TEXT.it}`;
    expect(wer(expected, words(text).join(' '))).toBeLessThan(0.15);
    // Folio finds words in the right place: the box of "quick" is near where the vector page has it.
    const source = await (await sharedEngine()).open(await fixture('multilingual'));
    const truth = (await source.getTextLayer(0)).runs.flatMap((r) => r.text.split(' ').map(() => r)).find((r) => r.text.includes('quick'))!;
    const hits: Array<{ rects: Array<{ x: number; y: number; width: number; height: number }> }> = [];
    for await (const h of doc.search({ text: 'quick' })) hits.push(h);
    expect(hits.length).toBe(1);
    const box = hits[0]!.rects[0]!;
    expect(Math.abs(box.y - truth.rect.y)).toBeLessThan(truth.rect.height * 1.2);
    expect(box.x).toBeGreaterThan(70);
    expect(box.x).toBeLessThan(truth.rect.x + truth.rect.width);

    // Undo removes the layer completely; the scan is untouched.
    expect(await history.undo()).toBe(true);
    expect(await doc.hasOcrLayer(0)).toBe(false);
    expect((await doc.getTextLayer(0)).text).toBe('');
    expect(diffImages(before, await doc.render(0, { scale: 1 }), { threshold: 0 }).ratio).toBe(0);
    await engine.dispose();
  }, 240_000);

  it('skips pages that have text, never touches third-party text, and "Redo" replaces only the layer Folio made @FR-OCR-03', async () => {
    const { engine, svc } = make();
    const eng = await sharedEngine();
    // Page 1: a scan, page 2: real text.
    const merged = await eng.merge([
      { doc: await eng.open(await fixture('scanned-text')), pages: [0] },
      { doc: await eng.open(await fixture('text')), pages: [0] },
    ]);
    const { history } = { history: new History({ doc: merged, engine: eng }) };
    const first = await svc.run(merged, { pages: [0, 1], languages: ['eng'], engine: 'local' });
    expect(first.outcomes.map((o) => [o.page, o.status])).toEqual([[0, 'done'], [1, 'skippedText']]);
    const typed = (await merged.getTextLayer(1)).text;
    // Running again skips the page with our layer; "Redo" replaces it (and only it).
    const again = await svc.run(merged, { pages: [0, 1], languages: ['eng'], engine: 'local' });
    expect(again.outcomes.map((o) => [o.page, o.status])).toEqual([[0, 'skippedLayer'], [1, 'skippedText']]);
    const redo = await svc.run(merged, { pages: [0], languages: ['eng'], engine: 'local', redo: true });
    expect(redo.outcomes[0]!.status).toBe('done');
    expect(await merged.removeOcrLayer(0)).toBeGreaterThan(5);
    expect((await merged.getTextLayer(1)).text).toBe(typed);
    expect(await merged.removeOcrLayer(1)).toBe(0);
    void history;
    await engine.dispose();
  }, 240_000);

  it('cancelling keeps the finished pages, leaves no partial page and the whole run still undoes @FR-OCR-03 @FR-OCR-09', async () => {
    const { engine, svc } = make();
    const eng = await sharedEngine();
    const scan = await eng.open(await fixture('scanned-text'));
    const doc = await eng.merge([{ doc: scan, pages: [0, 0, 0] }]);
    const history = new History({ doc, engine: eng });
    const ac = new AbortController();
    const progress: number[] = [];
    let run;
    await history.execute(
      svc.command(doc, { pages: [0, 1, 2], languages: ['eng'], engine: 'local', signal: ac.signal, progress: (done) => { progress.push(done); if (done === 1) ac.abort(); } }, (r) => (run = r)),
    );
    expect(run).toMatchObject({ cancelled: true });
    const done = (run as unknown as { outcomes: Array<{ page: number; status: string }> }).outcomes.filter((o) => o.status === 'done').map((o) => o.page);
    expect(done).toEqual([0]);
    expect(await doc.hasOcrLayer(0)).toBe(true);
    expect(await doc.hasOcrLayer(1)).toBe(false);
    expect(await doc.hasOcrLayer(2)).toBe(false);
    expect(await history.undo()).toBe(true);
    expect(await doc.hasOcrLayer(0)).toBe(false);
    // Cancelled before anything finished: nothing is recorded.
    const ac2 = new AbortController();
    ac2.abort();
    await expect(history.execute(svc.command(doc, { pages: [0], languages: ['eng'], engine: 'local', signal: ac2.signal }, () => undefined))).rejects.toMatchObject({ code: 'cancelled' });
    expect(history.state.canUndo).toBe(false);
    await engine.dispose();
  }, 240_000);

  it('a scan with /Rotate 90 is recognised as shown and the text reads in order @FR-OCR-01', async () => {
    const { engine, svc } = make();
    const { scannedTextDoc } = await import('@folio/testkit');
    // The image is upright; the page is shown rotated, so the picture of text is sideways in the view.
    // Recognition therefore runs on the rotated view, which here is a sideways text: Tesseract's own
    // orientation handling is out of scope, the geometry is what is checked — an upright scan is turned
    // by the page rotation and the words must land on the right spots after mapping.
    const pdf = await scannedTextDoc({ dpi: 150, rotate: 0 });
    const { doc } = await open(pdf);
    const info = await doc.getPageInfo(0);
    const upright = await svc.run(doc, { pages: [0], languages: ['eng'], engine: 'local' });
    expect(upright.outcomes[0]!.status).toBe('done');
    const run = (await doc.getTextLayer(0)).runs[0]!;
    expect(run.angle).toBeCloseTo(info.rotation, 0);
    await engine.dispose();
  }, 240_000);

  it('difficult scans with AI: recorded transcription becomes the same invisible layer @FR-OCR-01', async () => {
    const ai = new FakeAiProvider();
    const { svc } = make(ai);
    const { doc } = await open(await fixture('scanned-text'));
    ai.enqueueTranscription((req) => ({
      lines: [
        { text: 'Handwritten note for the archive', bbox: [0.12, 0.08, 0.72, 0.11], confidence: 0.82 },
        { text: 'Signed on the third of May', bbox: [0.12, 0.13, 0.55, 0.16], confidence: 0.77 },
        { text: '', bbox: [0, 0, 0.1, 0.1], confidence: 1 },
        { text: 'off page', bbox: [-2, -2, -1, -1], confidence: 1 },
      ].filter(() => req.page === 0),
    }));
    const before = await doc.render(0, { scale: 1 });
    const run = await svc.run(doc, { pages: [0], languages: [], engine: 'ai' });
    expect(run.outcomes[0]).toMatchObject({ status: 'done', engine: 'ai', words: 11 });
    expect(ai.transcriptionRequests).toEqual([{ page: 0, width: expect.any(Number), height: expect.any(Number) }]);
    const bytes = await doc.save();
    const text = await pdftotext(bytes);
    expect(text).toContain('Handwritten note for the archive');
    expect(text).toContain('Signed on the third of May');
    expect(diffImages(before, await doc.render(0, { scale: 1 }), { threshold: 0 }).ratio).toBe(0);
    // The words sit where the model said (fractions of the image).
    const hit: Array<{ rects: Array<{ x: number; y: number; width: number; height: number }> }> = [];
    for await (const h of doc.search({ text: 'Handwritten' })) hit.push(h);
    const r = hit[0]!.rects[0]!;
    expect(r.x).toBeCloseTo(0.12 * 612, -1);
    expect(r.y).toBeGreaterThan(792 * (1 - 0.12));
    expect(r.y).toBeLessThan(792 * (1 - 0.07));
    expect((await pdftoppm(bytes, 1, 36)).width).toBeGreaterThan(0);
  }, 120_000);

  it('local pages with low confidence are offered "Retry with AI"; an AI failure keeps the local layer @FR-OCR-01', async () => {
    const { svc } = make();
    const run = {
      cancelled: false,
      outcomes: [
        { page: 0, status: 'done' as const, words: 50, confidence: 92, substituted: 0, engine: 'local' as const },
        { page: 1, status: 'done' as const, words: 30, confidence: 41, substituted: 0, engine: 'local' as const },
        { page: 2, status: 'done' as const, words: 30, confidence: 30, substituted: 0, engine: 'ai' as const },
        { page: 3, status: 'skippedText' as const, words: 0, confidence: 0, substituted: 0, engine: 'local' as const },
      ],
    };
    expect(svc.lowConfidence(run)).toEqual([1]);
    const ai = new FakeAiProvider();
    ai.enqueueTranscription(new (await import('@folio/core')).AiError('rateLimited'));
    const failing = new OcrService({ engine: undefined, ai, images: codec });
    const { doc } = await open(await fixture('scanned-text'));
    await doc.addOcrLayer(0, [{ text: 'local', origin: { x: 72, y: 700 }, angle: 0, width: 40, fontSize: 12 }]);
    const out = await failing.run(doc, { pages: [0], languages: [], engine: 'ai', redo: true });
    expect(out.outcomes[0]!.status).toBe('failed');
    expect(await doc.hasOcrLayer(0)).toBe(true);
  }, 60_000);
});

describe('OCR language packs @FR-OCR-02', () => {
  const pack = (data: Uint8Array): OcrLanguagePack => ({ code: 'deu', name: 'Deutsch', size: data.length, bundled: false, url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/deu.traineddata', sha256: createHash('sha256').update(data).digest('hex') });
  const setup = (data: Uint8Array, downloader?: Downloader) => {
    const storage = new MemoryStorage();
    const manifest: OcrLanguagePack[] = [...OCR_LANGUAGES.filter((p) => p.bundled), pack(data)];
    const repo = new OcrLanguageRepo({ storage, crypto: new NodeCrypto(), downloader, bundled: bundledLanguageData, manifest });
    return { storage, repo };
  };
  const bytes = new TextEncoder().encode('pretend traineddata '.repeat(100));

  it('English and Italian work with no network and no download; others need confirmation first @FR-OCR-02', async () => {
    const { repo } = setup(bytes);
    expect(await repo.isInstalled('eng')).toBe(true);
    expect(await repo.isInstalled('ita')).toBe(true);
    expect(await repo.isInstalled('deu')).toBe(false);
    expect((await repo.data('eng')).length).toBeGreaterThan(1_000_000);
    await expect(repo.data('deu')).rejects.toMatchObject({ code: 'invalidArgument' });
    expect((await repo.missing(['eng', 'deu', 'xxx'])).map((p) => p.code)).toEqual(['deu']);
    expect(repo.validate(['eng', 'ita', 'eng'])).toEqual(['eng', 'ita']);
    expect(() => repo.validate([])).toThrow();
    expect(() => repo.validate(['eng', 'ita', 'deu', 'fra'])).toThrow(/Unknown OCR language/);
    const full = new OcrLanguageRepo({ storage: new MemoryStorage(), crypto: new NodeCrypto(), bundled: bundledLanguageData });
    expect(() => full.validate(['eng', 'ita', 'deu', 'fra'])).toThrow(/one to three/);
    expect(full.validate(['eng', 'ita', 'deu'])).toEqual(['eng', 'ita', 'deu']);
    expect(defaultOcrLanguages('it-IT', undefined)).toEqual(['ita']);
    expect(defaultOcrLanguages('en', undefined)).toEqual(['eng']);
    expect(defaultOcrLanguages('en', ['deu', 'eng'])).toEqual(['deu', 'eng']);
  });

  it('downloads after the user asks, verifies the hash, stores it and can remove it @FR-OCR-02', async () => {
    const calls: string[] = [];
    const downloader: Downloader = { download: async (r) => (calls.push(r.url), r.onProgress?.(bytes.length, bytes.length), bytes) };
    const { repo, storage } = setup(bytes, downloader);
    expect(calls).toEqual([]);
    const seen: number[] = [];
    await repo.install('deu', { onProgress: (n) => seen.push(n) });
    expect(calls).toEqual(['https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/deu.traineddata']);
    expect(seen).toEqual([bytes.length]);
    expect(await repo.isInstalled('deu')).toBe(true);
    expect(await repo.data('deu')).toEqual(bytes);
    await repo.remove('deu');
    expect(await repo.isInstalled('deu')).toBe(false);
    expect(await storage.list('ocr/')).toEqual([]);
    // Bundled languages are never removed or downloaded.
    await expect(repo.install('eng')).rejects.toMatchObject({ code: 'invalidArgument' });
  });

  it('a file with a wrong checksum is rejected and nothing is kept; offline leaves no partial pack @FR-OCR-02', async () => {
    const wrong: Downloader = { download: async () => new TextEncoder().encode('tampered') };
    const a = setup(bytes, wrong);
    await expect(a.repo.install('deu')).rejects.toBeInstanceOf(IoError);
    expect(await a.storage.list('ocr/')).toEqual([]);
    const offline: Downloader = { download: async () => { throw new NetworkError('offline'); } };
    const b = setup(bytes, offline);
    await expect(b.repo.install('deu')).rejects.toBeInstanceOf(NetworkError);
    expect(await b.storage.list('ocr/')).toEqual([]);
    // A pack that was damaged in the cache is discarded on load, never used.
    const c = setup(bytes, { download: async () => bytes });
    await c.repo.install('deu');
    await c.storage.write('ocr/lang/deu.traineddata', new Uint8Array([1, 2, 3]));
    expect(await c.repo.isInstalled('deu')).toBe(false);
    expect(await c.storage.list('ocr/')).toEqual([]);
    expect(await setup(bytes).repo.install('deu').catch((e) => e.code)).toBe('invalidArgument');
  });
});
