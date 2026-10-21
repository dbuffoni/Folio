import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@folio/ai';
import { NetworkError } from '@folio/core';
import type { Downloader } from '@folio/ports';
import { FakeOcrEngine } from '@folio/testkit';
import { createTestApp } from './testing.ts';

const bundled = async (code: string): Promise<Uint8Array> => new TextEncoder().encode(`bundled ${code}`);

describe('Recognise text dialog model @FR-OCR-01 @FR-OCR-02 @FR-OCR-06', () => {
  it('defaults to the UI language, remembers the last set, allows three languages in order @FR-OCR-06', async () => {
    const t = await createTestApp({ ocr: new FakeOcrEngine(), loadOcrLanguage: bundled });
    const s = await t.open('scan');
    const m = t.ocr(s);
    await m.start();
    expect(m.languages).toEqual(['eng']);
    expect(m.packs.filter((p) => p.installed).map((p) => p.code)).toEqual(['eng', 'ita']);
    expect(m.toggleLanguage('ita')).toBe(true);
    m.moveLanguage('ita', -1);
    expect(m.languages).toEqual(['ita', 'eng']);
    expect(m.toggleLanguage('eng')).toBe(true);
    expect(m.languages).toEqual(['ita']);
    // The fourth is refused (accuracy and speed degrade).
    await t.services.ocrLanguages.install('deu').catch(() => undefined);
    m.toggleLanguage('eng');
    m.toggleLanguage('deu');
    m.toggleLanguage('fra');
    expect(m.toggleLanguage('spa')).toBe(false);
    expect(m.languages.length).toBe(3);
  });

  it('runs on the current page, one undo step, the setting remembers the languages, page unchanged @FR-OCR-01 @FR-OCR-09', async () => {
    const engine = new FakeOcrEngine();
    const t = await createTestApp({ ocr: engine, loadOcrLanguage: bundled });
    const s = await t.open('scan');
    const m = t.ocr(s);
    await m.start();
    await m.refreshBanner();
    expect(m.scannedHere).toBe(true);
    m.toggleLanguage('ita');
    const before = await s.doc.render(0, { scale: 1 });
    const run = await m.execute();
    expect(run!.outcomes).toMatchObject([{ page: 0, status: 'done', engine: 'local' }]);
    expect(engine.calls).toEqual([{ languages: ['eng', 'ita'], width: expect.any(Number), height: expect.any(Number) }]);
    // 300 dpi: 612 pt → 2550 px.
    expect(engine.calls[0]!.width).toBe(2550);
    expect(t.app.settings.ocr.languages).toEqual(['eng', 'ita']);
    expect(s.dirty).toBe(true);
    expect((await s.doc.getTextLayer(0)).text).toContain('Hello recognised world');
    expect(m.scannedHere).toBe(false);
    expect(t.toastKeys()).toContain('toast.ocrDone');
    expect(await s.doc.render(0, { scale: 1 })).toEqual(before);
    expect(await s.undo()).toBe(true);
    expect((await s.doc.getTextLayer(0)).text).toBe('');
    // Next time the same languages are offered.
    await m.start();
    expect(m.languages).toEqual(['eng', 'ita']);
  });

  it('all pages with progress; a page with text is skipped; cancel keeps finished pages @FR-OCR-03', async () => {
    const engine = new FakeOcrEngine();
    const t = await createTestApp({ ocr: engine, loadOcrLanguage: bundled });
    const s = await t.open('scan');
    expect(s.pageCount).toBe(2);
    const m = t.ocr(s);
    await m.start();
    m.scope = 'all';
    const seen: number[] = [];
    t.app.changed.on(() => seen.push(m.progress));
    engine.onPage = (n) => n === 1 && m.cancel();
    const run = await m.execute();
    expect(run!.cancelled).toBe(true);
    expect(run!.outcomes.filter((o) => o.status === 'done').map((o) => o.page)).toEqual([0]);
    expect(await s.doc.hasOcrLayer(0)).toBe(true);
    expect(await s.doc.hasOcrLayer(1)).toBe(false);
    expect(m.stage).toBe('done');
    // Running again finishes the rest and skips the page that has a layer.
    engine.onPage = undefined;
    const rest = await m.execute();
    expect(rest!.outcomes.map((o) => [o.page, o.status])).toEqual([[0, 'skippedLayer'], [1, 'done']]);
    expect(Math.max(...seen)).toBeGreaterThan(0);
    const text = await t.open('text', '/docs/text.pdf');
    const m2 = t.ocr(text);
    await m2.start();
    expect((await m2.execute())!.outcomes[0]).toMatchObject({ status: 'skippedText' });
  });

  it('a language that is not installed is downloaded only after confirmation, verified, then used @FR-OCR-02', async () => {
    const data = new TextEncoder().encode('deu data '.repeat(50));
    const sha = createHash('sha256').update(data).digest('hex');
    const t = await createTestApp({ ocr: new FakeOcrEngine(), loadOcrLanguage: bundled, downloader: { download: async (r) => (r.onProgress?.(10, data.length), data) } });
    // The manifest has a fixed hash: patch the repo's pack to this test file.
    const pack = t.services.ocrLanguages.pack('deu')!;
    Object.assign(pack, { sha256: sha, size: data.length });
    const s = await t.open('scan');
    const m = t.ocr(s);
    await m.start();
    m.toggleLanguage('deu');
    t.prompts.confirmAnswers = [false];
    expect(await m.execute()).toBeNull();
    expect(t.prompts.asked).toContain('confirm:ocr.confirmDownload');
    expect(await t.services.ocrLanguages.isInstalled('deu')).toBe(false);
    t.prompts.confirmAnswers = [true];
    const run = await m.execute();
    expect(run!.outcomes[0]!.status).toBe('done');
    expect(await t.services.ocrLanguages.isInstalled('deu')).toBe(true);
    await m.remove('deu');
    expect(await t.services.ocrLanguages.isInstalled('deu')).toBe(false);
  });

  it('a download that fails or does not match is reported and nothing runs @FR-OCR-02', async () => {
    const offline: Downloader = { download: async () => { throw new NetworkError('offline'); } };
    const t = await createTestApp({ ocr: new FakeOcrEngine(), loadOcrLanguage: bundled, downloader: offline });
    const s = await t.open('scan');
    const m = t.ocr(s);
    await m.start();
    m.toggleLanguage('fra');
    expect(await m.execute()).toBeNull();
    expect(t.toastKeys()).toContain('error.network');
    expect(await s.doc.hasOcrLayer(0)).toBe(false);
  });

  it('signed documents ask first; AI needs a vision model, shows what is sent, and retries unsure pages @FR-OCR-01 @FR-OCR-10 @FR-AIF-13', async () => {
    const ai = new FakeAiProvider();
    const engine = new FakeOcrEngine();
    engine.confidence = 40;
    const t = await createTestApp({ ocr: engine, ai, loadOcrLanguage: bundled });
    const signed = await t.open('signed');
    const ms = t.ocr(signed);
    await ms.start();
    t.prompts.confirmAnswers = [false];
    expect(await ms.execute()).toBeNull();
    expect(t.prompts.asked).toContain('confirm:signed.editConfirm');

    const s = await t.open('scan', '/docs/scan2.pdf');
    const m = t.ocr(s);
    await m.start();
    expect(await m.aiAvailable()).toBe(false);
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true });
    expect(await m.aiAvailable()).toBe(true);
    await m.execute();
    expect(m.retry).toEqual([0]);
    ai.enqueueTranscription({ lines: [{ text: 'Careful handwriting here', bbox: [0.1, 0.2, 0.6, 0.24], confidence: 0.9 }] });
    t.prompts.confirmAnswers = [true];
    const again = await m.retryWithAi();
    expect(t.prompts.asked).toContain('confirm:ocr.aiPreflight');
    expect(again!.outcomes[0]).toMatchObject({ engine: 'ai', status: 'done', words: 3 });
    const text = (await s.doc.getTextLayer(0)).text;
    expect(text).toContain('Careful handwriting here');
    expect(text).not.toContain('Hello recognised');
    // A model without vision switches the AI engine off with the reason.
    await t.app.setSetting('ai', { ...t.app.settings.ai, capabilities: { baseUrl: t.app.settings.ai.baseUrl, model: t.app.settings.ai.model, vision: false, structured: 'json_schema', checkedAt: 'x' } });
    expect(await m.aiAvailable()).toBe(false);
  });
});
