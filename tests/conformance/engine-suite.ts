// Engine conformance suite (SPEC §8.9, §15): the same tests run against every PdfEngine implementation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FolioError } from '@folio/core';
import type {
  Annotation,
  MarkupAnnotation,
  PdfDocument,
  PdfEngine,
  RasterImage,
  SearchHit,
  SearchQuery,
  StampAnnotation,
} from '@folio/ports';
import { FIXTURE_PASSWORD, fixture, inkRatio, meanColor, sampleRaster } from '@folio/testkit';

export interface EngineCaps {
  /** Output is real PDF that external oracles can read. */
  realPdf: boolean;
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof FolioError ? e.code : `non-Folio error: ${String(e)}`;
  }
};
const pageTexts = async (doc: PdfDocument): Promise<string[]> => {
  const out: string[] = [];
  for (let i = 0; i < doc.pageCount; i++) out.push((await doc.getTextLayer(i)).text);
  return out;
};
const markers = async (doc: PdfDocument): Promise<number[]> =>
  (await pageTexts(doc)).map((t) => Number(/Page (\d+) of/.exec(t)?.[1] ?? /marker-(\d+)/.exec(t)?.[1] ?? 0));
const isBlank = (img: RasterImage): boolean => inkRatio(img) === 0;

export function runEngineConformance(
  name: string,
  factory: () => Promise<PdfEngine>,
  caps: EngineCaps,
): void {
  describe(`PdfEngine conformance: ${name}`, () => {
    let engine: PdfEngine;
    const open = async (fx: string, password?: string): Promise<PdfDocument> =>
      engine.open(await fixture(fx), { password });
    const valid = async (bytes: Uint8Array): Promise<void> => {
      if (caps.realPdf) await expect(bytes).toBeValidPdf();
    };
    beforeAll(async () => {
      engine = await factory();
    });
    afterAll(async () => {
      await engine.dispose();
    });

    describe('open and save', () => {
      it('opens a document and reports pages and metadata @FR-APP-01 @FR-VIEW-11', async () => {
        const doc = await open('text');
        expect(doc.pageCount).toBe(3);
        const meta = await doc.getMeta();
        expect(meta).toMatchObject({
          title: 'Text document',
          author: 'Folio testkit',
          hasAcroForm: false,
          isEncrypted: false,
          hasSignatures: false,
          wasRepaired: false,
        });
        expect(meta.pdfVersion).toMatch(/^1\.\d$/);
        doc.dispose();
      });
      it('rejects non-PDF data with InvalidPdf @FR-APP-13', async () => {
        expect(await code(open('garbage'))).toBe('invalidPdf');
        expect(await code(engine.open(new Uint8Array(3)))).toBe('invalidPdf');
      });
      it('opens a damaged file in recovery mode and flags it @FR-APP-13', async () => {
        const doc = await open('damaged');
        expect(doc.pageCount).toBe(2);
        expect((await doc.getMeta()).wasRepaired).toBe(true);
        expect((await doc.getTextLayer(0)).text).toContain('Page 1 of 2');
        doc.dispose();
      });
      it('asks for a password, rejects a wrong one, opens with the right one @FR-APP-12', async () => {
        expect(await code(open('encrypted'))).toBe('passwordRequired');
        expect(await code(open('encrypted', 'nope'))).toBe('wrongPassword');
        const doc = await open('encrypted', FIXTURE_PASSWORD);
        expect(doc.pageCount).toBe(1);
        expect((await doc.getMeta()).isEncrypted).toBe(true);
        expect((await doc.getTextLayer(0)).text).toContain('Invoce');
        doc.dispose();
      });
      it('round-trips through save without changing content @FR-APP-04', async () => {
        const doc = await open('invoice');
        const before = (await doc.getTextLayer(0)).text;
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        expect((await again.getTextLayer(0)).text).toBe(before);
        expect(again.pageCount).toBe(1);
        doc.dispose();
        again.dispose();
      });
      it('incremental save keeps the original bytes as a prefix @FR-APP-11', async () => {
        const original = await fixture('signed');
        const doc = await engine.open(original);
        expect((await doc.getMeta()).hasSignatures).toBe(true);
        await doc.upsertAnnotation(0, {
          type: 'square',
          rect: { x: 300, y: 300, width: 50, height: 50 },
          strokeWidth: 1,
          strokeStyle: 'solid',
          color: { r: 255, g: 0, b: 0 },
        });
        const inc = await doc.save({ incremental: true });
        expect(inc.length).toBeGreaterThan(original.length);
        expect(Buffer.from(inc.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
        const full = await doc.save();
        expect(Buffer.from(full.subarray(0, original.length)).equals(Buffer.from(original))).toBe(false);
        doc.dispose();
      });
      it('snapshot/restore brings back the exact earlier state @FR-APP-05', async () => {
        const doc = await open('text');
        const snap = await doc.snapshot();
        await doc.deletePages([0]);
        await doc.rotatePages([0], 90);
        expect(doc.pageCount).toBe(2);
        await doc.restore(snap);
        expect(doc.pageCount).toBe(3);
        expect(await markers(doc)).toEqual([1, 2, 3]);
        expect((await doc.getPageInfo(0)).rotation).toBe(0);
        doc.dispose();
      });
      it('creates an empty document and merges page selections @FR-MRG-01', async () => {
        const a = await open('text');
        const b = await open('rotated-pages');
        const merged = await engine.merge([
          { doc: a, pages: [2, 0] },
          { doc: b, pages: [1] },
        ]);
        expect(merged.pageCount).toBe(3);
        expect((await pageTexts(merged)).map((t) => t.split(/\r?\n/)[0])).toEqual([
          'Page 3 of 3',
          'Page 1 of 3',
          'Rotation 90',
        ]);
        expect((await merged.getPageInfo(2)).rotation).toBe(90);
        expect(a.pageCount).toBe(3);
        await valid(await merged.save());
        for (const d of [a, b, merged]) d.dispose();
      });
      it('refuses to use a disposed document', async () => {
        const doc = await open('text');
        doc.dispose();
        expect(await code(doc.getPageInfo(0))).toBe('invalidArgument');
      });
    });

    describe('OCR text layer', () => {
      const words = (page: { width: number; height: number }) => [
        { text: 'Hello', origin: { x: 72, y: page.height - 100 }, angle: 0, width: 60, fontSize: 14 },
        { text: 'recognised', origin: { x: 140, y: page.height - 100 }, angle: 0, width: 90, fontSize: 14 },
        { text: 'Città', origin: { x: 72, y: page.height - 130 }, angle: 0, width: 40, fontSize: 14 },
      ];
      it('writes invisible text that search and extraction find, and the page looks the same @FR-OCR-01 @FR-OCR-04', async () => {
        const doc = await open('scan');
        const before = await doc.render(0, { scale: 1 });
        expect((await doc.getTextLayer(0)).isScanned).toBe(true);
        expect(await doc.hasOcrLayer(0)).toBe(false);
        const res = await doc.addOcrLayer(0, words((await doc.getPageInfo(0)).size));
        expect(res).toEqual({ written: 3, substituted: 0 });
        expect(await doc.hasOcrLayer(0)).toBe(true);
        const layer = await doc.getTextLayer(0);
        expect(layer.text.replace(/\s+/g, ' ')).toContain('Hello recognised');
        expect(layer.text).toContain('Città');
        // The scan image is exactly as before: the text is invisible.
        expect(await doc.render(0, { scale: 1 })).toRenderLike(before, { tolerance: 0 });
        const hits: SearchHit[] = [];
        for await (const h of doc.search({ text: 'recognised' })) hits.push(h);
        expect(hits.length).toBe(1);
        // Word boxes are stretched to the width given, so selection matches the image.
        const run = layer.runs.find((r) => r.text.startsWith('recognised'))!;
        expect(run.rect.width).toBeGreaterThan(80);
        expect(run.rect.width).toBeLessThan(100);
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        expect(await again.hasOcrLayer(0)).toBe(true);
        expect(await again.removeOcrLayer(0)).toBe(3);
        expect((await again.getTextLayer(0)).text).toBe('');
        expect((await again.getTextLayer(0)).isScanned).toBe(true);
        expect(await again.hasOcrLayer(0)).toBe(false);
        doc.dispose();
        again.dispose();
      });
      it('removing the layer leaves third-party text alone and unsupported letters fall back to a base letter @FR-OCR-03', async () => {
        const doc = await open('text');
        const original = (await doc.getTextLayer(0)).text;
        const res = await doc.addOcrLayer(0, [
          { text: 'Reka 漢字', origin: { x: 72, y: 300 }, angle: 0, width: 80, fontSize: 12 },
          { text: 'plain', origin: { x: 72, y: 280 }, angle: 0, width: 30, fontSize: 12 },
          { text: '   ', origin: { x: 72, y: 260 }, angle: 0, width: 30, fontSize: 12 },
          { text: 'zero', origin: { x: 72, y: 240 }, angle: 0, width: 0, fontSize: 12 },
        ]);
        expect(res.written).toBe(2);
        expect(res.substituted).toBe(1);
        expect((await doc.getTextLayer(0)).text).toMatch(/Reka \?\?/);
        expect(await doc.removeOcrLayer(0)).toBe(2);
        expect((await doc.getTextLayer(0)).text).toBe(original);
        // Pages without a layer report none; asking twice is harmless.
        expect(await doc.removeOcrLayer(0)).toBe(0);
        expect(await code(doc.addOcrLayer(9, []))).toBe('invalidArgument');
        doc.dispose();
      });
      it('text on a rotated page reads upright when the page is shown @FR-OCR-01', async () => {
        const doc = await open('rotated-pages');
        const info = await doc.getPageInfo(1);
        expect(info.rotation).toBe(90);
        // On a page shown rotated by 90° the baseline runs up the page: angle 90 in user space.
        await doc.addOcrLayer(1, [{ text: 'sideways', origin: { x: 100, y: 100 }, angle: 90, width: 60, fontSize: 12 }]);
        const run = (await doc.getTextLayer(1)).runs.find((r) => r.text.includes('sideways'))!;
        expect(Math.round(run.angle)).toBe(90);
        expect(run.rect.height).toBeGreaterThan(run.rect.width);
        doc.dispose();
      });
    });

    describe('compact save', () => {
      it('writes object streams, Flate for every stream and keeps text and pages @FR-OPT-07', async () => {
        const doc = await open('text-25');
        const plain = await doc.save();
        const small = await doc.save({ compact: true });
        if (caps.realPdf) {
          await valid(small);
          expect(small.length).toBeLessThan(plain.length);
          const text = Buffer.from(small).toString('latin1');
          expect(text).toMatch(/\/Type\s*\/ObjStm/);
          expect(text).toMatch(/\/Type\s*\/XRef/);
        }
        const again = await engine.open(small);
        expect(again.pageCount).toBe(25);
        expect(await pageTexts(again)).toEqual(await pageTexts(doc));
        // Incremental saves ignore the option: the signed bytes must stay where they are.
        const signed = await open('signed');
        const original = await fixture('signed');
        const inc = await signed.save({ incremental: true, compact: true });
        expect(Buffer.from(inc.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
        again.dispose();
        signed.dispose();
        doc.dispose();
      });
    });

    describe('pages', () => {
      it('reports size, rotation and boxes @FR-ORG-01', async () => {
        const doc = await open('mixed-sizes');
        const sizes = [];
        for (let i = 0; i < doc.pageCount; i++) sizes.push((await doc.getPageInfo(i)).size);
        expect(sizes[0]!.width).toBeCloseTo(595.28, 1);
        expect(sizes[1]).toEqual({ width: 792, height: 612 });
        expect(sizes[3]).toEqual({ width: 300, height: 200 });
        doc.dispose();
        const rot = await open('rotated-pages');
        expect([0, 1, 2, 3].map(async (i) => (await rot.getPageInfo(i)).rotation)).toBeTruthy();
        expect((await rot.getPageInfo(1)).rotation).toBe(90);
        expect((await rot.getPageInfo(1)).size).toEqual({ width: 612, height: 792 });
        expect((await rot.getPageInfo(3)).rotation).toBe(270);
        rot.dispose();
      });
      it('rotates pages cumulatively @FR-ORG-04', async () => {
        const doc = await open('text');
        await doc.rotatePages([0, 2], 90);
        await doc.rotatePages([0], 270);
        await doc.rotatePages([1], 180);
        expect([
          (await doc.getPageInfo(0)).rotation,
          (await doc.getPageInfo(1)).rotation,
          (await doc.getPageInfo(2)).rotation,
        ]).toEqual([0, 180, 90]);
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        expect((await again.getPageInfo(2)).rotation).toBe(90);
        doc.dispose();
        again.dispose();
      });
      it('deletes pages and refuses to delete all of them @FR-ORG-05', async () => {
        const doc = await open('text');
        await doc.deletePages([1]);
        expect(await markers(doc)).toEqual([1, 3]);
        expect(await code(doc.deletePages([0, 1]))).toBe('invalidArgument');
        expect(await code(doc.deletePages([7]))).toBe('invalidArgument');
        expect(doc.pageCount).toBe(2);
        doc.dispose();
      });
      it('moves pages so the first lands at the target index @FR-ORG-03', async () => {
        const doc = await engine.open(await fixture('text-25'));
        await doc.movePages([0, 1], 3);
        expect((await markers(doc)).slice(0, 6)).toEqual([3, 4, 5, 1, 2, 6]);
        await doc.movePages([24], 0);
        expect((await markers(doc)).slice(0, 3)).toEqual([25, 3, 4]);
        expect(await code(doc.movePages([0, 0], 1))).toBe('invalidArgument');
        expect(await code(doc.movePages([0], 99))).toBe('invalidArgument');
        doc.dispose();
      });
      it('inserts a blank page of a given size @FR-ORG-07', async () => {
        const doc = await open('text');
        await doc.insertBlank(1, { width: 420, height: 595 });
        expect(doc.pageCount).toBe(4);
        expect((await doc.getPageInfo(1)).size).toEqual({ width: 420, height: 595 });
        expect((await doc.getTextLayer(1)).text).toBe('');
        expect(await markers(doc)).toEqual([1, 0, 2, 3]);
        expect(await code(doc.insertBlank(9, { width: 10, height: 10 }))).toBe('invalidArgument');
        expect(await code(doc.insertBlank(0, { width: 0, height: 10 }))).toBe('invalidArgument');
        await valid(await doc.save());
        doc.dispose();
      });
      it('imports pages from another document, also duplicating its own @FR-ORG-06 @FR-ORG-08', async () => {
        const doc = await open('text');
        const other = await open('mixed-sizes');
        await doc.importPages(other, [3, 1], 1);
        expect(doc.pageCount).toBe(5);
        expect((await doc.getPageInfo(1)).size).toEqual({ width: 300, height: 200 });
        expect((await doc.getPageInfo(2)).size).toEqual({ width: 792, height: 612 });
        await doc.importPages(doc, [0], 1);
        expect((await markers(doc)).slice(0, 2)).toEqual([1, 1]);
        await valid(await doc.save());
        doc.dispose();
        other.dispose();
      });
    });

    describe('rendering', () => {
      it('renders at the requested scale with visible content @FR-VIEW-01', async () => {
        const doc = await open('invoice');
        const img = await doc.render(0, { scale: 0.5 });
        expect([img.width, img.height]).toEqual([306, 396]);
        expect(img.data.length).toBe(306 * 396 * 4);
        expect(inkRatio(img)).toBeGreaterThan(0.005);
        expect(inkRatio(img, { x: 0, y: 0, width: 30, height: 30 })).toBe(0);
        const big = await doc.render(0, { scale: 2 });
        expect([big.width, big.height]).toEqual([1224, 1584]);
        doc.dispose();
      });
      it('renders a tile equal to the same region of the full render @FR-VIEW-01', async () => {
        const doc = await open('invoice');
        const full = await doc.render(0, { scale: 1 });
        const tile = await doc.render(0, { scale: 1, rect: { x: 60, y: 60, width: 200, height: 100 } });
        expect([tile.width, tile.height]).toEqual([200, 100]);
        let same = 0;
        for (let y = 0; y < 100; y++) {
          for (let x = 0; x < 200; x++) {
            const a = ((y + 60) * full.width + x + 60) * 4;
            const b = (y * 200 + x) * 4;
            if (Math.abs(full.data[a]! - tile.data[b]!) < 8) same++;
          }
        }
        expect(same / 20000).toBeGreaterThan(0.995);
        doc.dispose();
      });
      it('applies page and view rotation to the output size @FR-VIEW-06', async () => {
        const doc = await open('rotated-pages');
        const p90 = await doc.render(1, { scale: 0.25 });
        expect([p90.width, p90.height]).toEqual([198, 153]);
        const extra = await doc.render(0, { scale: 0.25, rotation: 90 });
        expect([extra.width, extra.height]).toEqual([198, 153]);
        doc.dispose();
      });
      it('can leave annotations out and honours cancellation and limits', async () => {
        const doc = await open('annotated');
        const withAnnots = await doc.render(0, { scale: 1 });
        const without = await doc.render(0, { scale: 1, annotations: false });
        const region = { x: 72, y: 792 - 620, width: 100, height: 60 };
        expect(inkRatio(withAnnots, region)).toBeGreaterThan(inkRatio(without, region));
        const ac = new AbortController();
        ac.abort();
        expect(await code(doc.render(0, { scale: 1 }, ac.signal))).toBe('cancelled');
        expect(await code(doc.render(0, { scale: 40 }))).toBe('limitExceeded');
        expect(await code(doc.render(0, { scale: 0 }))).toBe('invalidArgument');
        expect(await code(doc.render(5, { scale: 1 }))).toBe('invalidArgument');
        doc.dispose();
      });
    });

    describe('text', () => {
      it('returns characters, runs with font data and lines @FR-VIEW-03 @FR-EDT-01', async () => {
        const doc = await open('invoice');
        const layer = await doc.getTextLayer(0);
        expect(layer.isScanned).toBe(false);
        const heading = layer.runs.find((r) => r.text === 'Invoce')!;
        expect(heading).toBeDefined();
        expect(heading.fontSize).toBeCloseTo(28, 1);
        expect(heading.font.name).toMatch(/Helvetica/);
        expect(heading.font.weight).toBeGreaterThanOrEqual(600);
        expect(heading.origin.x).toBeCloseTo(72, 0);
        expect(heading.origin.y).toBeCloseTo(708, 0);
        expect(heading.objId).toBeDefined();
        expect(heading.angle).toBeCloseTo(0, 3);
        expect(
          layer.chars
            .slice(heading.charStart, heading.charStart + heading.charCount)
            .map((c) => c.text)
            .join(''),
        ).toBe('Invoce');
        const total = layer.runs.find((r) => r.text.startsWith('Total due'))!;
        expect(total.color.r).toBeGreaterThan(150);
        expect(total.color.g).toBeLessThan(80);
        const line = layer.lines.find((l) => l.text.includes('Payment within 30 days'))!;
        expect(line.editable).toBe(true);
        expect(line.rect.width).toBeGreaterThan(200);
        expect(layer.text).toContain('Design services');
        doc.dispose();
      });
      it('reports subset fonts, rotated text and Unicode @FR-EDT-01 @FR-VIEW-03', async () => {
        const subset = await open('subset-font');
        const run = (await subset.getTextLayer(0)).runs[0]!;
        expect(run.font).toMatchObject({ isEmbedded: true, isSubset: true });
        expect(run.font.name).toContain('LiberationSerif');
        subset.dispose();
        const rotated = await open('rotated-text');
        const layer = await rotated.getTextLayer(0);
        const tilted = layer.runs.find((r) => r.text === 'Tilted text')!;
        expect(tilted.angle).toBeCloseTo(30, 0);
        expect(layer.lines.find((l) => l.text === 'Tilted text')!.editable).toBe(false);
        expect(layer.lines.find((l) => l.text === 'Straight text')!.editable).toBe(true);
        rotated.dispose();
        const uni = await open('unicode');
        const text = (await uni.getTextLayer(0)).text;
        for (const s of ['Ελληνικά', 'Русский', 'Żółć']) expect(text).toContain(s);
        expect(text).toMatch(/שלום|םולש/);
        uni.dispose();
      });
      it('flags image-only pages as scanned @FR-EDT-08', async () => {
        const doc = await open('scan');
        const layer = await doc.getTextLayer(0);
        expect(layer).toMatchObject({ isScanned: true, text: '', runs: [] });
        doc.dispose();
      });
      it('searches with case and whole-word options and returns rects and snippets @FR-VIEW-04', async () => {
        const doc = await open('text');
        const collect = async (q: SearchQuery): Promise<SearchHit[]> => {
          const hits: SearchHit[] = [];
          for await (const h of doc.search(q)) hits.push(h);
          return hits;
        };
        const all = await collect({ text: 'page' });
        expect(all.length).toBe(3);
        expect(all.map((h) => h.page)).toEqual([0, 1, 2]);
        expect(all[0]!.rects[0]!.width).toBeGreaterThan(20);
        expect(all[0]!.snippet.match).toBe('Page');
        expect(all[0]!.snippet.after).toContain('1 of 3');
        expect((await collect({ text: 'page', matchCase: true })).length).toBe(0);
        expect((await collect({ text: 'mark' })).length).toBe(3);
        expect((await collect({ text: 'mark', wholeWord: true })).length).toBe(0);
        expect((await collect({ text: 'marker-2' })).map((h) => h.page)).toEqual([1]);
        expect((await collect({ text: 'of', pages: [2] })).length).toBe(1);
        expect((await collect({ text: '' })).length).toBe(0);
        doc.dispose();
      });
    });

    describe('outline, links, attachments', () => {
      it('reads a nested outline with Unicode titles @FR-VIEW-02', async () => {
        const doc = await open('bookmarks');
        const outline = await doc.getOutline();
        expect(outline.map((n) => n.title)).toEqual(['Chapter 1', 'Chapter 2', 'Appendix – Ünïcode']);
        expect(outline[0]!.children[0]).toMatchObject({
          title: 'Section 1.1',
          target: { kind: 'page', page: 1 },
        });
        expect(outline[1]!.target).toMatchObject({ kind: 'page', page: 3 });
        doc.dispose();
      });
      it('replaces the outline and persists it @FR-MRG-02', async () => {
        const doc = await open('text');
        await doc.setOutline([
          {
            title: 'First file',
            target: { kind: 'page', page: 0 },
            children: [{ title: 'Inner', target: { kind: 'page', page: 1 }, children: [] }],
          },
          { title: 'Second file', target: { kind: 'page', page: 2 }, children: [] },
        ]);
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        const outline = await again.getOutline();
        expect(outline.map((n) => [n.title, n.target])).toEqual([
          ['First file', expect.objectContaining({ kind: 'page', page: 0 })],
          ['Second file', expect.objectContaining({ kind: 'page', page: 2 })],
        ]);
        expect(outline[0]!.children[0]!.title).toBe('Inner');
        await again.setOutline([]);
        expect(await again.getOutline()).toEqual([]);
        doc.dispose();
        again.dispose();
      });
      it('edits bookmarks in place: add, rename, move, nest and delete @FR-EDT-11', async () => {
        const doc = await open('bookmarks');
        const titles = async (): Promise<unknown> =>
          (await doc.getOutline()).map((n) => [n.title, n.children.map((c) => c.title)]);
        await doc.editOutline({ op: 'add', parent: [], index: 1, title: 'Inserted', target: { kind: 'page', page: 2, point: { x: 10, y: 20 } } });
        expect(await titles()).toEqual([['Chapter 1', ['Section 1.1']], ['Inserted', []], ['Chapter 2', []], ['Appendix – Ünïcode', []]]);
        await doc.editOutline({ op: 'add', parent: [1], index: 0, title: 'Child', target: { kind: 'uri', uri: 'https://example.com/' } });
        await doc.editOutline({ op: 'rename', path: [0, 0], title: '  Renamed 1.1  ' });
        expect(await titles()).toEqual([['Chapter 1', ['Renamed 1.1']], ['Inserted', ['Child']], ['Chapter 2', []], ['Appendix – Ünïcode', []]]);
        // Indent "Chapter 2" under "Inserted" (after its child), then outdent the child to the top.
        await doc.editOutline({ op: 'move', path: [2], parent: [1], index: 1 });
        await doc.editOutline({ op: 'move', path: [1, 0], parent: [], index: 0 });
        expect(await titles()).toEqual([['Child', []], ['Chapter 1', ['Renamed 1.1']], ['Inserted', ['Chapter 2']], ['Appendix – Ünïcode', []]]);
        const outline = await doc.getOutline();
        expect(outline[0]!.target).toEqual({ kind: 'uri', uri: 'https://example.com/' });
        expect(outline[2]!.target).toMatchObject({ kind: 'page', page: 2 });
        expect(outline[2]!.children[0]!.target).toMatchObject({ kind: 'page', page: 3 });
        await doc.editOutline({ op: 'setTarget', path: [3], target: { kind: 'page', page: 0 } });
        await doc.editOutline({ op: 'remove', path: [1] });
        expect((await doc.getOutline()).map((n) => n.title)).toEqual(['Child', 'Inserted', 'Appendix – Ünïcode']);
        expect((await doc.getOutline())[2]!.target).toMatchObject({ kind: 'page', page: 0 });
        // Bad paths, empty titles and moving an entry into itself are refused.
        expect(await code(doc.editOutline({ op: 'rename', path: [9], title: 'x' }))).toBe('invalidArgument');
        expect(await code(doc.editOutline({ op: 'rename', path: [0], title: '   ' }))).toBe('invalidArgument');
        expect(await code(doc.editOutline({ op: 'add', parent: [], index: 0, title: 'x'.repeat(513) }))).toBe('invalidArgument');
        expect(await code(doc.editOutline({ op: 'move', path: [1], parent: [7], index: 0 }))).toBe('invalidArgument');
        expect(await code(doc.editOutline({ op: 'remove', path: [] }))).toBe('invalidArgument');
        if (caps.realPdf) {
          const bytes = await doc.save();
          await valid(bytes);
          const again = await engine.open(bytes);
          expect((await again.getOutline()).map((n) => n.title)).toEqual(['Child', 'Inserted', 'Appendix – Ünïcode']);
          again.dispose();
        }
        doc.dispose();
      });
      it('leaves untouched bookmarks exactly as they were: actions, style, colour @FR-EDT-27', async () => {
        const doc = await open('bookmarks-actions');
        const before = await doc.getOutline();
        expect(before.map((n) => n.target)).toEqual([
          expect.objectContaining({ kind: 'page', page: 0 }),
          { kind: 'unsupported', reason: 'unknown' },
          { kind: 'uri', uri: 'https://example.com/spec' },
          { kind: 'unsupported', reason: expect.any(String) },
        ]);
        await doc.editOutline({ op: 'rename', path: [0], title: 'Introduction' });
        await doc.editOutline({ op: 'add', parent: [], index: 4, title: 'Last' });
        if (caps.realPdf) {
          const bytes = await doc.save();
          const text = Buffer.from(bytes).toString('latin1');
          // The entries nobody edited still carry their named action, colour, style flags and script.
          expect(text).toMatch(/\/N\s*\/NextPage/);
          expect(text).toMatch(/\/C\s*\[\s*1(\.0+)?\s+0(\.0+)?\s+0(\.0+)?\s*\]/);
          expect(text).toMatch(/\/F\s*2\b/);
          expect(text).toMatch(/\/S\s*\/JavaScript/);
          expect(text).toContain('app.alert');
        }
        const after = await doc.getOutline();
        expect(after.map((n) => n.title)).toEqual(['Introduction', 'Next page', 'Website', 'Script', 'Last']);
        expect(after.slice(1, 4).map((n) => n.target)).toEqual(before.slice(1, 4).map((n) => n.target));
        // Moving an entry is a copy: its title and target survive, the original is gone.
        await doc.editOutline({ op: 'move', path: [2], parent: [], index: 0 });
        expect((await doc.getOutline()).map((n) => n.title)).toEqual(['Website', 'Introduction', 'Next page', 'Script', 'Last']);
        expect((await doc.getOutline())[0]!.target).toEqual({ kind: 'uri', uri: 'https://example.com/spec' });
        doc.dispose();
      });
      it('bookmarks follow their pages; entries of deleted pages are reported as missing @FR-EDT-27', async () => {
        const doc = await open('bookmarks');
        await doc.movePages([0], 4);
        const moved = await doc.getOutline();
        // Chapter 1 pointed at the first page, which is now the last.
        expect(moved[0]!.target).toMatchObject({ kind: 'page', page: 4 });
        expect(moved[0]!.children[0]!.target).toMatchObject({ kind: 'page', page: 0 });
        // Chapter 2's page is now third; Appendix and the section keep theirs.
        await doc.deletePages([2]);
        const after = await doc.getOutline();
        const chapter2 = after.find((n) => n.title === 'Chapter 2')!;
        expect(chapter2.target).toEqual({ kind: 'unsupported', reason: 'missing' });
        for (const n of after.flatMap((x) => [x, ...x.children])) {
          if (n.target?.kind === 'page') expect(n.target.page).toBeLessThan(doc.pageCount);
        }
        doc.dispose();
      });
      it('reports link targets and never exposes script or launch actions as openable @FR-VIEW-05 @FR-SEC-05', async () => {
        const doc = await open('links');
        const links = await doc.getLinks(0);
        expect(links.length).toBe(5);
        const sorted = [...links].sort((a, b) => b.rect.y - a.rect.y).map((l) => l.target);
        expect(sorted[0]).toMatchObject({ kind: 'page', page: 2 });
        expect(sorted[1]).toEqual({ kind: 'uri', uri: 'https://example.com/docs?a=1' });
        expect(sorted[2]!.kind).toBe('unsupported');
        expect(sorted[3]).toEqual({ kind: 'unsupported', reason: 'launch' });
        expect(sorted[4]).toEqual({ kind: 'unsupported', reason: 'javascript' });
        expect(links[0]!.rect.width).toBeCloseTo(128, 0);
        doc.dispose();
      });
      it('lists attachments read-only and returns their bytes on request @FR-VIEW-02 @FR-SEC-05', async () => {
        const doc = await open('attachment');
        const list = await doc.listAttachments();
        expect(list).toEqual([{ index: 0, name: 'data.txt', size: 16 }]);
        expect(new TextDecoder().decode(await doc.getAttachment(0))).toBe('hello attachment');
        expect(await code(doc.getAttachment(3))).toBe('invalidArgument');
        doc.dispose();
      });
    });

    describe('metadata', () => {
      it('edits and clears metadata @FR-SEC-04', async () => {
        const doc = await open('text');
        await doc.setMetadata({ title: 'Nuovo titolo – ü', author: 'Luca', keywords: 'a, b' });
        let bytes = await doc.save();
        await valid(bytes);
        let again = await engine.open(bytes);
        expect(await again.getMeta()).toMatchObject({
          title: 'Nuovo titolo – ü',
          author: 'Luca',
          subject: 'Fixture',
          keywords: 'a, b',
        });
        await again.clearMetadata();
        bytes = await again.save();
        again.dispose();
        again = await engine.open(bytes);
        expect(await again.getMeta()).toMatchObject({
          title: '',
          author: '',
          subject: '',
          keywords: '',
          creator: '',
        });
        doc.dispose();
        again.dispose();
      });
    });

    describe('annotations', () => {
      const base = {
        color: { r: 211, g: 47, b: 47 },
        author: 'Marta',
        contents: 'note text',
        modified: 'D:20261011090000Z',
      };
      const samples: Annotation[] = [
        {
          type: 'highlight',
          rect: { x: 72, y: 716, width: 128, height: 24 },
          quads: [
            { p1: { x: 72, y: 740 }, p2: { x: 200, y: 740 }, p3: { x: 72, y: 716 }, p4: { x: 200, y: 716 } },
          ],
          ...base,
          color: { r: 255, g: 213, b: 74 },
          opacity: 0.5,
        },
        {
          type: 'underline',
          rect: { x: 72, y: 686, width: 100, height: 14 },
          quads: [
            { p1: { x: 72, y: 700 }, p2: { x: 172, y: 700 }, p3: { x: 72, y: 686 }, p4: { x: 172, y: 686 } },
          ],
          ...base,
        },
        {
          type: 'strikeout',
          rect: { x: 72, y: 686, width: 100, height: 14 },
          quads: [
            { p1: { x: 72, y: 700 }, p2: { x: 172, y: 700 }, p3: { x: 72, y: 686 }, p4: { x: 172, y: 686 } },
          ],
          ...base,
        },
        {
          type: 'squiggly',
          rect: { x: 72, y: 686, width: 100, height: 14 },
          quads: [
            { p1: { x: 72, y: 700 }, p2: { x: 172, y: 700 }, p3: { x: 72, y: 686 }, p4: { x: 172, y: 686 } },
          ],
          ...base,
        },
        { type: 'text', rect: { x: 300, y: 600, width: 20, height: 20 }, ...base },
        {
          type: 'freetext',
          rect: { x: 72, y: 500, width: 200, height: 40 },
          contents: 'Typed text',
          author: 'Marta',
          fontFamily: 'sans',
          fontSize: 12,
          textColor: { r: 29, g: 78, b: 216 },
          align: 'center',
        },
        {
          type: 'square',
          rect: { x: 72, y: 400, width: 100, height: 60 },
          strokeWidth: 2,
          strokeStyle: 'solid',
          fillColor: { r: 255, g: 240, b: 200 },
          ...base,
        },
        {
          type: 'circle',
          rect: { x: 200, y: 400, width: 100, height: 60 },
          strokeWidth: 3,
          strokeStyle: 'dashed',
          ...base,
        },
        {
          type: 'line',
          rect: { x: 320, y: 400, width: 120, height: 60 },
          start: { x: 325, y: 405 },
          end: { x: 435, y: 455 },
          startEnding: 'none',
          endEnding: 'openArrow',
          strokeWidth: 2,
          strokeStyle: 'solid',
          ...base,
        },
        {
          type: 'polyline',
          rect: { x: 450, y: 400, width: 110, height: 60 },
          vertices: [
            { x: 455, y: 405 },
            { x: 500, y: 455 },
            { x: 555, y: 410 },
          ],
          strokeWidth: 2,
          strokeStyle: 'solid',
          ...base,
        },
      ];

      it.each(samples.map((s) => [s.type, s] as const))(
        'creates a %s annotation that survives save and reload @FR-ANN-01 @FR-ANN-02 @FR-ANN-03 @FR-ANN-04',
        async (_type, sample) => {
          const doc = await open('text');
          const id = await doc.upsertAnnotation(0, sample);
          expect(id).toBeTruthy();
          const bytes = await doc.save();
          await valid(bytes);
          // An /AcroForm created for a default appearance must still carry /Fields (poppler complains otherwise).
          const raw = new TextDecoder('latin1').decode(bytes);
          if (raw.includes('/AcroForm')) expect(raw).toContain('/Fields');
          const again = await engine.open(bytes);
          const list = await again.listAnnotations(0);
          expect(list.length).toBe(1);
          const got = list[0]!;
          expect(got.type).toBe(sample.type);
          expect(got.id).toBe(id);
          expect(got.rect.x).toBeCloseTo(sample.rect.x, 0);
          expect(got.rect.width).toBeGreaterThan(0);
          if (sample.author) expect(got.author).toBe(sample.author);
          if (sample.contents) expect(got.contents).toBe(sample.contents);
          if (sample.color && sample.type !== 'freetext') expect(got.color).toMatchObject(sample.color);
          if ('quads' in sample && 'quads' in got) expect(got.quads[0]!.p1).toMatchObject({ x: 72 });
          if (sample.type === 'highlight') expect(got.opacity).toBeCloseTo(0.5, 1);
          if (sample.type === 'line' && got.type === 'line') {
            expect(got.end.x).toBeCloseTo(435, 0);
            expect(got.endEnding).toBe('openArrow');
            expect(got.strokeWidth).toBeCloseTo(2, 1);
          }
          if (sample.type === 'circle' && got.type === 'circle') expect(got.strokeStyle).toBe('dashed');
          if (sample.type === 'square' && got.type === 'square')
            expect(got.fillColor).toMatchObject({ r: 255, g: 240, b: 200 });
          if (sample.type === 'polyline' && got.type === 'polyline') expect(got.vertices.length).toBe(3);
          if (sample.type === 'freetext' && got.type === 'freetext') {
            expect(got).toMatchObject({ fontFamily: 'sans', align: 'center' });
            expect(got.fontSize).toBeCloseTo(12, 1);
            expect(got.textColor).toMatchObject({ r: 29, g: 78, b: 216 });
          }
          // The appearance stream makes it visible in the render.
          const withA = await again.render(0, { scale: 1 });
          const without = await again.render(0, { scale: 1, annotations: false });
          const region = {
            x: got.rect.x - 2,
            y: 792 - got.rect.y - got.rect.height - 2,
            width: got.rect.width + 4,
            height: got.rect.height + 4,
          };
          expect(JSON.stringify(meanColor(withA, region))).not.toBe(
            JSON.stringify(meanColor(without, region)),
          );
          doc.dispose();
          again.dispose();
        },
      );

      it('updates, reorders and removes annotations by id @FR-ANN-06', async () => {
        const doc = await open('text');
        const a = await doc.upsertAnnotation(0, samples[6]!);
        const b = await doc.upsertAnnotation(0, samples[7]!);
        const moved = {
          ...(await doc.listAnnotations(0))[0]!,
          rect: { x: 300, y: 100, width: 50, height: 30 },
          color: { r: 0, g: 128, b: 0 },
          locked: true,
        } as Annotation;
        expect(await doc.upsertAnnotation(0, moved)).toBe(a);
        let list = await doc.listAnnotations(0);
        expect(list.length).toBe(2);
        expect(list[0]).toMatchObject({ id: a, locked: true, color: { r: 0, g: 128, b: 0 } });
        expect(list[0]!.rect.x).toBeCloseTo(300, 0);
        await doc.reorderAnnotations(0, [b, a]);
        expect((await doc.listAnnotations(0)).map((x) => x.id)).toEqual([b, a]);
        // A preset id that does not exist yet creates the annotation under that id (redo support).
        expect(await doc.upsertAnnotation(1, { ...samples[4]!, id: 'preset-id' })).toBe('preset-id');
        await doc.removeAnnotation(0, a);
        list = await doc.listAnnotations(0);
        expect(list.map((x) => x.id)).toEqual([b]);
        expect(await code(doc.removeAnnotation(0, 'missing'))).toBe('invalidArgument');
        expect(await code(doc.upsertAnnotation(0, { ...samples[6]!, id: b } as Annotation))).toBe(
          'invalidArgument',
        );
        doc.dispose();
      });

      it('shrinks a markup annotation to fewer quads under the same id @FR-ANN-01', async () => {
        const doc = await open('text');
        const q = (y: number) => ({
          p1: { x: 72, y: y + 12 },
          p2: { x: 200, y: y + 12 },
          p3: { x: 72, y },
          p4: { x: 200, y },
        });
        const id = await doc.upsertAnnotation(0, {
          type: 'highlight',
          rect: { x: 72, y: 680, width: 128, height: 40 },
          quads: [q(708), q(680)],
          color: { r: 255, g: 213, b: 74 },
        });
        await doc.upsertAnnotation(0, {
          type: 'highlight',
          id,
          rect: { x: 72, y: 708, width: 128, height: 12 },
          quads: [q(708)],
          color: { r: 255, g: 213, b: 74 },
        });
        const list = await doc.listAnnotations(0);
        expect(list.length).toBe(1);
        expect(list[0]).toMatchObject({ id, type: 'highlight' });
        expect((list[0] as MarkupAnnotation).quads.length).toBe(1);
        doc.dispose();
      });

      it('creates image, vector and text stamps as Stamp annotations @FR-STM-03 @FR-STM-06 @FR-STM-08', async () => {
        const doc = await open('text');
        const stamps: StampAnnotation[] = [
          {
            type: 'stamp',
            name: 'Signature',
            rect: { x: 72, y: 300, width: 120, height: 60 },
            appearance: { kind: 'image', image: sampleRaster(60, 30) },
          },
          {
            type: 'stamp',
            name: 'Signature',
            rect: { x: 220, y: 300, width: 120, height: 60 },
            appearance: {
              kind: 'vector',
              width: 100,
              height: 50,
              paths: [
                {
                  segments: [
                    { op: 'M', x: 5, y: 5 },
                    { op: 'C', x1: 30, y1: 60, x2: 60, y2: -10, x: 95, y: 45 },
                  ],
                  stroke: { r: 29, g: 78, b: 216 },
                  strokeWidth: 2,
                },
              ],
            },
          },
          {
            type: 'stamp',
            name: 'Approved',
            rect: { x: 370, y: 300, width: 160, height: 60 },
            rotation: 8,
            opacity: 0.85,
            appearance: {
              kind: 'text',
              text: 'APPROVED',
              color: { r: 22, g: 128, b: 60 },
              fontFamily: 'sans',
              bold: true,
              border: true,
            },
          },
        ];
        for (const s of stamps) await doc.upsertAnnotation(0, s);
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        const list = await again.listAnnotations(0);
        expect(list.map((a) => a.type)).toEqual(['stamp', 'stamp', 'stamp']);
        expect(list.map((a) => (a as StampAnnotation).name)).toEqual(['Signature', 'Signature', 'Approved']);
        const img = await again.render(0, { scale: 1 });
        for (const s of stamps) {
          expect(
            inkRatio(img, {
              x: s.rect.x,
              y: 792 - s.rect.y - s.rect.height,
              width: s.rect.width,
              height: s.rect.height,
            }),
          ).toBeGreaterThan(0.02);
        }
        const green = meanColor(img, { x: 370, y: 792 - 360, width: 160, height: 60 });
        expect(green.g).toBeGreaterThan(green.r);
        // Moving a stamp read back from the file only needs a new rect.
        await again.upsertAnnotation(0, { ...list[0]!, rect: { x: 72, y: 100, width: 120, height: 60 } });
        const movedImg = await again.render(0, { scale: 1 });
        expect(inkRatio(movedImg, { x: 72, y: 792 - 160, width: 120, height: 60 })).toBeGreaterThan(0.02);
        expect(inkRatio(movedImg, { x: 72, y: 792 - 360, width: 120, height: 60 })).toBe(0);
        expect(
          await code(
            again.upsertAnnotation(0, { type: 'stamp', rect: { x: 0, y: 0, width: 10, height: 10 } }),
          ),
        ).toBe('invalidArgument');
        doc.dispose();
        again.dispose();
      });

      it('imports annotations written by other tools and can edit and delete them @FR-ANN-11', async () => {
        const doc = await open('annotated');
        const list = await doc.listAnnotations(0);
        expect(list.map((a) => a.type)).toEqual(['highlight', 'text', 'square', 'other']);
        expect(list[0]).toMatchObject({
          id: 'other-hl-1',
          author: 'Other Viewer',
          contents: 'Check this heading',
        });
        expect(list[0]!.opacity).toBeCloseTo(0.5, 1);
        expect(list[3]).toMatchObject({ type: 'other', subtype: 'FileAttachment' });
        const square = list[2]!;
        expect(square.id).toBeTruthy();
        const newId = await doc.upsertAnnotation(0, {
          ...square,
          color: { r: 0, g: 0, b: 255 },
        } as Annotation);
        expect(newId).not.toMatch(/^#/);
        await doc.upsertAnnotation(0, { ...list[3]!, rect: { x: 10, y: 10, width: 20, height: 20 } });
        await doc.removeAnnotation(0, 'other-note-1');
        const after = await doc.listAnnotations(0);
        expect(after.map((a) => a.type)).toEqual(['highlight', 'square', 'other']);
        expect(after[1]).toMatchObject({ id: newId, color: { r: 0, g: 0, b: 255 } });
        expect(after[2]!.rect.x).toBeCloseTo(10, 0);
        await valid(await doc.save());
        doc.dispose();
      });

      it('flattens annotations into page content @FR-ANN-09 @FR-OPT-06', async () => {
        const doc = await open('text');
        await doc.upsertAnnotation(0, samples[6]!);
        await doc.upsertAnnotation(0, samples[5]!);
        await doc.upsertAnnotation(1, samples[7]!);
        const before = await doc.render(0, { scale: 1 });
        await doc.flattenAnnotations([0]);
        expect(await doc.listAnnotations(0)).toEqual([]);
        expect((await doc.listAnnotations(1)).length).toBe(1);
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        expect(await again.listAnnotations(0)).toEqual([]);
        expect(await again.render(0, { scale: 1, annotations: false })).toRenderLike(before, {
          tolerance: 0.01,
        });
        await again.flattenAnnotations();
        expect(await again.listAnnotations(1)).toEqual([]);
        doc.dispose();
        again.dispose();
      });
    });

    describe('forms', () => {
      it('creates one field of every type on a blank page and they can be filled and saved @FR-FRM-08 @FR-FRM-11', async () => {
        const doc = await open('text');
        const r = (x: number, y: number, w = 160, h = 22) => ({ x, y, width: w, height: h });
        const ids = await doc.createFields([
          { type: 'text', name: 'person.name', page: 0, rect: r(72, 700), tooltip: 'Full name', required: true },
          { type: 'text', name: 'notes', page: 0, rect: r(72, 640, 200, 50), multiline: true, maxLength: 200 },
          { type: 'text', name: 'code', page: 0, rect: r(72, 600, 150), comb: true, maxLength: 6 },
          { type: 'checkbox', name: 'agree', page: 0, rect: r(72, 560, 16, 16), exportValue: 'Yes' },
          { type: 'radio', name: 'size', page: 0, rect: r(72, 520, 16, 16), exportValue: 'small' },
          { type: 'radio', name: 'size', page: 0, rect: r(120, 520, 16, 16), exportValue: 'large' },
          { type: 'dropdown', name: 'country', page: 0, rect: r(72, 480), options: [{ label: 'Italy', value: 'IT' }, { label: 'France', value: 'FR' }] },
          { type: 'listbox', name: 'langs', page: 0, rect: r(72, 400, 120, 60), options: [{ label: 'EN', value: 'EN' }, { label: 'IT', value: 'IT' }] },
          { type: 'button', name: 'submit', page: 0, rect: r(72, 360, 90, 26), caption: 'Send' },
          { type: 'signature', name: 'sign', page: 0, rect: r(72, 300, 200, 50) },
        ]);
        expect(ids).toEqual(['person.name', 'notes', 'code', 'agree', 'size', 'size', 'country', 'langs', 'submit', 'sign']);
        const fields = await doc.listFormFields();
        const by = (n: string) => fields.find((f) => f.name === n)!;
        expect(fields.map((f) => f.name).sort()).toEqual(['agree', 'code', 'country', 'langs', 'notes', 'person.name', 'sign', 'size', 'submit']);
        expect(by('person.name')).toMatchObject({ type: 'text', required: true, label: 'Full name' });
        expect(by('notes')).toMatchObject({ multiline: true, maxLength: 200 });
        expect(by('code')).toMatchObject({ comb: true, maxLength: 6 });
        expect(by('size').widgets.map((w) => w.exportValue)).toEqual(['small', 'large']);
        expect(by('country').options!.map((o) => o.label)).toEqual(['Italy', 'France']);
        expect(by('sign').type).toBe('signature');
        expect(by('person.name').widgets[0]!.rect).toMatchObject({ x: 72, y: 700, width: 160, height: 22 });
        // New fields work at once.
        await doc.setFieldValue('person.name', 'Ada Lovelace');
        await doc.setFieldValue('agree', true);
        await doc.setFieldValue('size', 'large');
        await doc.setFieldValue('country', 'France');
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        const back = await again.listFormFields();
        expect(back.find((f) => f.name === 'person.name')!.value).toBe('Ada Lovelace');
        expect(back.find((f) => f.name === 'agree')!.value).not.toBe('Off');
        expect(back.find((f) => f.name === 'size')!.value).toBe('large');
        expect(back.find((f) => f.name === 'country')!.value).toBe('France');
        // Other viewers see the text: the appearance stream carries it.
        if (caps.realPdf) expect(Buffer.from(bytes).toString('latin1')).toContain('(Ada Lovelace)');
        doc.dispose();
        again.dispose();
      });
      it('refuses taken names, empty rectangles and unknown pages; XFA and encrypted files are not authored @FR-FRM-08 @FR-FRM-09', async () => {
        const doc = await open('acroform');
        const base = { type: 'text' as const, page: 0, rect: { x: 10, y: 10, width: 50, height: 20 } };
        expect(await code(doc.createFields([{ ...base, name: 'person.name' }]))).toBe('invalidArgument');
        expect(await code(doc.createFields([{ ...base, name: 'fresh', rect: { x: 0, y: 0, width: 0, height: 5 } }]))).toBe('invalidArgument');
        expect(await code(doc.createFields([{ ...base, name: 'fresh', page: 9 }]))).toBe('invalidArgument');
        expect(await code(doc.createFields([{ ...base, name: '.bad' }]))).toBe('invalidArgument');
        expect(await code(doc.createFields([{ ...base, name: 'code', comb: true }]))).toBe('invalidArgument');
        expect((await doc.listFormFields()).some((f) => f.name === 'fresh')).toBe(false);
        const xfa = await open('xfa');
        expect(await code(xfa.createFields([{ ...base, name: 'x' }]))).toBe('unsupportedFeature');
        const enc = await engine.open(await fixture('encrypted'), { password: FIXTURE_PASSWORD });
        expect(await code(enc.createFields([{ ...base, name: 'x' }]))).toBe('unsupportedFeature');
        for (const d of [doc, xfa, enc]) d.dispose();
      });
      it('edits an existing form: properties, move, resize, delete a field and one radio option @FR-FRM-16', async () => {
        const doc = await open('acroform');
        const before = await doc.listFormFields();
        const name = before.find((f) => f.name === 'person.name')!;
        await doc.updateField(name.id, { multiline: true, required: true, tooltip: 'Your name', maxLength: 40 });
        let f = (await doc.listFormFields()).find((x) => x.name === 'person.name')!;
        expect(f).toMatchObject({ multiline: true, required: true, label: 'Your name', maxLength: 40 });
        await doc.updateField(name.id, { multiline: false, maxLength: null });
        f = (await doc.listFormFields()).find((x) => x.name === 'person.name')!;
        expect(f.multiline).toBe(false);
        expect(f.maxLength).toBeUndefined();
        // Dropdown ↔ list box and new options.
        await doc.updateField('country', { listbox: true, options: [{ label: 'Spain', value: 'ES' }, { label: 'Italy', value: 'IT' }] });
        const country = (await doc.listFormFields()).find((x) => x.name === 'country')!;
        expect(country.type).toBe('listbox');
        expect(country.options!.map((o) => o.label)).toEqual(['Spain', 'Italy']);
        await doc.updateField('country', { listbox: false });
        expect((await doc.listFormFields()).find((x) => x.name === 'country')!.type).toBe('dropdown');
        // Move and resize.
        await doc.setWidgetRect(name.id, 0, { x: 100, y: 500, width: 220, height: 30 });
        f = (await doc.listFormFields()).find((x) => x.name === 'person.name')!;
        expect(f.widgets[0]!.rect).toMatchObject({ x: 100, y: 500, width: 220, height: 30 });
        // Delete one radio option and a whole field.
        await doc.removeField('color', 1);
        const color = (await doc.listFormFields()).find((x) => x.name === 'color')!;
        expect(color.widgets.map((w) => w.exportValue)).toEqual(['red']);
        await doc.removeField('agree');
        expect((await doc.listFormFields()).some((x) => x.name === 'agree')).toBe(false);
        expect(await code(doc.updateField('missing', { required: true }))).toBe('invalidArgument');
        expect(await code(doc.updateField('agree2', { multiline: true }))).toBe('invalidArgument');
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        expect((await again.listFormFields()).length).toBe((await doc.listFormFields()).length);
        doc.dispose();
        again.dispose();
      });
      it('lists fields with types, flags, options and widgets @FR-FRM-01 @FR-FRM-02', async () => {
        const doc = await open('acroform');
        expect((await doc.getMeta()).hasAcroForm).toBe(true);
        const fields = await doc.listFormFields();
        const by = Object.fromEntries(fields.map((f) => [f.name, f]));
        expect(Object.keys(by).sort()).toEqual([
          'agree',
          'code',
          'color',
          'country',
          'langs',
          'notes',
          'person.name',
          'ref',
          'submit',
        ]);
        expect(by['person.name']).toMatchObject({
          type: 'text',
          value: '',
          label: 'Your first and last name',
          readOnly: false,
          multiline: false,
        });
        expect(by['person.name']!.widgets[0]).toMatchObject({ page: 0 });
        expect(Math.abs(by['person.name']!.widgets[0]!.rect.width - 220)).toBeLessThan(2.5);
        expect(by['notes']).toMatchObject({ type: 'text', multiline: true });
        expect(by['code']).toMatchObject({ type: 'text', comb: true });
        expect(by['ref']).toMatchObject({ type: 'text', value: 'R-0042', readOnly: true });
        expect(by['agree']).toMatchObject({ type: 'checkbox', value: 'Off' });
        expect(by['color']).toMatchObject({ type: 'radio', value: 'Off' });
        expect(by['color']!.widgets.map((w) => w.exportValue)).toEqual(['red', 'blue']);
        expect(by['country']).toMatchObject({ type: 'dropdown' });
        expect(by['country']!.options!.map((o) => o.label)).toEqual(['Italy', 'France', 'Spain']);
        expect(by['langs']).toMatchObject({ type: 'listbox', multiSelect: true, values: [] });
        expect(by['submit']).toMatchObject({ type: 'button', readOnly: true });
        doc.dispose();
        const pre = await open('acroform-prefilled');
        const pf = Object.fromEntries((await pre.listFormFields()).map((f) => [f.name, f.value]));
        expect(pf).toMatchObject({
          'person.name': 'Marta Esempio',
          agree: 'Yes',
          color: 'red',
          country: 'Italy',
        });
        pre.dispose();
      });

      it('fills every field type and the values are readable by another tool @FR-FRM-01', async () => {
        const doc = await open('acroform');
        await doc.setFieldValue('person.name', 'Luca Prova');
        await doc.setFieldValue('notes', 'First line\nSecond line');
        await doc.setFieldValue('code', 'AB12');
        await doc.setFieldValue('agree', true);
        await doc.setFieldValue('color', 'blue');
        await doc.setFieldValue('country', 'France');
        await doc.setFieldValue('langs', ['EN', 'DE']);
        const now = Object.fromEntries((await doc.listFormFields()).map((f) => [f.name, f]));
        expect(now['person.name']!.value).toBe('Luca Prova');
        expect(now['notes']!.value).toBe('First line\nSecond line');
        expect(now['agree']!.value).toBe('Yes');
        expect(now['color']!.value).toBe('blue');
        expect(now['country']!.value).toBe('France');
        expect(now['langs']!.values).toEqual(['EN', 'DE']);
        const bytes = await doc.save();
        await valid(bytes);
        if (caps.realPdf) {
          await expect(bytes).toHaveFieldValue('person.name', 'Luca Prova');
          await expect(bytes).toHaveFieldValue('agree', 'Yes');
          await expect(bytes).toHaveFieldValue('color', 'blue');
          await expect(bytes).toHaveFieldValue('country', 'France');
          await expect(bytes).toHaveFieldValue('code', 'AB12');
        }
        // Appearance streams were regenerated: the text is visible without form rendering.
        const again = await engine.open(bytes);
        if (caps.realPdf) {
          const { pdftoppm } = await import('@folio/testkit');
          const img = await pdftoppm(bytes, 1);
          expect(inkRatio(img, { x: 74, y: 792 - 700, width: 100, height: 18 })).toBeGreaterThan(0.03);
        }
        // Unchecking and changing the radio choice work too.
        await again.setFieldValue('agree', false);
        await again.setFieldValue('color', 'red');
        await again.setFieldValue('person.name', '');
        const back = Object.fromEntries((await again.listFormFields()).map((f) => [f.name, f.value]));
        expect(back).toMatchObject({ agree: 'Off', color: 'red', 'person.name': '' });
        doc.dispose();
        again.dispose();
      });

      it('honours max length and rejects invalid writes @FR-FRM-03', async () => {
        const doc = await open('acroform');
        await doc.setFieldValue('code', 'ABCDEFGHIJ');
        expect((await doc.listFormFields()).find((f) => f.name === 'code')!.value).toBe('ABCDEF');
        expect(await code(doc.setFieldValue('ref', 'x'))).toBe('invalidArgument');
        expect(await code(doc.setFieldValue('nope', 'x'))).toBe('invalidArgument');
        expect(await code(doc.setFieldValue('country', 'Atlantis'))).toBe('invalidArgument');
        expect(await code(doc.setFieldValue('color', 'green'))).toBe('invalidArgument');
        expect(await code(doc.setFieldValue('submit', 'x'))).toBe('invalidArgument');
        doc.dispose();
      });

      it('detects XFA forms and signature fields @FR-FRM-09 @FR-APP-11', async () => {
        const xfa = await open('xfa');
        expect(await xfa.getMeta()).toMatchObject({ hasXfa: true, hasAcroForm: true });
        xfa.dispose();
        const signed = await open('signed');
        expect((await signed.listFormFields()).map((f) => [f.type, f.readOnly])).toEqual([
          ['signature', true],
        ]);
        signed.dispose();
      });

      it('renames a field @FR-MRG-02', async () => {
        const doc = await open('acroform');
        expect(await doc.renameField('person.name', 'name_2')).toBe('person.name_2');
        const names = (await doc.listFormFields()).map((f) => f.name);
        expect(names).toContain('person.name_2');
        expect(names).not.toContain('person.name');
        await valid(await doc.save());
        doc.dispose();
      });

      it('flattens the form: values stay visible, fields are gone @FR-FRM-05 @FR-OPT-06', async () => {
        const doc = await open('acroform');
        await doc.setFieldValue('person.name', 'Luca Prova');
        await doc.setFieldValue('agree', true);
        await doc.flattenForm();
        expect(await doc.listFormFields()).toEqual([]);
        const bytes = await doc.save();
        await valid(bytes);
        const again = await engine.open(bytes);
        expect(await again.listFormFields()).toEqual([]);
        expect((await again.getTextLayer(0)).text).toContain('Luca Prova');
        again.dispose();
        doc.dispose();
      });
    });

    describe('page content objects', () => {
      it('describes how an image is stored @FR-OPT-01', async () => {
        const doc = await open('images');
        const images = (await doc.listObjects(0)).filter((o) => o.type === 'image');
        expect(images.length).toBeGreaterThanOrEqual(2);
        for (const img of images) {
          expect(img.imageInfo!.byteSize).toBeGreaterThan(0);
          expect([1, 8, 24, 32]).toContain(img.imageInfo!.bitsPerPixel);
          expect(img.imageInfo!.filters.length).toBeGreaterThan(0);
        }
        expect(images.some((i) => i.imageInfo!.filters.includes('DCTDecode'))).toBe(true);
        expect((await doc.listObjects(0)).filter((o) => o.type !== 'image').every((o) => o.imageInfo === undefined)).toBe(true);
        doc.dispose();
      });
      it('lists objects with type, bounds and text @FR-EDT-07', async () => {
        const doc = await open('images');
        const objs = await doc.listObjects(0);
        expect(objs.map((o) => o.type)).toEqual(['text', 'image', 'image']);
        expect(objs[0]!.text).toBe('Two images below');
        expect(objs[1]!.bounds).toMatchObject({ x: 72, y: 560 });
        expect(objs[1]!.bounds.width).toBeCloseTo(180, 0);
        expect(objs[1]!.imageSize).toEqual({ width: 120, height: 80 });
        doc.dispose();
      });

      it('replaces text reusing the original font when its glyphs exist @FR-EDT-02', async () => {
        const doc = await open('invoice');
        const layer = await doc.getTextLayer(0);
        const run = layer.runs.find((r) => r.text === 'Invoce')!;
        const res = await doc.replaceTextRun(0, run.objId!, 'Invoice');
        expect(res.font).toEqual({ kind: 'reused', fontName: run.font.name });
        expect(res.warnings).toEqual([]);
        expect(res.width).toBeGreaterThan(run.rect.width);
        const after = await doc.getTextLayer(0);
        const edited = after.runs.find((r) => r.text === 'Invoice')!;
        expect(edited.origin).toEqual(run.origin);
        expect(edited.fontSize).toBeCloseTo(run.fontSize, 2);
        expect(edited.color).toEqual(run.color);
        expect(after.text).not.toContain('Invoce');
        const bytes = await doc.save();
        await valid(bytes);
        if (caps.realPdf) {
          await expect(bytes).toContainText(['Invoice', 'Design services']);
        }
        doc.dispose();
      });

      it('substitutes a bundled font when the subset lacks a glyph, and reports it @FR-EDT-02', async () => {
        const doc = await open('subset-font');
        const run = (await doc.getTextLayer(0)).runs.find((r) => r.text === 'Invoce')!;
        // "i" exists in the subset (used in "Payment is due within thirty days"): reuse.
        const reuse = await doc.replaceTextRun(0, run.objId!, 'Invoice');
        expect(reuse.font.kind).toBe('reused');
        // "X" and "Z" were never drawn with this font: substitute the whole run.
        const sub = await doc.replaceTextRun(0, reuse.objId, 'InvoiceXZ');
        expect(sub.font).toEqual({ kind: 'substituted', from: run.font.name, to: 'Liberation Serif' });
        const after = await doc.getTextLayer(0);
        const edited = after.runs.find((r) => r.text === 'InvoiceXZ')!;
        expect(edited.origin.x).toBeCloseTo(run.origin.x, 1);
        expect(edited.origin.y).toBeCloseTo(run.origin.y, 1);
        expect(edited.fontSize).toBeCloseTo(24, 1);
        expect(after.text).not.toMatch(/Invoce|Invoice\r/);
        const bytes = await doc.save();
        await valid(bytes);
        if (caps.realPdf) await expect(bytes).toContainText('InvoiceXZ');
        doc.dispose();
      });

      it('applies an explicit style and refuses rotated text @FR-EDT-03 @FR-EDT-01', async () => {
        const doc = await open('invoice');
        const run = (await doc.getTextLayer(0)).runs.find((r) => r.text === 'No. 2026-014')!;
        const res = await doc.replaceTextRun(0, run.objId!, 'No. 2026-015', {
          fontFamily: 'mono',
          bold: true,
          color: { r: 0, g: 100, b: 0 },
        });
        expect(res.font).toMatchObject({ kind: 'substituted', to: 'Liberation Mono' });
        const edited = (await doc.getTextLayer(0)).runs.find((r) => r.text === 'No. 2026-015')!;
        expect(edited.color).toMatchObject({ r: 0, g: 100, b: 0 });
        expect(edited.font.name).toMatch(/Mono/);
        doc.dispose();
        const rot = await open('rotated-text');
        const tilted = (await rot.getTextLayer(0)).runs.find((r) => r.text === 'Tilted text')!;
        expect(await code(rot.replaceTextRun(0, tilted.objId!, 'x'))).toBe('unsupportedFeature');
        expect(await code(rot.replaceTextRun(0, 'o99', 'x'))).toBe('invalidArgument');
        expect(await code(rot.replaceTextRun(0, 'bad', 'x'))).toBe('invalidArgument');
        rot.dispose();
      });

      it('adds text as page content with bundled fonts @FR-EDT-06', async () => {
        const doc = await open('text');
        const id = await doc.addText(0, {
          text: 'Added – ĄĘ €',
          origin: { x: 100, y: 300 },
          fontSize: 16,
          fontFamily: 'serif',
          italic: true,
          color: { r: 10, g: 20, b: 200 },
        });
        const run = (await doc.getTextLayer(0)).runs.find((r) => r.objId === id)!;
        expect(run.text).toBe('Added – ĄĘ €');
        expect(run.fontSize).toBeCloseTo(16, 1);
        expect(run.origin.x).toBeCloseTo(100, 1);
        expect(run.color).toMatchObject({ r: 10, g: 20, b: 200 });
        expect(await code(doc.addText(0, { text: '', origin: { x: 0, y: 0 } }))).toBe('invalidArgument');
        const bytes = await doc.save();
        await valid(bytes);
        if (caps.realPdf) await expect(bytes).toContainText('Added – ĄĘ €');
        doc.dispose();
      });

      it('inserts, reads back, replaces, transforms and removes images @FR-EDT-07', async () => {
        const doc = await open('text');
        const raster = sampleRaster(40, 20, 9);
        const id = await doc.addImage(0, {
          image: raster,
          rect: { x: 100, y: 200, width: 200, height: 100 },
        });
        let obj = (await doc.listObjects(0)).find((o) => o.id === id)!;
        expect(obj).toMatchObject({ type: 'image', imageSize: { width: 40, height: 20 } });
        expect(obj.bounds).toMatchObject({ x: 100, y: 200, width: 200, height: 100 });
        const back = await doc.getImage(0, id);
        expect([back.width, back.height]).toEqual([40, 20]);
        expect(Math.abs(back.data[0]! - raster.data[0]!)).toBeLessThan(3);
        await doc.replaceImage(0, id, sampleRaster(10, 10, 2));
        expect((await doc.listObjects(0)).find((o) => o.id === id)!.imageSize).toEqual({
          width: 10,
          height: 10,
        });
        await doc.transformObject(0, id, [0.5, 0, 0, 0.5, 50, 0]);
        obj = (await doc.listObjects(0)).find((o) => o.id === id)!;
        expect(obj.bounds).toMatchObject({ x: 100, y: 100, width: 100, height: 50 });
        const jpegId = await doc.addImage(0, {
          image: { jpeg: (await import('@folio/testkit')).sampleJpeg(30, 30), width: 30, height: 30 },
          rect: { x: 400, y: 200, width: 60, height: 60 },
          angle: 45,
        });
        const jpegObj = (await doc.listObjects(0)).find((o) => o.id === jpegId)!;
        expect(jpegObj.bounds.width).toBeCloseTo(60 * Math.SQRT2, 0);
        await valid(await doc.save());
        const count = (await doc.listObjects(0)).length;
        await doc.removeObject(0, id);
        expect((await doc.listObjects(0)).length).toBe(count - 1);
        expect(await code(doc.getImage(0, 'o0'))).toBe('invalidArgument');
        expect(
          await code(doc.addImage(0, { image: raster, rect: { x: 0, y: 0, width: 0, height: 5 } })),
        ).toBe('invalidArgument');
        doc.dispose();
      });

      it('adds a cover rectangle and truly removes objects @FR-EDT-05', async () => {
        const doc = await open('invoice');
        const run = (await doc.getTextLayer(0)).runs.find((r) => r.text.startsWith('Total due'))!;
        await doc.addRect(0, { rect: run.rect, fill: { r: 255, g: 255, b: 255 } });
        const img = await doc.render(0, { scale: 1 });
        expect(isBlank({ ...img, data: img.data })).toBe(false);
        expect(
          inkRatio(img, {
            x: run.rect.x + 2,
            y: 792 - run.rect.y - run.rect.height + 2,
            width: run.rect.width - 4,
            height: run.rect.height - 4,
          }),
        ).toBe(0);
        // Covered text is still in the file until the object is removed.
        expect((await doc.getTextLayer(0)).text).toContain('Total due');
        await doc.removeObject(0, run.objId!);
        expect((await doc.getTextLayer(0)).text).not.toContain('Total due');
        const bytes = await doc.save();
        await valid(bytes);
        if (caps.realPdf) {
          const { pdftotext } = await import('@folio/testkit');
          expect(await pdftotext(bytes)).not.toContain('Total due');
        }
        expect(await code(doc.addRect(0, { rect: { x: 0, y: 0, width: 0, height: 0 } }))).toBe(
          'invalidArgument',
        );
        doc.dispose();
      });
    });

    describe('robustness', () => {
      it('rejects out-of-range and non-integer page indexes with a typed error, never a raw one', async () => {
        const doc = await open('text');
        for (const bad of [-1, 3, 99, 1.5, Number.NaN]) {
          expect(await code(doc.getPageInfo(bad)), `getPageInfo(${bad})`).toBe('invalidArgument');
          expect(await code(doc.getTextLayer(bad)), `getTextLayer(${bad})`).toBe('invalidArgument');
          expect(await code(doc.listAnnotations(bad)), `listAnnotations(${bad})`).toBe('invalidArgument');
          expect(await code(doc.render(bad, { scale: 1 })), `render(${bad})`).toBe('invalidArgument');
          expect(await code(doc.rotatePages([bad], 90)), `rotatePages(${bad})`).toBe('invalidArgument');
        }
        expect(doc.pageCount).toBe(3);
        expect(await markers(doc)).toEqual([1, 2, 3]);
        doc.dispose();
      });

      it('refuses rotations other than 90, 180 and 270 and leaves the page untouched', async () => {
        const doc = await open('text');
        for (const deg of [45, 100, 1, 0, -90, 360, Number.NaN])
          expect(await code(doc.rotatePages([0], deg as 90)), `${deg}`).toBe('invalidArgument');
        expect((await doc.getPageInfo(0)).rotation).toBe(0);
        doc.dispose();
      });

      it('dispose is idempotent and a disposed document refuses every operation with a typed error', async () => {
        const doc = await open('text');
        doc.dispose();
        expect(() => doc.dispose()).not.toThrow();
        expect(await code(doc.render(0, { scale: 1 }))).toBe('invalidArgument');
        expect(await code(doc.save())).toBe('invalidArgument');
        expect(await code(doc.getTextLayer(0))).toBe('invalidArgument');
        expect(await code(doc.rotatePages([0], 90))).toBe('invalidArgument');
      });

      it('survives repeated open/dispose cycles without exhausting memory', async () => {
        const bytes = await fixture('text');
        for (let i = 0; i < 60; i++) {
          const doc = await engine.open(bytes);
          await doc.render(0, { scale: 0.3 });
          doc.dispose();
        }
        const doc = await open('invoice');
        expect((await doc.render(0, { scale: 1 })).width).toBeGreaterThan(0);
        doc.dispose();
      });

      it('gives the same answers when operations on one document overlap', async () => {
        const doc = await open('text');
        const serial: string[] = [];
        for (let i = 0; i < 3; i++) serial.push((await doc.getTextLayer(i)).text);
        const [a, b, c] = await Promise.all([doc.getTextLayer(0), doc.getTextLayer(1), doc.getTextLayer(2)]);
        expect([a.text, b.text, c.text]).toEqual(serial);
        const renders = await Promise.all([0, 1, 2, 0].map((i) => doc.render(i, { scale: 0.5 })));
        expect(renders[0]!.data).toEqual(renders[3]!.data);
        expect(renders.every((r) => !isBlank(r))).toBe(true);
        doc.dispose();
      });

      it('keeps two documents independent', async () => {
        const a = await open('text');
        const b = await open('text');
        await a.deletePages([0]);
        await a.rotatePages([0], 90);
        expect([a.pageCount, b.pageCount]).toEqual([2, 3]);
        expect((await b.getPageInfo(0)).rotation).toBe(0);
        a.dispose();
        expect((await b.render(0, { scale: 0.5 })).width).toBeGreaterThan(0);
        b.dispose();
      });

      it('answers every input that is not a PDF with InvalidPdf', async () => {
        const inputs: Array<[string, Uint8Array]> = [
          ['empty', new Uint8Array(0)],
          ['one byte', new Uint8Array([0x25])],
          ['header only', new TextEncoder().encode('%PDF-1.7\n')],
          ['header and EOF only', new TextEncoder().encode('%PDF-1.7\n%%EOF\n')],
          ['zeros', new Uint8Array(4096)],
          ['html', new TextEncoder().encode('<!doctype html><title>x</title>')],
          ['png signature', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
        ];
        for (const [what, bytes] of inputs) expect(await code(engine.open(bytes)), what).toBe('invalidPdf');
      });

      it('never throws a raw error on truncated files: it opens in recovery mode or says InvalidPdf', async () => {
        const full = await fixture('invoice');
        for (let k = 1; k < 16; k++) {
          const cut = Math.floor((full.length * k) / 16);
          let doc: PdfDocument | undefined;
          try {
            doc = await engine.open(full.slice(0, cut));
            // Whatever opened must be usable.
            expect(doc.pageCount).toBeGreaterThanOrEqual(0);
            if (doc.pageCount > 0) await doc.getTextLayer(0);
          } catch (e) {
            expect(e instanceof FolioError, `cut at ${cut}: ${String(e)}`).toBe(true);
            expect(['invalidPdf', 'io', 'unsupportedFeature']).toContain((e as FolioError).code);
          } finally {
            doc?.dispose();
          }
        }
      });

      it('survives random byte corruption: typed errors only, and the engine stays usable (seeded fuzz)', async () => {
        const full = await fixture('invoice');
        let seed = 0x5eed1234;
        const rnd = (): number => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 2 ** 32;
        };
        let opened = 0;
        for (let round = 0; round < 40; round++) {
          const bytes = full.slice();
          for (let i = 0; i < 1 + Math.floor(rnd() * 24); i++)
            bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
          let doc: PdfDocument | undefined;
          try {
            doc = await engine.open(bytes);
            opened++;
            if (doc.pageCount > 0) {
              await doc.getPageInfo(0);
              await doc.getTextLayer(0);
              await doc.render(0, { scale: 0.3 });
              await doc.listAnnotations(0);
            }
          } catch (e) {
            expect(e instanceof FolioError, `round ${round}: ${String(e)}`).toBe(true);
          } finally {
            doc?.dispose();
          }
        }
        expect(opened).toBeGreaterThan(0);
        const doc = await open('text');
        expect(await markers(doc)).toEqual([1, 2, 3]);
        doc.dispose();
      });
    });
  });
}
