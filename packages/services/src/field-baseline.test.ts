import { describe, expect, it } from 'vitest';
import { TEXT_BASELINE_OFFSET, anchoredRect, detectedFontSize, textBaseline } from '@folio/core';
import type { PdfDocument, Rect } from '@folio/ports';
import { fixture } from '@folio/testkit';
import { FieldDetectionService, FormAuthoringService } from './index.ts';
import { openFixture } from './testing.ts';

const svc = new FormAuthoringService();

/** Baseline of the lowest flat-bottomed ink ("H") inside `box`, in PDF user space, read from a render. */
async function inkBaseline(doc: PdfDocument, box: Rect): Promise<number> {
  const scale = 8;
  const img = await doc.render(0, { scale });
  const pageH = (await doc.getPageInfo(0)).size.height;
  let low = -1;
  for (let y = Math.floor((pageH - box.y - box.height) * scale); y < Math.ceil((pageH - box.y) * scale); y++)
    for (let x = Math.floor(box.x * scale); x < Math.ceil((box.x + box.width) * scale); x++) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3]! > 16 && img.data[o]! < 100 && img.data[o + 1]! < 100) low = Math.max(low, y);
    }
  return pageH - (low + 1) / scale;
}

describe('Text above printed lines: one rule for fields and preview @FR-FRM-15 @FR-AIF-14', () => {
  it.each([0, 2, 5, 9])('a field made from a line puts the baseline %s px above it, for any line height', async (offset) => {
    for (const height of [14, 16, 24]) {
      const { doc, history } = await openFixture('text');
      const lineY = 300;
      const area: Rect = { x: 300, y: lineY, width: 120, height };
      const fontSize = detectedFontSize(height);
      const rect = anchoredRect(area, lineY, fontSize, offset);
      await history.execute(svc.create([svc.spec('text', 'T', 0, rect, { value: 'HHHH', fontSize })], 'cmd.createFields'));
      const baseline = await inkBaseline(doc, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      expect(baseline).toBeCloseTo(lineY + offset, 0);
      expect(Math.abs(baseline - textBaseline(area, lineY, fontSize, offset))).toBeLessThan(0.3);
      doc.dispose();
    }
  });
  it('boxes and cells keep their rectangle and centre the text', () => {
    const box: Rect = { x: 10, y: 10, width: 100, height: 20 };
    expect(anchoredRect(box, undefined, 11, 7)).toEqual(box);
  });
  it('ruled lines and dotted leaders carry the height of the printed line; the offset is the only knob', async () => {
    const { engine } = await openFixture('text');
    const doc = await engine.open(await fixture('dotted-form'));
    const found = await new FieldDetectionService({}).detectLocal(doc, 0);
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) {
      expect(p.lineY).toBeDefined();
      expect(p.lineY!).toBeGreaterThanOrEqual(p.rect.y - 1);
      expect(p.lineY!).toBeLessThanOrEqual(p.rect.y + p.rect.height);
      const fs = detectedFontSize(p.rect.height);
      const low = textBaseline(p.rect, p.lineY, fs, 0);
      const high = textBaseline(p.rect, p.lineY, fs, 6);
      expect(high - low).toBeCloseTo(6, 5);
      expect(low).toBeCloseTo(p.lineY!, 5);
    }
    expect(TEXT_BASELINE_OFFSET.default).toBeGreaterThan(0);
  });
});
