import { describe, expect, it } from 'vitest';
import { CancelledError } from '@folio/core';
import { NodeImageCodec, OCR_TEXT, fixture, sharedEngine } from '@folio/testkit';
import { TesseractOcrEngine } from './index.ts';
import { bundledLanguageData, createNodeOcrEngine } from './node.ts';

const codec = new NodeImageCodec();
const encode = (img: { width: number; height: number; data: Uint8ClampedArray }) => codec.encode(img, 'png');

/** Word error rate: edit distance over words / words in the reference. */
export function wer(reference: string, hypothesis: string): number {
  const norm = (s: string): string[] => s.toLowerCase().normalize('NFC').replace(/[.,;:!?]/g, '').split(/\s+/).filter(Boolean);
  const r = norm(reference);
  const h = norm(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length]![h.length]! / r.length;
}

const render = async (scale = 4) => {
  const engine = await sharedEngine();
  const doc = await engine.open(await fixture('multilingual'));
  return doc.render(0, { scale });
};

describe('Tesseract OcrEngine @FR-OCR-01 @FR-OCR-03', () => {
  it('recognises English text from pixels with a low word error rate and boxes inside the page @FR-OCR-01', async () => {
    const ocr = createNodeOcrEngine(encode);
    const img = await render();
    const res = await ocr.recognize(img, { languages: ['eng'] });
    expect(res.width).toBe(img.width);
    expect(res.lines.length).toBeGreaterThan(5);
    expect(res.confidence).toBeGreaterThan(60);
    const text = res.lines.map((l) => l.text).join(' ');
    // The first paragraph is English: judged on its own words.
    const english = OCR_TEXT.en.split(' ').length;
    expect(wer(OCR_TEXT.en, text.split(' ').slice(0, english + 2).join(' '))).toBeLessThan(0.15);
    for (const l of res.lines) {
      expect(l.x0).toBeGreaterThanOrEqual(0);
      expect(l.x1).toBeLessThanOrEqual(img.width);
      expect(l.y1).toBeLessThanOrEqual(img.height);
      for (const w of l.words) expect(w.x1).toBeGreaterThan(w.x0);
    }
    await ocr.dispose();
  }, 120_000);

  it('eng+ita does better than eng alone on the Italian paragraph and keeps the English part @FR-OCR-06', async () => {
    const ocr = createNodeOcrEngine(encode);
    const img = await render();
    const italianWords = OCR_TEXT.it.split(' ').length;
    const tail = (r: { lines: Array<{ text: string }> }): string => r.lines.map((l) => l.text).join(' ').split(' ').slice(-(italianWords + 2)).join(' ');
    const single = await ocr.recognize(img, { languages: ['eng'] });
    const both = await ocr.recognize(img, { languages: ['eng', 'ita'] });
    const werSingle = wer(OCR_TEXT.it, tail(single));
    const werBoth = wer(OCR_TEXT.it, tail(both));
    expect(werBoth).toBeLessThanOrEqual(werSingle);
    expect(werBoth).toBeLessThan(0.2);
    const head = (r: { lines: Array<{ text: string }> }): string => r.lines.map((l) => l.text).join(' ').split(' ').slice(0, OCR_TEXT.en.split(' ').length + 2).join(' ');
    expect(wer(OCR_TEXT.en, head(both))).toBeLessThan(0.2);
    // Accented words survive: they are what the second language is for.
    expect(both.lines.map((l) => l.text).join(' ')).toMatch(/perch[ée]/);
    await ocr.dispose();
  }, 180_000);

  it('limits languages to three, rejects odd codes and large images, and can be cancelled @FR-OCR-06', async () => {
    const ocr = new TesseractOcrEngine({ languageData: bundledLanguageData, encode, stageLanguage: async () => undefined, maxSide: 100 });
    const img = { width: 50, height: 50, data: new Uint8ClampedArray(50 * 50 * 4).fill(255) };
    await expect(ocr.recognize(img, { languages: [] })).rejects.toMatchObject({ code: 'invalidArgument' });
    await expect(ocr.recognize(img, { languages: ['eng', 'ita', 'deu', 'fra'] })).rejects.toMatchObject({ code: 'invalidArgument' });
    await expect(ocr.recognize(img, { languages: ['../etc'] })).rejects.toMatchObject({ code: 'invalidArgument' });
    await expect(ocr.recognize({ ...img, width: 500 }, { languages: ['eng'] })).rejects.toMatchObject({ code: 'limitExceeded' });
    const ac = new AbortController();
    ac.abort();
    await expect(ocr.recognize(img, { languages: ['eng'], signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    await ocr.dispose();
  });

  it('a blank page gives no lines and zero confidence @FR-OCR-01', async () => {
    const ocr = createNodeOcrEngine(encode);
    const res = await ocr.recognize({ width: 300, height: 300, data: new Uint8ClampedArray(300 * 300 * 4).fill(255) }, { languages: ['eng'] });
    expect(res).toMatchObject({ lines: [], confidence: 0 });
    await ocr.dispose();
  }, 60_000);
});
