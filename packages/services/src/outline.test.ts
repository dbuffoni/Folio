import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { OutlineNode } from '@folio/ports';
import { OutlineService } from './outline.ts';
import { openFixture } from './testing.ts';

const svc = new OutlineService();
const titles = async (doc: { getOutline(): Promise<OutlineNode[]> }): Promise<unknown> =>
  (await doc.getOutline()).map((n) => [n.title, n.children.map((c) => c.title)]);

describe('OutlineService @FR-EDT-11', () => {
  it('every edit is one undoable step @FR-EDT-11', async () => {
    const { doc, history } = await openFixture('bookmarks');
    const start = await titles(doc);
    await history.execute(svc.add([], 3, '  Index  ', svc.viewTarget(4, { x: 0, y: 700 })));
    await history.execute(svc.rename([1], 'Chapter Two'));
    await history.execute(svc.move([1], { parent: [0], index: 1 }));
    await history.execute(svc.setTarget([0, 0], { kind: 'page', page: 2 }));
    await history.execute(svc.remove([0, 1]));
    expect(await titles(doc)).toEqual([['Chapter 1', ['Section 1.1']], ['Appendix – Ünïcode', []], ['Index', []]]);
    expect((await doc.getOutline())[0]!.children[0]!.target).toMatchObject({ kind: 'page', page: 2 });
    for (let i = 0; i < 5; i++) expect(await history.undo()).toBe(true);
    expect(await titles(doc)).toEqual(start);
    expect(await history.redo()).toBe(true);
    expect((await titles(doc) as unknown[]).length).toBe(4);
  });

  it('titles are trimmed, not empty and at most 512 characters @FR-EDT-11', () => {
    expect(svc.validTitle('  Résumé  ')).toBe('Résumé');
    expect(() => svc.validTitle('   ')).toThrow();
    expect(() => svc.validTitle('x'.repeat(513))).toThrow();
    expect(svc.validTitle('日本語'.repeat(100))).toHaveLength(300);
    expect(() => svc.rename([0], '')).toThrow();
    expect(() => svc.add([], 0, '')).toThrow();
  });

  it('plans keyboard moves: up, down, indent, outdent @FR-EDT-11', () => {
    const tree: OutlineNode[] = [
      { title: 'A', children: [{ title: 'A1', children: [] }, { title: 'A2', children: [] }] },
      { title: 'B', children: [] },
      { title: 'C', children: [] },
    ];
    expect(svc.planMove(tree, [0], 'up')).toBeNull();
    expect(svc.planMove(tree, [1], 'up')).toEqual({ parent: [], index: 0 });
    expect(svc.planMove(tree, [2], 'down')).toBeNull();
    expect(svc.planMove(tree, [0, 0], 'down')).toEqual({ parent: [0], index: 1 });
    expect(svc.planMove(tree, [1], 'indent')).toEqual({ parent: [0], index: 2 });
    expect(svc.planMove(tree, [0], 'indent')).toBeNull();
    expect(svc.planMove(tree, [0, 1], 'outdent')).toEqual({ parent: [], index: 1 });
    expect(svc.planMove(tree, [1], 'outdent')).toBeNull();
    expect(svc.planMove(tree, [9], 'up')).toBeNull();
    expect(svc.subtreeSize(tree, [0])).toBe(3);
    expect(svc.subtreeSize(tree, [5])).toBe(0);
    // Dropping an entry inside itself is refused; dropping at the end works.
    expect(svc.dropPosition([0], [0, 1], tree)).toBeNull();
    expect(svc.dropPosition([0], null, tree)).toEqual({ parent: [], index: 2 });
    expect(svc.dropPosition([0], [2], tree)).toEqual({ parent: [], index: 1 });
  });

  it('property: any sequence of moves keeps every entry exactly once @FR-EDT-11', async () => {
    const { engine } = await openFixture('text');
    const flat = (nodes: OutlineNode[]): string[] => nodes.flatMap((n) => [n.title, ...flat(n.children)]);
    const paths = (nodes: OutlineNode[], prefix: number[] = []): number[][] =>
      nodes.flatMap((n, k) => [[...prefix, k], ...paths(n.children, [...prefix, k])]);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(30), fc.constantFrom('up', 'down', 'indent', 'outdent' as const)), { maxLength: 12 }), async (steps) => {
        const doc = await engine.create();
        await doc.insertBlank(0, { width: 200, height: 200 });
        await doc.setOutline(['a', 'b', 'c', 'd'].map((t) => ({ title: t, target: { kind: 'page', page: 0 }, children: t === 'b' ? [{ title: 'b1', target: { kind: 'page', page: 0 }, children: [] }] : [] })));
        const before = flat(await doc.getOutline()).sort();
        for (const [pick, intent] of steps) {
          const tree = await doc.getOutline();
          const all = paths(tree);
          const path = all[pick % all.length]!;
          const to = svc.planMove(tree, path, intent as 'up');
          if (to) await doc.editOutline({ op: 'move', path, parent: to.parent, index: to.index });
        }
        expect(flat(await doc.getOutline()).sort()).toEqual(before);
        doc.dispose();
      }),
      { numRuns: 25 },
    );
  });

  it('reports entries whose page was deleted and none points past the last page @FR-EDT-27', async () => {
    const { doc, history } = await openFixture('bookmarks');
    expect(svc.issues(await doc.getOutline())).toEqual([]);
    // Chapter 2 points at page 4: remove it, and move page 1 to the end.
    await history.execute({ label: { key: 'cmd.deletePages' }, kind: 'structural', undo: 'checkpoint', async apply({ doc: d, invalidate }) { await d.deletePages([3]); invalidate({ kind: 'structure' }); } });
    const tree = await doc.getOutline();
    expect(svc.issues(tree)).toEqual([{ path: [1], kind: 'targetRemoved' }]);
    const walk = (n: OutlineNode[]): void => n.forEach((x) => { if (x.target?.kind === 'page') expect(x.target.page).toBeLessThan(doc.pageCount); walk(x.children); });
    walk(tree);
    // Setting the target again clears the warning.
    await history.execute(svc.setTarget([1], { kind: 'page', page: 2 }));
    expect(svc.issues(await doc.getOutline())).toEqual([]);
  });
});
