import { describe, expect, it } from 'vitest';
import { createTestApp } from './testing.ts';

describe('Bookmark editor @FR-EDT-11', () => {
  it('add at the current page, rename, nest, move, retarget and delete with Undo @FR-EDT-11', async () => {
    const t = await createTestApp();
    const s = await t.open('bookmarks');
    const om = t.outline(s);
    await om.load();
    expect(om.tree.map((n) => n.title)).toEqual(['Chapter 1', 'Chapter 2', 'Appendix – Ünïcode']);

    s.goToPage(2);
    om.select([0]);
    expect(await om.add('Third page')).toBe(true);
    // The new entry is a sibling right after the selection, at the page being looked at, and selected.
    expect(om.tree.map((n) => n.title)).toEqual(['Chapter 1', 'Third page', 'Chapter 2', 'Appendix – Ünïcode']);
    expect(om.tree[1]!.target).toMatchObject({ kind: 'page', page: 2 });
    expect(om.selected).toEqual([1]);
    expect(s.dirty).toBe(true);

    await om.move('indent');
    expect(om.tree[0]!.children.map((c) => c.title)).toEqual(['Section 1.1', 'Third page']);
    expect(om.selected).toEqual([0, 1]);
    await om.move('up');
    expect(om.tree[0]!.children.map((c) => c.title)).toEqual(['Third page', 'Section 1.1']);
    await om.move('outdent');
    expect(om.tree.map((n) => n.title)).toEqual(['Chapter 1', 'Third page', 'Chapter 2', 'Appendix – Ünïcode']);
    expect(await om.move('up', [0])).toBe(false);

    expect(await om.rename([1], '  Renamed  ')).toBe(true);
    expect(await om.rename([1], '   ')).toBe(false);
    expect(t.toastKeys()).toContain('error.invalidArgument.emptyBookmark');
    s.goToPage(4);
    await om.setTargetHere([1]);
    expect(om.tree[1]).toMatchObject({ title: 'Renamed', target: { kind: 'page', page: 4 } });

    // A bookmark with children asks first.
    t.prompts.confirmAnswers = [false];
    expect(await om.remove([0])).toBe(false);
    expect(t.prompts.asked).toContain('confirm:bookmarks.confirmDelete');
    t.prompts.confirmAnswers = [true];
    expect(await om.remove([0])).toBe(true);
    expect(om.tree.map((n) => n.title)).toEqual(['Renamed', 'Chapter 2', 'Appendix – Ünïcode']);

    // Seven edits, seven undo steps.
    for (let i = 0; i < 7; i++) expect(await s.undo()).toBe(true);
    await om.load();
    expect(om.tree.map((n) => n.title)).toEqual(['Chapter 1', 'Chapter 2', 'Appendix – Ünïcode']);
    expect(om.tree[0]!.children.map((c) => c.title)).toEqual(['Section 1.1']);
  });

  it('drag and drop, collapsed state and the warning for removed targets @FR-EDT-11 @FR-EDT-27', async () => {
    const t = await createTestApp();
    const s = await t.open('bookmarks');
    const om = t.outline(s);
    await om.load();
    expect(await om.drop([2], [0])).toBe(true);
    expect(om.tree.map((n) => n.title)).toEqual(['Appendix – Ünïcode', 'Chapter 1', 'Chapter 2']);
    expect(await om.drop([1], [1, 0])).toBe(false);
    expect(await om.drop([0], null)).toBe(true);
    expect(om.tree.map((n) => n.title)).toEqual(['Chapter 1', 'Chapter 2', 'Appendix – Ünïcode']);
    om.toggleCollapsed([0]);
    expect(om.collapsed.has('0')).toBe(true);

    // Delete Chapter 2's page (the 4th): the entry keeps its place and is flagged, nothing points past the end.
    const org = t.organise(s);
    await org.delete(3);
    await om.load();
    expect([...om.removed]).toEqual(['1']);
    expect(om.tree[1]!.title).toBe('Chapter 2');
    // Undo brings the page and the target back; the warning goes away.
    await s.undo();
    await om.load();
    expect(om.removed.size).toBe(0);
    expect(om.tree[1]!.target).toMatchObject({ kind: 'page', page: 3 });
  });

  it('a signed document asks before the first edit and the answer is respected @FR-EDT-11 @FR-APP-11', async () => {
    const t = await createTestApp();
    const s = await t.open('signed');
    const om = t.outline(s);
    expect(om.signed).toBe(true);
    t.prompts.confirmAnswers = [false];
    expect(await om.add('Nope')).toBe(false);
    expect(t.prompts.asked).toContain('confirm:signed.editConfirm');
    expect(s.dirty).toBe(false);
    t.prompts.confirmAnswers = [true];
    expect(await om.add('Yes')).toBe(true);
    expect(om.tree.map((n) => n.title)).toEqual(['Yes']);
  });
});
