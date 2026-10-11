import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FolioError, type Command } from '@folio/core';
import { PageService, reorderedIndexes, selectParity, selectRange, toggle } from './page.ts';
import { markers, openFixture, shape } from './testing.ts';

describe('PageService', () => {
  it('summarises pages and flags odd sizes @FR-ORG-01', async () => {
    const { engine, doc } = await openFixture('mixed-sizes');
    const sum = await new PageService(engine).summarize(doc);
    expect(sum.map((p) => p.oddSize)).toEqual([false, true, true, true]);
    doc.dispose();
    const t = await openFixture('rotated-pages');
    const s2 = await new PageService(t.engine).summarize(t.doc);
    expect(s2.map((p) => p.rotation)).toEqual([0, 90, 180, 270]);
    expect(s2[1]!.displaySize).toEqual({ width: 792, height: 612 });
    expect(s2.filter((p) => p.oddSize).map((p) => p.index)).toEqual([1, 3]);
    t.doc.dispose();
  });

  it('selection helpers: range, parity, toggle @FR-ORG-02', () => {
    expect(selectRange(5, 2)).toEqual([2, 3, 4, 5]);
    expect(selectParity(5, 'odd')).toEqual([0, 2, 4]);
    expect(selectParity(5, 'even')).toEqual([1, 3]);
    expect(toggle([1, 3], 3)).toEqual([1]);
    expect(toggle([1, 3], 2)).toEqual([1, 2, 3]);
  });

  it('computes the order after a multi-page drag @FR-ORG-03', () => {
    expect(reorderedIndexes(6, [1, 4], 0)).toEqual([1, 4, 0, 2, 3, 5]);
    expect(reorderedIndexes(6, [1, 4], 6)).toEqual([0, 2, 3, 5, 1, 4]);
    expect(reorderedIndexes(6, [4, 1], 3)).toEqual([0, 2, 1, 4, 3, 5]);
    expect(reorderedIndexes(3, [1], 1)).toEqual([0, 1, 2]);
  });

  it('reorders by drop position and by keyboard nudge, with undo @FR-ORG-03', async () => {
    const { engine, doc, history } = await openFixture('text-25');
    const svc = new PageService(engine);
    const landed = await history.execute(svc.reorder(doc, [0, 2, 24], 5));
    expect((await markers(doc)).slice(0, 8)).toEqual([2, 4, 5, 1, 3, 25, 6, 7]);
    expect(landed).toEqual([3, 4, 5]);
    await history.execute(svc.nudge(doc, [3, 4, 5], -1)!);
    expect((await markers(doc)).slice(0, 7)).toEqual([2, 4, 1, 3, 25, 5, 6]);
    expect(svc.nudge(doc, [0], -1)).toBeNull();
    expect(svc.nudge(doc, [24], 1)).toBeNull();
    await history.undo();
    await history.undo();
    expect(await markers(doc)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    await history.redo();
    expect((await markers(doc)).slice(0, 6)).toEqual([2, 4, 5, 1, 3, 25]);
    doc.dispose();
  });

  it('rotates with a true inverse and coalesces repeated turns @FR-ORG-04', async () => {
    const { engine, doc, history } = await openFixture('text');
    const svc = new PageService(engine);
    await history.execute(svc.rotate(doc, [0, 2], 90));
    await history.execute(svc.rotate(doc, [0, 2], 90));
    expect((await doc.getPageInfo(0)).rotation).toBe(180);
    expect(history.state.done.length).toBe(1);
    expect(history.checkpoints.count).toBe(0);
    await history.undo();
    expect([(await doc.getPageInfo(0)).rotation, (await doc.getPageInfo(1)).rotation, (await doc.getPageInfo(2)).rotation]).toEqual([0, 0, 0]);
    await history.execute(svc.rotate(doc, [1], 270));
    expect((await doc.getPageInfo(1)).rotation).toBe(270);
    doc.dispose();
  });

  it('deletes with undo and refuses to delete every page @FR-ORG-05', async () => {
    const { engine, doc, history } = await openFixture('text');
    const svc = new PageService(engine);
    await history.execute(svc.delete(doc, [0, 2]));
    expect(await markers(doc)).toEqual([2]);
    expect(() => svc.delete(doc, [0])).toThrow(FolioError);
    await history.undo();
    expect(await markers(doc)).toEqual([1, 2, 3]);
    expect(() => svc.delete(doc, [])).toThrow(FolioError);
    expect(() => svc.delete(doc, [9])).toThrow(FolioError);
    doc.dispose();
  });

  it('duplicates pages next to their originals @FR-ORG-06', async () => {
    const { engine, doc, history } = await openFixture('text');
    const copies = await history.execute(new PageService(engine).duplicate(doc, [0, 2]));
    expect(await markers(doc)).toEqual([1, 1, 2, 3, 3]);
    expect(copies).toEqual([1, 4]);
    await history.undo();
    expect(await markers(doc)).toEqual([1, 2, 3]);
    await expect(await (async () => { await history.redo(); return doc.save(); })()).toBeValidPdf();
    doc.dispose();
  });

  it('inserts blank pages with neighbour, preset and custom sizes @FR-ORG-07', async () => {
    const { engine, doc, history } = await openFixture('mixed-sizes');
    const svc = new PageService(engine);
    expect(await svc.blankSize(doc, 2, { kind: 'neighbour' })).toEqual({ width: 792, height: 612 });
    expect(await svc.blankSize(doc, 0, { kind: 'preset', name: 'A3', landscape: true })).toEqual({ width: 1190.55, height: 841.89 });
    const size = await svc.blankSize(doc, 0, { kind: 'custom', size: { width: 200, height: 400 } });
    expect(await history.execute(svc.insertBlank(doc, 4, size))).toBe(4);
    expect((await doc.getPageInfo(4)).size).toEqual({ width: 200, height: 400 });
    await history.undo();
    expect(doc.pageCount).toBe(4);
    expect(() => svc.insertBlank(doc, 0, { width: 10, height: 10 })).toThrow(FolioError);
    expect(() => svc.insertBlank(doc, 9, { width: 100, height: 100 })).toThrow(FolioError);
    doc.dispose();
  });

  it('inserts a page range from another document @FR-ORG-08', async () => {
    const { engine, doc, history } = await openFixture('text');
    const other = await openFixture('rotated-pages');
    const at = await history.execute(new PageService(engine).insertFrom(doc, other.doc, [1, 3], 1));
    expect(at).toEqual([1, 2]);
    expect(await markers(doc)).toEqual([1, 0, 0, 2, 3]);
    expect((await doc.getPageInfo(2)).rotation).toBe(270);
    expect(other.doc.pageCount).toBe(4);
    await history.undo();
    expect(await markers(doc)).toEqual([1, 2, 3]);
    await history.redo();
    await expect(await doc.save()).toBeValidPdf();
    doc.dispose();
    other.doc.dispose();
  });

  it('extracts pages to a new document, optionally removing them from the source @FR-ORG-09', async () => {
    const { engine, doc, history } = await openFixture('text-25');
    const svc = new PageService(engine);
    const out = await svc.extract(doc, [4, 1]);
    expect(await markers(out)).toEqual([5, 2]);
    expect(doc.pageCount).toBe(25);
    await history.execute(svc.delete(doc, [4, 1]));
    expect(doc.pageCount).toBe(23);
    const bytes = await out.save();
    await expect(bytes).toBeValidPdf();
    await expect(bytes).toHavePageCount(2);
    out.dispose();
    doc.dispose();
  });

  it('replaces pages with pages from another file @FR-ORG-10', async () => {
    const { engine, doc, history } = await openFixture('text');
    const other = await openFixture('mixed-sizes');
    await history.execute(new PageService(engine).replace(doc, [0, 1, 2], other.doc, [3]));
    expect(doc.pageCount).toBe(1);
    expect((await doc.getPageInfo(0)).size).toEqual({ width: 300, height: 200 });
    await history.undo();
    expect(await markers(doc)).toEqual([1, 2, 3]);
    doc.dispose();
    other.doc.dispose();
  });

  it('any sequence of page operations is undone exactly, in order (property) @FR-APP-05 @FR-ORG-03', async () => {
    const op = fc.oneof(
      fc.record({ k: fc.constant('rotate' as const), a: fc.nat(), deg: fc.constantFrom(90 as const, 180 as const, 270 as const) }),
      fc.record({ k: fc.constant('delete' as const), a: fc.nat() }),
      fc.record({ k: fc.constant('duplicate' as const), a: fc.nat() }),
      fc.record({ k: fc.constant('move' as const), a: fc.nat(), b: fc.nat() }),
      fc.record({ k: fc.constant('blank' as const), a: fc.nat() }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 6 }), async (ops) => {
        const { engine, doc, history } = await openFixture('text');
        const svc = new PageService(engine);
        const states = [await shape(doc)];
        let applied = 0;
        for (const o of ops) {
          const n = doc.pageCount;
          let cmd: Command | null = null;
          if (o.k === 'rotate') cmd = svc.rotate(doc, [o.a % n], o.deg);
          else if (o.k === 'delete') cmd = n > 1 ? svc.delete(doc, [o.a % n]) : null;
          else if (o.k === 'duplicate') cmd = svc.duplicate(doc, [o.a % n]);
          else if (o.k === 'move') cmd = svc.reorder(doc, [o.a % n], o.b % (n + 1));
          else cmd = svc.insertBlank(doc, o.a % (n + 1), { width: 200, height: 300 });
          if (!cmd) continue;
          const before = history.state.done.length;
          await history.execute(cmd);
          // Coalesced commands share a history entry: only record a state when a new entry appears.
          if (history.state.done.length > before) states.push(await shape(doc));
          else states[states.length - 1] = await shape(doc);
          applied++;
        }
        const final = states[states.length - 1]!;
        for (let k = states.length - 2; k >= 0; k--) {
          expect(await history.undo()).toBe(true);
          if (k === 0) expect(await shape(doc)).toBe(states[0]);
        }
        expect(history.state.canUndo).toBe(false);
        expect(history.dirty).toBe(false);
        while (await history.redo()) {
          /* replay */
        }
        if (applied > 0) expect(await shape(doc)).toBe(final);
        doc.dispose();
      }),
      { numRuns: 25 },
    );
  });
});
