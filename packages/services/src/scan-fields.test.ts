import { describe, expect, it } from 'vitest';
import type { RasterImage } from '@folio/ports';
import { FieldDetectionService } from './index.ts';
import { detectScanAreas } from './scan-fields.ts';
import { openFixture } from './testing.ts';

/** A grey, slightly noisy "photo of paper" at 2 px per point, drawn with a few helpers. */
function paper(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const g = 215 + (seed % 25);
    data.set([g, g, g - 6, 255], i * 4);
  }
  const ink = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < width && y < height) data.set([40, 40, 45, 255], (y * width + x) * 4);
  };
  const image: RasterImage = { width, height, data };
  return {
    image,
    hline: (x: number, y: number, len: number, thick = 2) => {
      for (let t = 0; t < thick; t++) for (let i = 0; i < len; i++) ink(x + i, y + t);
    },
    box: (x: number, y: number, w: number, h: number, thick = 2) => {
      for (let t = 0; t < thick; t++) {
        for (let i = 0; i < w; i++) {
          ink(x + i, y + t);
          ink(x + i, y + h - 1 - t);
        }
        for (let i = 0; i < h; i++) {
          ink(x + t, y + i);
          ink(x + w - 1 - t, y + i);
        }
      }
    },
    /** A "letter": a filled blob the size of body text. */
    blob: (x: number, y: number, w: number, h: number) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) ink(x + i, y + j);
    },
  };
}

describe('Detect fields on a scan, from the page image alone @FR-FRM-15', () => {
  it('finds underlines, empty boxes and small squares on a noisy page and ignores text', () => {
    const p = paper(1200, 1600);
    p.hline(300, 400, 500); // underline: 250 pt wide
    p.box(300, 600, 400, 50); // empty text box
    p.box(300, 800, 30, 30); // check square 15 pt
    for (let k = 0; k < 40; k++) p.blob(100 + k * 14, 200, 8, 14); // a line of printed text
    p.blob(900, 900, 20, 20); // a filled square is not a check box
    const found = detectScanAreas(p.image, 2);
    expect(found.filter((a) => a.kind === 'text').map((a) => [a.x, a.width])).toEqual([[300, 500], [300, 400]].map(([x, w]) => [x, w]));
    expect(found.filter((a) => a.kind === 'checkbox')).toHaveLength(1);
    expect(found).toHaveLength(3);
    // The strip above the underline is the field.
    const under = found.find((a) => a.width === 500)!;
    expect(under.y + under.height).toBe(400);
    expect(under.height).toBe(28);
  });

  it('a blank page and a page of text give nothing', () => {
    const p = paper(600, 800);
    expect(detectScanAreas(p.image, 2)).toEqual([]);
    for (let k = 0; k < 30; k++) p.blob(40 + k * 12, 100, 7, 12);
    expect(detectScanAreas(p.image, 2)).toEqual([]);
  });

  it('on a page that is turned, the writing space lies on the matching side of the line', () => {
    const p = paper(800, 1200);
    for (let t = 0; t < 2; t++) for (let i = 0; i < 400; i++) p.image.data.set([40, 40, 45, 255], ((300 + i) * 800 + 300 + t) * 4);
    const [a] = detectScanAreas(p.image, 2, 90);
    expect(a!.x).toBe(302); // right of the vertical line
    expect(detectScanAreas(p.image, 2, 270)[0]!.x + detectScanAreas(p.image, 2, 270)[0]!.width).toBe(300); // left of it
  });

  it('a vector page without fields says so instead of staying silent', async () => {
    const { engine } = await openFixture('text');
    const doc = await engine.open((await (await import('@folio/testkit')).fixture('invoice')) as Uint8Array);
    const out = await new FieldDetectionService({}).detect(doc, [0], { useAi: false });
    expect(out.proposals).toEqual([]);
    expect(out.notice).toBe('none');
  });
});
