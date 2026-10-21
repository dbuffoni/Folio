import { describe, expect, it } from 'vitest';
import { CancelledError, InvalidArgumentError } from '@folio/core';
import type { OcrPageResult, PageInfo } from '@folio/ports';
import { FakeOcrEngine, fixture, ocrLinesForScannedForm, scannedFormDoc, sharedEngine } from '@folio/testkit';
import { FieldDetectionService } from './field-detection.ts';
import { detectAreas } from './form.ts';
import { isLeaderWord, ocrTextLayer } from './scan-ocr.ts';

const INFO: PageInfo = { size: { width: 612, height: 792 }, rotation: 0, mediaBox: { x: 0, y: 0, width: 612, height: 792 }, cropBox: { x: 0, y: 0, width: 612, height: 792 } };

/** A recognised page of 1224 × 1584 px (2 px per point): lines of words at given pixel boxes. */
function recognised(lines: Array<{ y0: number; y1: number; words: Array<{ text: string; x0: number; x1: number }> }>): OcrPageResult {
  return {
    width: 1224,
    height: 1584,
    confidence: 90,
    lines: lines.map((l) => ({
      text: l.words.map((w) => w.text).join(' '),
      words: l.words.map((w) => ({ ...w, y0: l.y0, y1: l.y1, confidence: 90 })),
      x0: l.words[0]!.x0,
      x1: l.words[l.words.length - 1]!.x1,
      y0: l.y0,
      y1: l.y1,
      confidence: 90,
    })),
  };
}

describe('OCR output as a text layer @FR-FRM-15', () => {
  it('recognises words made of underscores, dots and dashes as leaders', () => {
    for (const w of ['____', '.....', '………', '-----', '——————']) expect(isLeaderWord(w), w).toBe(true);
    for (const w of ['..', 'a_b', 'name', '-', '1.5']) expect(isLeaderWord(w), w).toBe(false);
  });

  it('turns an OCR word of underscores or dots into a field named by the words before it', () => {
    const layer = ocrTextLayer(
      recognised([
        { y0: 400, y1: 424, words: [{ text: 'Surname:', x0: 144, x1: 300 }, { text: '_________________', x0: 310, x1: 800 }] },
        { y0: 500, y1: 524, words: [{ text: 'Telephone', x0: 144, x1: 330 }, { text: '..................', x0: 340, x1: 800 }] },
        { y0: 600, y1: 624, words: [{ text: 'Notes', x0: 144, x1: 250 }, { text: '----------------', x0: 260, x1: 800 }] },
      ]),
      INFO,
      0,
    );
    expect(layer.lines.map((l) => l.text)).toEqual(['Surname: _________________', 'Telephone ..................', 'Notes ________________']);
    const found = detectAreas(0, [], layer);
    expect(found.map((a) => [a.label, a.kind, a.leader])).toEqual([['Surname', 'text', true], ['Telephone', 'text', true], ['Notes', 'text', true]]);
    // Position: from the first underscore to the last, in points (2 px per point).
    expect(found[0]!.rect.x).toBeCloseTo(155, 0);
    expect(found[0]!.rect.width).toBeCloseTo(245, 0);
  });

  it('puts a printed line into its text line, cuts what OCR read on it and keeps the label word it touched', () => {
    const layer = ocrTextLayer(
      recognised([
        // "Firma......" read as one word and junk where the dots are: both lie on the line.
        { y0: 400, y1: 424, words: [{ text: 'Firma...', x0: 144, x1: 330 }, { text: 'ccoeevvienn', x0: 340, x1: 700 }, { text: '(data)', x0: 720, x1: 800 }] },
      ]),
      INFO,
      0,
      [{ x0: 300, x1: 700, y: 420 }],
      2,
    );
    expect(layer.lines).toHaveLength(1);
    expect(layer.lines[0]!.text).toMatch(/^Firma _{4,} \(data\)$/);
    expect(detectAreas(0, [], layer).map((a) => a.label)).toEqual(['Firma']);
  });

  it('a printed line with no text on its row becomes a line of its own, labelled by the words above it', () => {
    const layer = ocrTextLayer(
      recognised([{ y0: 360, y1: 384, words: [{ text: 'Home', x0: 144, x1: 260 }, { text: 'address', x0: 270, x1: 400 }] }]),
      INFO,
      0,
      [{ x0: 144, x1: 700, y: 420 }],
      2,
    );
    expect(layer.lines).toHaveLength(2);
    const found = detectAreas(0, [], layer);
    expect(found).toHaveLength(1);
    expect(found[0]!.label).toBe('Home address');
    // The text stands on the printed line, which is at pixel row 420, that is 792 − 420 / 2 points up the page.
    expect(found[0]!.lineY).toBeCloseTo(792 - 420 / 2, 0);
  });
});

/** The scanned form of the testkit (7 boxes, no text) with the labels a reader would see next to them. */
async function labelledScan() {
  const { pdf, areas } = await scannedFormDoc();
  return { pdf, areas, lines: ocrLinesForScannedForm(areas) };
}

describe('Detect fields on a picture-only page reads it with OCR @FR-FRM-15', () => {
  it('proposes every box with its label, at the place the box is on the page', async () => {
    const { pdf, areas, lines } = await labelledScan();
    const engine = await sharedEngine();
    const doc = await engine.open(pdf);
    const ocr = new FakeOcrEngine(lines);
    const out = await new FieldDetectionService({ ocr }).detect(doc, [0], { useAi: false, ocr: { languages: ['eng'] } });
    expect(out.notice).toBe('scanOcr');
    expect(out.usedAi).toBe(false);
    expect(out.proposals).toHaveLength(7);
    for (const truth of areas) {
      const p = out.proposals.find((x) => x.label === truth.label);
      expect(p, truth.label).toBeDefined();
      expect(p!.type).toBe(truth.kind);
      expect(p!.confidence).toBeCloseTo(0.8);
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(p!.rect[key], `${truth.label} ${key}`).toBeCloseTo(truth.rect[key], -0.5);
    }
    expect(ocr.calls).toEqual([{ languages: ['eng'], width: expect.any(Number), height: expect.any(Number) }]);
    doc.dispose();
  });

  it('reads a page once per session: a second detection does not run OCR again @FR-FRM-15', async () => {
    const { pdf, lines } = await labelledScan();
    const doc = await (await sharedEngine()).open(pdf);
    const ocr = new FakeOcrEngine(lines);
    const svc = new FieldDetectionService({ ocr });
    const progress: Array<[number, number]> = [];
    await svc.detect(doc, [0], { useAi: false, ocr: { languages: ['eng'] }, progress: (d, t) => progress.push([d, t]) });
    const again = await svc.detect(doc, [0], { useAi: false, ocr: { languages: ['eng'] } });
    expect(ocr.calls).toHaveLength(1);
    expect(again.proposals).toHaveLength(7);
    expect(progress[0]).toEqual([0, 1]);
    expect(progress[progress.length - 1]).toEqual([1, 1]);
    // A page of another document is read again; forgetting the document does too.
    svc.forgetScans(doc);
    await svc.detect(doc, [0], { useAi: false, ocr: { languages: ['eng'] } });
    expect(ocr.calls).toHaveLength(2);
    doc.dispose();
  });

  it('does not run OCR on a page that has text of its own @FR-FRM-15', async () => {
    const doc = await (await sharedEngine()).open(await fixture('dotted-form'));
    const ocr = new FakeOcrEngine();
    const out = await new FieldDetectionService({ ocr }).detect(doc, [0], { useAi: false, ocr: { languages: ['eng'] } });
    expect(ocr.calls).toEqual([]);
    expect(out.proposals.length).toBe(3);
    doc.dispose();
  });

  it('does not read a page again that already carries Folio\'s invisible text layer @FR-FRM-15', async () => {
    const { pdf, lines } = await labelledScan();
    const engine = await sharedEngine();
    const doc = await engine.open(pdf);
    // The layer a previous "Make scanned pages searchable" wrote: the label of the first box, in user space.
    await doc.addOcrLayer(0, [{ text: 'First name', origin: { x: 72, y: 704 }, angle: 0, width: 60, fontSize: 10 }]);
    const ocr = new FakeOcrEngine(lines);
    const out = await new FieldDetectionService({ ocr }).detect(doc, [0], { useAi: false, ocr: { languages: ['eng'] } });
    expect(ocr.calls).toEqual([]);
    expect(out.proposals.length).toBeGreaterThanOrEqual(7);
    expect(out.proposals.find((p) => p.label === 'First name')).toBeDefined();
    doc.dispose();
  });

  it('can be cancelled, and without a usable language falls back to the shapes alone @FR-FRM-15', async () => {
    const { pdf, lines } = await labelledScan();
    const doc = await (await sharedEngine()).open(pdf);
    const stop = new AbortController();
    stop.abort();
    await expect(new FieldDetectionService({ ocr: new FakeOcrEngine(lines) }).detect(doc, [0], { useAi: false, signal: stop.signal, ocr: { languages: ['eng'], signal: stop.signal } })).rejects.toBeInstanceOf(CancelledError);
    const broken = new FakeOcrEngine(lines);
    broken.failWith = new InvalidArgumentError('missing', { reason: 'ocrLanguageMissing' });
    const out = await new FieldDetectionService({ ocr: broken }).detect(doc, [0], { useAi: false, ocr: { languages: ['xxx'] } });
    expect(out.notice).toBe('scanLocal');
    expect(out.proposals).toHaveLength(7);
    expect(out.proposals.every((p) => p.label === undefined && p.confidence < 0.7)).toBe(true);
    doc.dispose();
  });

  it('never goes to the AI by itself; "Improve with AI" adds to what OCR found @FR-FRM-15', async () => {
    const { FakeAiProvider } = await import('@folio/ai');
    const { NodeImageCodec } = await import('@folio/testkit');
    const { pdf, lines } = await labelledScan();
    const doc = await (await sharedEngine()).open(pdf);
    const ai = new FakeAiProvider();
    const svc = new FieldDetectionService({ ai, images: new NodeImageCodec(), ocr: new FakeOcrEngine(lines) });
    const local = await svc.detect(doc, [0], { useAi: true, ocr: { languages: ['eng'] } });
    expect(ai.requests).toHaveLength(0);
    expect(local.usedAi).toBe(false);
    expect(local.proposals).toHaveLength(7);
    ai.enqueue({
      fields: [],
      newAreas: [{ page: 0, bbox: [0.1, 0.05, 0.5, 0.07], label: 'Referenced by AI', fieldType: 'text', profileKey: null, transform: 'none', confidence: 0.9 }],
    });
    const improved = await svc.detect(doc, [0], { useAi: true, forceAi: true, ocr: { languages: ['eng'] } });
    expect(ai.requests).toHaveLength(1);
    expect(improved.usedAi).toBe(true);
    expect(improved.proposals).toHaveLength(8);
    expect(improved.proposals.filter((p) => p.source === 'ai')).toHaveLength(1);
    doc.dispose();
  });
});
