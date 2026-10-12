// Error paths, boundaries and pure helpers of the services that the happy-path suites do not reach.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FolioError, type History } from '@folio/core';
import type { Annotation, PdfDocument, PdfEngine, Point, Quad, Rect, StampAnnotation } from '@folio/ports';
import {
  FIXTURE_PASSWORD,
  FakeClock,
  FakeFileService,
  NodeCrypto,
  fixture,
  sharedEngine,
} from '@folio/testkit';
import {
  AnnotationService,
  alignRects,
  constrainBox,
  constrainLine,
  distributeRects,
  moveAnnotation,
  resizeAnnotation,
  snapRect,
} from './annotation.ts';
import { DocumentService } from './document.ts';
import {
  SignatureService,
  contentBounds,
  cropRaster,
  cropToContent,
  placeAt,
  rasterizeVector,
  removeBackground,
  resizeLocked,
  simplify,
  svgToVector,
  vectorFromStrokes,
  vectorToSvg,
} from './signature.ts';
import { openFixture } from './testing.ts';

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof FolioError
      ? `${e.code}${e.params.reason ? `:${e.params.reason}` : ''}`
      : `raw:${String(e)}`;
  }
};
const clock = new FakeClock();
let seq = 0;
const annots = () =>
  new AnnotationService({ author: () => 'Marta', now: () => clock.now(), newId: () => `r-${++seq}` });
/** The geometry-bearing fields of the annotation kinds the helpers transform, without narrowing by type. */
type Geo = { rect: Rect; quads: Quad[]; start: Point; end: Point; paths: Point[][]; vertices: Point[] };
const geo = (a: Annotation): Geo => a as unknown as Geo;
const R = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const note = (x = 100, y = 100, extra: Partial<Annotation> = {}): Annotation =>
  ({ type: 'text', rect: R(x, y, 20, 20), contents: 'n', ...extra }) as Annotation;

describe('DocumentService.serialize verification @FR-APP-04', () => {
  const setup = async () => {
    const engine = await sharedEngine();
    const files = new FakeFileService();
    return {
      engine,
      files,
      svc: (e: PdfEngine = engine) => new DocumentService({ engine: e, files, crypto: new NodeCrypto() }),
    };
  };

  it('refuses to write a file that does not reopen, and leaves the target untouched', async () => {
    const { engine, files, svc } = await setup();
    const original = await fixture('text');
    const ref = files.put('/a.pdf', original);
    const { doc } = await svc().open(ref);
    const broken = { ...doc, save: async () => new Uint8Array([1, 2, 3, 4]) } as unknown as PdfDocument;
    expect(await codeOf(svc().save(broken, ref))).toBe('io');
    expect(files.writes).toEqual([]);
    expect(Buffer.from(files.get('/a.pdf')!).equals(Buffer.from(original))).toBe(true);
    void engine;
    doc.dispose();
  });

  it('refuses a save whose page count differs from the document', async () => {
    const { files, svc } = await setup();
    const { doc } = await svc().open(files.put('/a.pdf', await fixture('text')));
    const other = await fixture('mixed-sizes');
    const liar = Object.create(doc, { save: { value: async () => other } }) as PdfDocument;
    expect(await codeOf(svc().serialize(liar))).toBe('io');
    doc.dispose();
  });

  it('refuses a save whose first page cannot be rendered, and still disposes the check copy', async () => {
    const { engine, files, svc } = await setup();
    const { doc } = await svc().open(files.put('/a.pdf', await fixture('text')));
    let disposed = 0;
    const flaky: PdfEngine = {
      ...engine,
      open: async (bytes, o) => {
        const d = await engine.open(bytes, o);
        return Object.assign(Object.create(d), {
          render: async () => {
            throw new Error('render failed');
          },
          dispose: () => {
            disposed++;
            d.dispose();
          },
        }) as PdfDocument;
      },
    } as PdfEngine;
    expect(await codeOf(svc(flaky).serialize(doc))).toBe('io');
    expect(disposed).toBe(1);
    doc.dispose();
  });

  it('saves an encrypted document incrementally without needing the password again', async () => {
    const { files, svc } = await setup();
    const ref = files.put('/enc.pdf', await fixture('encrypted'));
    const { doc } = await svc().open(ref, { password: FIXTURE_PASSWORD });
    await doc.upsertAnnotation(0, { type: 'text', rect: R(50, 50, 20, 20), contents: 'x' });
    const res = await svc().save(doc, ref, { incremental: true, backup: false });
    expect(res.byteSize).toBeGreaterThan(0);
    const again = await svc().open(ref, { password: FIXTURE_PASSWORD });
    expect((await again.doc.listAnnotations(0)).some((a) => a.contents === 'x')).toBe(true);
    again.doc.dispose();
    doc.dispose();
  });

  it('reports a read failure as an io error, not a raw exception', async () => {
    const { svc } = await setup();
    expect(await codeOf(svc().open({ id: '/nope.pdf', name: 'nope.pdf', path: '/nope.pdf' }))).toBe('io');
  });

  it('describes mixed page sizes in the properties, most common first', async () => {
    const { files, svc } = await setup();
    const { doc } = await svc().open(files.put('/m.pdf', await fixture('mixed-sizes')));
    const props = await svc().properties(doc, 1234);
    expect(props.byteSize).toBe(1234);
    expect(props.pageSizes.reduce((n, s) => n + s.count, 0)).toBe(doc.pageCount);
    expect(props.pageSizes.length).toBeGreaterThan(1);
    expect(props.pageSizes.map((s) => s.count)).toEqual(
      [...props.pageSizes.map((s) => s.count)].sort((a, b) => b - a),
    );
    expect(props.pageSizes.some((s) => s.landscape)).toBe(true);
    doc.dispose();
  });
});

describe('annotation geometry helpers @FR-ANN-06', () => {
  it('move and resize carry quads, line ends, vertices and ink paths along', () => {
    const quad = { p1: { x: 0, y: 10 }, p2: { x: 10, y: 10 }, p3: { x: 0, y: 0 }, p4: { x: 10, y: 0 } };
    const hl = {
      type: 'highlight',
      rect: R(0, 0, 10, 10),
      quads: [quad],
      color: { r: 1, g: 1, b: 0 },
    } as Annotation;
    const moved = geo(moveAnnotation(hl, 5, -3));
    expect(moved.rect).toEqual(R(5, -3, 10, 10));
    expect(moved.quads[0]!.p1).toEqual({ x: 5, y: 7 });
    expect(hl.rect.x).toBe(0); // input untouched

    const line = {
      type: 'line',
      rect: R(0, 0, 100, 50),
      start: { x: 0, y: 0 },
      end: { x: 100, y: 50 },
      strokeWidth: 1,
    } as Annotation;
    const bigger = geo(resizeAnnotation(line, R(10, 10, 200, 100)));
    expect(bigger.start).toEqual({ x: 10, y: 10 });
    expect(bigger.end).toEqual({ x: 210, y: 110 });

    const ink = {
      type: 'ink',
      rect: R(0, 0, 10, 10),
      paths: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      ],
    } as Annotation;
    expect(geo(resizeAnnotation(ink, R(0, 0, 20, 5))).paths[0]![1]).toEqual({ x: 20, y: 5 });
    const poly = {
      type: 'polyline',
      rect: R(0, 0, 10, 10),
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    } as Annotation;
    expect(geo(moveAnnotation(poly, 1, 1)).vertices[1]).toEqual({ x: 11, y: 11 });
  });

  it('resizing a zero-width box does not divide by zero', () => {
    const line = {
      type: 'line',
      rect: R(5, 0, 0, 50),
      start: { x: 5, y: 0 },
      end: { x: 5, y: 50 },
      strokeWidth: 1,
    } as Annotation;
    const out = geo(resizeAnnotation(line, R(5, 0, 30, 100)));
    expect(Number.isFinite(out.start.x) && Number.isFinite(out.end.y)).toBe(true);
  });

  it('constrains lines to 45° steps and boxes to squares in every quadrant', () => {
    expect(constrainLine({ x: 0, y: 0 }, { x: 100, y: 8 })).toMatchObject({ y: expect.closeTo(0, 5) });
    const d = constrainLine({ x: 0, y: 0 }, { x: 50, y: 60 });
    expect(d.x).toBeCloseTo(d.y, 5);
    expect(constrainBox({ x: 10, y: 10 }, { x: 30, y: 15 })).toEqual({ x: 30, y: 30 });
    expect(constrainBox({ x: 10, y: 10 }, { x: -20, y: 12 })).toEqual({ x: -20, y: 40 });
    expect(constrainBox({ x: 10, y: 10 }, { x: 10, y: 10 })).toEqual({ x: 10, y: 10 });
  });

  it('aligns on every edge and is a no-op for a single object', () => {
    const rs = [R(10, 10, 20, 20), R(50, 40, 10, 10), R(30, 0, 40, 5)];
    expect(alignRects(rs, 'left').map((r) => r.x)).toEqual([10, 10, 10]);
    expect(alignRects(rs, 'right').map((r) => r.x + r.width)).toEqual([70, 70, 70]);
    expect(alignRects(rs, 'center').map((r) => r.x + r.width / 2)).toEqual([40, 40, 40]);
    expect(alignRects(rs, 'bottom').map((r) => r.y)).toEqual([0, 0, 0]);
    expect(alignRects(rs, 'top').map((r) => r.y + r.height)).toEqual([50, 50, 50]);
    expect(alignRects(rs, 'middle').map((r) => r.y + r.height / 2)).toEqual([25, 25, 25]);
    expect(alignRects([rs[0]!], 'left')).toEqual([rs[0]]);
  });

  it('distributes equal gaps, keeps the outer two in place and ignores fewer than three', () => {
    const rs = [R(0, 0, 10, 10), R(15, 0, 10, 10), R(100, 0, 10, 10)];
    const out = distributeRects(rs, 'horizontal');
    expect([out[0]!.x, out[2]!.x]).toEqual([0, 100]);
    expect(out[1]!.x - (out[0]!.x + 10)).toBeCloseTo(out[2]!.x - (out[1]!.x + 10), 6);
    const unordered = distributeRects([rs[2]!, rs[0]!, rs[1]!], 'horizontal');
    expect(unordered[0]!.x).toBe(100);
    const vertical = distributeRects([R(0, 0, 5, 10), R(0, 5, 5, 10), R(0, 90, 5, 10)], 'vertical');
    expect(vertical[1]!.y).toBe(45);
    expect(distributeRects(rs.slice(0, 2), 'horizontal')).toEqual(rs.slice(0, 2));
  });

  it('distribute preserves every size and the set of positions is monotone (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.integer({ min: 0, max: 500 }), w: fc.integer({ min: 1, max: 40 }) }), {
          minLength: 3,
          maxLength: 8,
        }),
        (items) => {
          const rects = items.map((i) => R(i.x, 0, i.w, 10));
          const out = distributeRects(rects, 'horizontal');
          expect(out.map((r) => r.width)).toEqual(rects.map((r) => r.width));
          const sorted = [...out].sort((a, b) => a.x - b.x);
          for (let i = 1; i < sorted.length; i++)
            expect(sorted[i]!.x).toBeGreaterThanOrEqual(sorted[i - 1]!.x);
        },
      ),
    );
  });

  it('snaps to the nearest target within the threshold only, with guides', () => {
    const page = R(0, 0, 600, 800);
    const near = snapRect(R(97, 202, 20, 20), [R(120, 500, 10, 10)], page, 4);
    expect(near).toEqual({ dx: 3, dy: 0, guides: [{ axis: 'x', at: 120 }] }); // right edge 117 → 120; y not near anything
    expect(snapRect(R(190, 300, 20, 20), [], page).guides).toEqual([]);
    const centred = snapRect(R(291, 391, 20, 20), [], page, 4);
    expect([centred.dx, centred.dy]).toEqual([-1, -1]);
    const far = snapRect(R(50, 50, 20, 20), [R(300, 300, 10, 10)], page, 4);
    expect([far.dx, far.dy, far.guides.length]).toEqual([0, 0, 0]);
  });
});

describe('AnnotationService behaviour @FR-ANN-06 @FR-ANN-07 @FR-ANN-11', () => {
  it('rejects edits of locked annotations unless the edit unlocks them, and deletion of locked ones', () => {
    const svc = annots();
    const locked = { ...note(), id: 'a1', locked: true } as Annotation;
    expect(() => svc.update(0, locked, { ...locked, contents: 'new' })).toThrow(/locked/);
    expect(() => svc.update(0, locked, { ...locked, locked: false, contents: 'new' })).not.toThrow();
    expect(() => svc.update(0, { ...note() }, note())).toThrow(/no id/);
    expect(() => svc.remove([{ page: 0, annotation: locked }])).toThrow(/locked/);
    expect(() => svc.remove([])).toThrow(/Nothing selected/);
  });

  it('stamps author and dates on add, keeps the original creation date on update', async () => {
    const svc = annots();
    const { doc, history } = await openFixture('text');
    const ref = await history.execute(svc.add(0, note()));
    const [added] = await doc.listAnnotations(0);
    expect(added!.author).toBe('Marta');
    const created = added!.created;
    expect(created).toMatch(/^D:/);
    clock.advance?.(60_000);
    await history.execute(svc.update(0, added!, { ...added!, contents: 'edited' }));
    const [updated] = await doc.listAnnotations(0);
    expect(updated!.contents).toBe('edited');
    expect(updated!.created).toBe(created);
    expect(ref.id).toBe(added!.id);
    await history.undo();
    expect((await doc.listAnnotations(0))[0]!.contents).toBe('n');
    doc.dispose();
  });

  it('coalesces consecutive updates of one annotation into a single undo step', async () => {
    const svc = annots();
    const { doc, history } = await openFixture('text');
    await history.execute(svc.add(0, note()));
    let cur = (await doc.listAnnotations(0))[0]!;
    for (const x of [110, 120, 130, 140]) {
      await history.execute(svc.update(0, cur, moveAnnotation(cur, x - cur.rect.x, 0)));
      cur = (await doc.listAnnotations(0))[0]!;
    }
    expect(history.state.done).toHaveLength(2); // add + one coalesced move
    await history.undo();
    expect((await doc.listAnnotations(0))[0]!.rect.x).toBe(100);
    doc.dispose();
  });

  it('reorders z-order, returning null when nothing would change and throwing for unknown ids', async () => {
    const svc = annots();
    const { doc, history } = await openFixture('text');
    for (const x of [10, 60, 110]) await history.execute(svc.add(0, note(x, 10)));
    const order = (await doc.listAnnotations(0)).map((a) => a.id!);
    expect(svc.reorder(0, order, order[2]!, 'front')).toBeNull();
    expect(svc.reorder(0, order, order[0]!, 'back')).toBeNull();
    expect(svc.reorder(0, order, order[2]!, 'forward')).toBeNull();
    expect(svc.reorder(0, order, order[0]!, 'backward')).toBeNull();
    expect(() => svc.reorder(0, order, 'ghost', 'front')).toThrow(/Unknown annotation/);
    await history.execute(svc.reorder(0, order, order[0]!, 'front')!);
    expect((await doc.listAnnotations(0)).map((a) => a.id)).toEqual([order[1], order[2], order[0]]);
    await history.undo();
    expect((await doc.listAnnotations(0)).map((a) => a.id)).toEqual(order);
    doc.dispose();
  });

  it('lists with type, author and text filters and never lists links', async () => {
    const svc = annots();
    const { doc, history } = await openFixture('links');
    await history.execute(
      svc.add(0, { ...note(10, 10), contents: 'Pay the invoice', author: 'Ann' } as Annotation),
    );
    await history.execute(
      svc.add(0, { ...note(40, 10), contents: 'Check totals', author: 'Bob' } as Annotation),
    );
    const all = await svc.list(doc);
    expect(all.every((i) => i.annotation.type !== 'link')).toBe(true);
    expect(all).toHaveLength(2);
    expect(await svc.list(doc, { authors: ['Ann'] })).toHaveLength(1);
    expect(await svc.list(doc, { text: 'TOTALS' })).toHaveLength(1);
    expect(await svc.list(doc, { types: ['highlight'] })).toHaveLength(0);
    expect(await svc.list(doc, { pages: [1] })).toHaveLength(0);
    expect(svc.authors(all)).toEqual(['Ann', 'Bob']);
    doc.dispose();
  });

  it('hit-tests topmost first, skips hidden ones and measures lines by distance from the segment', () => {
    const svc = annots();
    const under = { ...note(0, 0), id: 'u', rect: R(0, 0, 50, 50) } as Annotation;
    const over = { ...note(0, 0), id: 'o', rect: R(10, 10, 20, 20) } as Annotation;
    expect(svc.hitTest([under, over], { x: 15, y: 15 })?.id).toBe('o');
    expect(svc.hitTest([under, { ...over, hidden: true }], { x: 15, y: 15 })?.id).toBe('u');
    expect(svc.hitTest([under], { x: 200, y: 200 })).toBeUndefined();
    const line = {
      type: 'line',
      id: 'l',
      rect: R(0, 0, 100, 100),
      start: { x: 0, y: 0 },
      end: { x: 100, y: 100 },
      strokeWidth: 1,
    } as Annotation;
    expect(svc.hitTest([line], { x: 50, y: 51 })?.id).toBe('l');
    expect(svc.hitTest([line], { x: 90, y: 10 })).toBeUndefined(); // inside the box, far from the segment
    const dot = {
      ...line,
      id: 'd',
      start: { x: 5, y: 5 },
      end: { x: 5, y: 5 },
      rect: R(0, 0, 10, 10),
    } as Annotation;
    expect(svc.hitTest([dot], { x: 5, y: 6 })?.id).toBe('d'); // zero-length segment must not produce NaN
  });

  it('round-trips the clipboard payload and rejects foreign text', () => {
    const svc = annots();
    const items = [
      { ...note(10, 10), id: 'keep' } as Annotation,
      { type: 'other', rect: R(0, 0, 1, 1) } as Annotation,
    ];
    const text = svc.serialize(items);
    expect(JSON.parse(text).items).toHaveLength(1); // foreign annotations are not copied
    expect(JSON.parse(text).items[0].id).toBeUndefined();
    const pasted = svc.deserialize(text, { x: 5, y: 5 });
    expect(pasted).toHaveLength(1);
    expect(pasted[0]!.rect).toEqual(R(15, 15, 20, 20));
    expect(pasted[0]!.id).toBeUndefined();
    for (const bad of [
      '',
      'hello',
      '{}',
      '[]',
      'null',
      JSON.stringify({ kind: 'folio/annotations', version: 2, items: [] }),
      JSON.stringify({ kind: 'folio/annotations', version: 1, items: 'x' }),
      JSON.stringify({ kind: 'folio/annotations', version: 1, items: [{ type: 3 }, null, { type: 'text' }] }),
    ]) {
      expect(svc.deserialize(bad), bad).toEqual([]);
    }
  });

  it('does not copy image stamps and unlocks pasted copies', () => {
    const svc = annots();
    const stamp = {
      type: 'stamp',
      rect: R(0, 0, 10, 10),
      appearance: { kind: 'image', image: { width: 1, height: 1, data: new Uint8ClampedArray(4) } },
    } as unknown as StampAnnotation;
    expect(JSON.parse(svc.serialize([stamp])).items).toEqual([]);
    const text = svc.serialize([{ ...note(), locked: true } as Annotation]);
    expect(svc.deserialize(text)[0]!.locked).toBe(false);
  });

  it('removing a stamp is undoable through a checkpoint', async () => {
    const svc = annots();
    const { doc, history } = await openFixture('text');
    await doc.upsertAnnotation(0, {
      type: 'stamp',
      rect: R(50, 50, 80, 30),
      appearance: {
        kind: 'vector',
        width: 80,
        height: 30,
        paths: [
          {
            segments: [
              { op: 'M', x: 0, y: 0 },
              { op: 'L', x: 80, y: 30 },
            ],
            stroke: { r: 0, g: 0, b: 0 },
            strokeWidth: 2,
          },
        ],
      },
    } as StampAnnotation);
    const [s] = await svc.list(doc);
    const cmd = svc.remove([s!]);
    expect(cmd.undo).toBe('checkpoint');
    await history.execute(cmd);
    expect(await doc.listAnnotations(0)).toHaveLength(0);
    await history.undo();
    expect(await doc.listAnnotations(0)).toHaveLength(1);
    doc.dispose();
  });
});

describe('signature helpers @FR-STM-01 @FR-STM-02', () => {
  it('simplifies a polyline within tolerance and keeps its endpoints (property)', () => {
    expect(simplify([], 1)).toEqual([]);
    expect(simplify([{ x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }]);
    const straight = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i * 2 }));
    expect(simplify(straight, 0.1)).toEqual([straight[0], straight[19]]);
    const same = [
      { x: 3, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 3 },
    ];
    expect(simplify(same, 0.5)).toHaveLength(2);
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.integer({ min: 0, max: 300 }), y: fc.integer({ min: 0, max: 100 }) }), {
          minLength: 2,
          maxLength: 60,
        }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        (pts, tol) => {
          const s = simplify(pts, tol);
          expect(s[0]).toEqual(pts[0]);
          expect(s[s.length - 1]).toEqual(pts[pts.length - 1]);
          expect(s.length).toBeLessThanOrEqual(pts.length);
        },
      ),
    );
  });

  it('rejects empty and single-point strokes', () => {
    expect(() => vectorFromStrokes([])).toThrow(/Draw your signature/);
    expect(() => vectorFromStrokes([[{ x: 1, y: 1 }]])).toThrow(/Draw your signature/);
    expect(() => annotsSig().fromStrokes([[]], 'signature')).toThrow(FolioError);
  });

  it('SVG export and import are inverse for what we draw, and foreign SVG is refused', () => {
    const v = vectorFromStrokes([
      [
        { x: 10, y: 10 },
        { x: 30, y: 40 },
        { x: 60, y: 15 },
        { x: 90, y: 50 },
      ],
      [
        { x: 15, y: 60 },
        { x: 80, y: 62 },
      ],
    ]);
    const svg = vectorToSvg(v);
    const back = svgToVector(svg)!;
    expect(back.paths).toHaveLength(2);
    expect([back.width, back.height]).toEqual([v.width, v.height]);
    const flat = (p: typeof v) =>
      p.paths.map((x) =>
        x.segments.map((s) =>
          'x' in s ? [s.op, Math.round(s.x * 100) / 100, Math.round(s.y * 100) / 100] : [s.op],
        ),
      );
    expect(flat(back)).toEqual(flat(v));
    expect(back.paths[0]!.strokeWidth).toBe(v.paths[0]!.strokeWidth);
    expect(svgToVector('<svg></svg>')).toBeNull();
    expect(svgToVector('<svg viewBox="0 0 10 10"></svg>')).toBeNull();
    expect(
      svgToVector(
        '<svg viewBox="0 0 10 10"><path d="M0 0Q5 5 10 10" stroke="rgb(0,0,0)" stroke-width="1"/></svg>',
      ),
    ).toBeNull();
    expect(
      svgToVector(
        '<svg viewBox="0 0 10 10"><path d="M0 0C1 1 2 2" stroke="rgb(0,0,0)" stroke-width="1"/></svg>',
      ),
    ).toBeNull();
  });

  it('SVG import ignores scripts and event handlers: only path data is read', () => {
    const hostile =
      '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><path d="M0 0L5 5" stroke="rgb(1,2,3)" stroke-width="2"/></svg>';
    const v = svgToVector(hostile)!;
    expect(v.paths).toHaveLength(1);
    expect(JSON.stringify(v)).not.toMatch(/alert|script/);
  });

  it('rasterises ink only where the pen went', () => {
    const v = vectorFromStrokes(
      [
        [
          { x: 5, y: 5 },
          { x: 45, y: 5 },
        ],
      ],
      { strokeWidth: 4 },
    );
    const img = rasterizeVector(v, 2);
    const b = contentBounds(img)!;
    expect(b).toBeTruthy();
    expect(b.width).toBeGreaterThan(b.height * 3);
    expect(rasterizeVector({ width: 10, height: 10, paths: [] }, 1).data.every((x) => x === 0)).toBe(true);
  });

  it('removes paper, finds ink bounds, crops with padding and refuses blank images', () => {
    const w = 20;
    const h = 10;
    const data = new Uint8ClampedArray(w * h * 4).fill(255); // white paper, opaque
    for (let y = 3; y < 6; y++) for (let x = 4; x < 12; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
    const cleaned = removeBackground({ width: w, height: h, data });
    expect(cleaned.data[3]).toBe(0); // paper
    expect(cleaned.data[(4 * w + 5) * 4 + 3]).toBe(255); // ink
    expect(contentBounds(cleaned)).toEqual({ x: 4, y: 3, width: 8, height: 3 });
    const cropped = cropToContent(cleaned, 1);
    expect([cropped.width, cropped.height]).toEqual([10, 5]);
    const edge = cropToContent(
      {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
      },
      5,
    );
    expect([edge.width, edge.height]).toEqual([2, 2]); // padding never leaves the image
    const blank = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    expect(contentBounds(blank)).toBeNull();
    expect(() => cropToContent(blank)).toThrow(/no visible ink/);
    expect(cropRaster(cleaned, { x: -5, y: -5, width: 1000, height: 1000 })).toMatchObject({
      width: w,
      height: h,
    });
    expect(
      removeBackground({ width: 1, height: 1, data: new Uint8ClampedArray([10, 10, 10, 255]) }, 0).data[3],
    ).toBe(0); // threshold clamps to 1: no NaN, no division by zero
  });

  it('places signatures inside the page and resizes with a locked aspect ratio from every corner', () => {
    const page = { width: 200, height: 100 };
    expect(placeAt({ x: 5, y: 5 }, { width: 50, height: 20 }, page)).toEqual(R(0, 0, 50, 20));
    expect(placeAt({ x: 199, y: 99 }, { width: 50, height: 20 }, page)).toEqual(R(150, 80, 50, 20));
    expect(placeAt({ x: 100, y: 50 }, { width: 500, height: 400 }, page)).toMatchObject({
      width: 200,
      height: 100,
    });
    const r = R(0, 0, 100, 50);
    for (const corner of [
      { x: 200, y: 100 },
      { x: -200, y: 100 },
      { x: 200, y: -100 },
      { x: -200, y: -100 },
      { x: 40, y: 400 },
    ]) {
      const out = resizeLocked(r, { x: 0, y: 0 }, corner);
      expect(out.width / out.height).toBeCloseTo(2, 6);
    }
    expect(resizeLocked(r, { x: 0, y: 0 }, { x: 0.5, y: 0.5 }).width).toBe(8); // never below the minimum
    const left = resizeLocked(r, { x: 100, y: 0 }, { x: 0, y: 25 });
    expect(left.x + left.width).toBe(100);
  });
});

function annotsSig(): SignatureService {
  return new SignatureService({
    fonts: async () => new Uint8Array(),
    images: {} as never,
    newId: () => 'x',
  } as never);
}

describe('History through a real document', () => {
  it('a failing engine call inside a checkpoint command leaves the document as it was @FR-APP-05', async () => {
    const { doc, history } = await openFixture('text');
    const before = doc.pageCount;
    await expect(
      history.execute({
        label: { key: 'test' },
        kind: 'structural',
        undo: 'checkpoint',
        apply: async ({ doc: d }) => {
          await d.deletePages([0]);
          await d.deletePages([99]); // out of range: engine throws
        },
      }),
    ).rejects.toThrow();
    expect(doc.pageCount).toBe(before);
    expect(history.state.canUndo).toBe(false);
    doc.dispose();
  });

  it('keeps the history usable after a document restore (many undo/redo cycles)', async () => {
    const { doc, history } = await openFixture('text');
    const h: History = history;
    for (let i = 0; i < 5; i++)
      await h.execute({
        label: { key: 't' },
        kind: 'structural',
        undo: 'checkpoint',
        apply: async ({ doc: d }) => void (await d.rotatePages([0], 90)),
      });
    for (let i = 0; i < 3; i++) {
      await h.goTo(0);
      expect((await doc.getPageInfo(0)).rotation).toBe(0);
      await h.goTo(5);
      expect((await doc.getPageInfo(0)).rotation).toBe(90); // 5 × 90° = 450° = 90°
    }
    doc.dispose();
  });
});
