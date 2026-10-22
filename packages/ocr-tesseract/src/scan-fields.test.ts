import { describe, expect, it } from 'vitest';
import { FieldDetectionService, type FieldProposal } from '@folio/services';
import { NodeImageCodec, fixture, flatFormDoc, pictureOf, sharedEngine } from '@folio/testkit';
import { createNodeOcrEngine } from './node.ts';

const codec = new NodeImageCodec();

/** A proposal's place: where its writing space is, in points. */
const near = (a: FieldProposal, b: FieldProposal, tol: { pos: number; size: number }): boolean =>
  Math.abs(a.rect.x - b.rect.x) <= tol.pos && Math.abs(a.rect.y - b.rect.y) <= tol.pos && Math.abs(a.rect.width - b.rect.width) <= tol.size && Math.abs(a.rect.height - b.rect.height) <= tol.size;
const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

describe('a form that is only a picture is located as if it were a native PDF (real OCR) @FR-FRM-15', () => {
  it('finds the same fields, labels and places as the native page it was made from', async () => {
    const engine = await sharedEngine();
    const ocr = createNodeOcrEngine((img) => codec.encode(img, 'png'));
    const svc = new FieldDetectionService({ ocr });
    const { pdf } = await flatFormDoc([
      { key: 'a', label: 'First name', kind: 'underline' },
      { key: 'b', label: 'Date of birth', kind: 'box' },
      { key: 'c', label: 'Email', kind: 'underscores' },
      { key: 'd', label: 'Phone number', kind: 'dots' },
      { key: 'e', label: 'Tax code', kind: 'comb' },
      { key: 'f', label: 'Send me the newsletter', kind: 'checkbox' },
    ]);
    const native = await engine.open(pdf);
    const truth = await svc.detectLocal(native, 0);
    expect(truth).toHaveLength(6);
    // The same page after printing and scanning: pixels only, 150 dpi.
    const scan = await engine.open(await pictureOf(pdf, { dpi: 150 }));
    expect((await scan.getTextLayer(0)).isScanned).toBe(true);
    const out = await svc.detect(scan, [0], { useAi: false, ocr: { languages: ['eng'] } });
    expect(out.notice).toBe('scanOcr');
    expect(out.proposals).toHaveLength(6);
    for (const t of truth) {
      const p = out.proposals.find((x) => norm(x.label) === norm(t.label));
      expect(p, `${t.label}`).toBeDefined();
      expect(p!.type).toBe(t.type);
      // Golden comparison: within 4 points of the native page, widths within 6.
      expect(near(p!, t, { pos: 4, size: 6 }), `${t.label}: scan ${JSON.stringify(p!.rect)} native ${JSON.stringify(t.rect)}`).toBe(true);
      if (t.lineY !== undefined) expect(Math.abs((p!.lineY ?? 1e9) - t.lineY), `${t.label} line`).toBeLessThanOrEqual(4);
      expect(p!.cells).toBe(t.cells);
    }
    await ocr.dispose();
  }, 120_000);

  it('does not run OCR on a page that has text of its own @FR-FRM-15', async () => {
    const engine = await sharedEngine();
    const ocr = createNodeOcrEngine((img) => codec.encode(img, 'png'));
    const calls: number[] = [];
    const counting = { recognize: (...a: Parameters<typeof ocr.recognize>) => (calls.push(1), ocr.recognize(...a)), dispose: () => ocr.dispose() };
    const svc = new FieldDetectionService({ ocr: counting });
    const text = await engine.open(await fixture('dotted-form'));
    await svc.detect(text, [0], { useAi: false, ocr: { languages: ['eng'] } });
    expect(calls).toEqual([]);
    await ocr.dispose();
  }, 60_000);
});
