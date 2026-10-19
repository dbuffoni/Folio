import { describe, expect, it } from 'vitest';
import type { Rect } from '@folio/ports';
import { FormAuthoringService } from './index.ts';
import { openFixture } from './testing.ts';

const svc = new FormAuthoringService();
const page: Rect = { x: 0, y: 0, width: 612, height: 792 };
const TYPES = [
  'text',
  'multiline',
  'checkbox',
  'radio',
  'dropdown',
  'listbox',
  'button',
  'signature',
] as const;

describe('Form authoring edge cases @FR-FRM-08 @FR-FRM-11 @FR-FRM-16', () => {
  it('every field type gets a default name that is unique and starts with its kind @FR-FRM-08', () => {
    const taken = new Set<string>();
    for (const t of TYPES) {
      const a = svc.autoName(t, undefined, taken);
      taken.add(a);
      const b = svc.autoName(t, undefined, taken);
      expect(b).not.toBe(a);
      expect(a).toMatch(/\d+$/);
    }
    expect(taken.size).toBe(TYPES.length);
  });

  it('blocks authoring on XFA and encrypted files with distinct reasons @FR-FRM-09 @FR-FRM-17', () => {
    expect(svc.blocked({ hasXfa: false, isEncrypted: true })).not.toBeNull();
    expect(svc.blocked({ hasXfa: true, isEncrypted: true })).not.toBeNull();
    expect(svc.blocked({ hasXfa: true, isEncrypted: false })).toBe('xfa');
    expect(svc.blocked({ hasXfa: false, isEncrypted: true })).not.toBe('xfa');
  });

  it('default sizes keep every field type inside the page, also at the corners @FR-FRM-08', () => {
    for (const t of TYPES) {
      for (const at of [
        { x: 0, y: 0 },
        { x: 612, y: 792 },
        { x: 306, y: 396 },
        { x: -50, y: 900 },
      ]) {
        const r = svc.rectFor(t, at, null, page);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(612.001);
        expect(r.y + r.height).toBeLessThanOrEqual(792.001);
        expect(r.width).toBeGreaterThan(0);
        expect(r.height).toBeGreaterThan(0);
      }
    }
  });

  it('a drag outside the page is clipped and never produces an empty rectangle @FR-FRM-08', () => {
    const r = svc.rectFor('text', { x: 600, y: 780 }, { x: 900, y: 1000 }, page);
    expect(r.x + r.width).toBeLessThanOrEqual(612.001);
    expect(r.y + r.height).toBeLessThanOrEqual(792.001);
    expect(r.width).toBeGreaterThan(0);
  });

  it('arrow-key nudges move 1 pt, Shift 10 pt, and stop at the page edge @FR-FRM-16', () => {
    const r = { x: 600, y: 780, width: 10, height: 10 };
    expect(svc.nudge(r, 1, 0, false, page)).toMatchObject({ x: 601 });
    expect(svc.nudge(r, 1, 0, true, page).x).toBe(602);
    expect(svc.nudge(r, 0, 1, true, page).y).toBe(782);
    expect(svc.nudge({ x: 0, y: 0, width: 10, height: 10 }, -1, -1, true, page)).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(svc.nudge(r, 0, 0, false, page)).toEqual(r);
  });

  it('names are validated: empty, dots at the ends, control characters and duplicates @FR-FRM-11', () => {
    const taken = new Set(['a']);
    for (const bad of ['', '   ', '.a', 'a.', 'a..b', 'a'])
      expect(() => svc.validName(bad, taken), JSON.stringify(bad)).toThrow();
    expect(svc.validName('A', taken)).toBe('A');
    expect(svc.validName('a', taken, 'a')).toBe('a');
    expect(svc.validName('  b  ', taken)).toBe('b');
  });

  it('choice fields keep their options through update; a dropdown can become a list box @FR-FRM-11 @FR-FRM-16', async () => {
    const { doc, history } = await openFixture('acroform');
    const before = (await doc.listFormFields()).map((f) => f.name).sort();
    await history.execute(
      svc.create([
        {
          ...svc.spec('dropdown', 'colour', 0, { x: 300, y: 600, width: 120, height: 20 }),
          options: [
            { label: 'red', value: 'r' },
            { label: 'green', value: 'g' },
          ],
        },
      ]),
    );
    let f = (await doc.listFormFields()).find((x) => x.name === 'colour')!;
    expect(f).toBeTruthy();
    expect(f.options?.map((o) => o.label)).toEqual(['red', 'green']);
    expect(svc.compatible(f)).toEqual(['listbox']);
    await history.execute(svc.update(f, { tooltip: 'Pick one', readOnly: true }));
    f = (await doc.listFormFields()).find((x) => x.name === 'colour')!;
    expect(f).toMatchObject({ label: 'Pick one', readOnly: true });
    await history.undo();
    await history.undo();
    expect((await doc.listFormFields()).map((x) => x.name).sort()).toEqual(before);
  });

  it('text fields can get a maximum length and become multi-line, and undo restores them @FR-FRM-11 @FR-FRM-16', async () => {
    const { doc, history } = await openFixture('acroform');
    await history.execute(
      svc.create([svc.spec('text', 'pin_code', 0, { x: 300, y: 500, width: 100, height: 20 })]),
    );
    const f = (await doc.listFormFields()).find((x) => x.name === 'pin_code')!;
    await history.execute(svc.update(f, { maxLength: 8 }));
    const g = (await doc.listFormFields()).find((x) => x.name === 'pin_code')!;
    expect(g.maxLength).toBe(8);
    await history.execute(svc.update(g, { multiline: true }));
    expect((await doc.listFormFields()).find((x) => x.name === 'pin_code')!.multiline).toBe(true);
    await history.undo();
    expect((await doc.listFormFields()).find((x) => x.name === 'pin_code')!.multiline).toBeFalsy();
  });

  it('a radio group keeps its other options when one is deleted @FR-FRM-16', async () => {
    const { doc, history } = await openFixture('acroform');
    await history.execute(
      svc.create([
        svc.spec('radio', 'size', 0, { x: 100, y: 300, width: 14, height: 14 }),
        svc.spec('radio', 'size', 0, { x: 140, y: 300, width: 14, height: 14 }),
      ]),
    );
    const f = (await doc.listFormFields()).find((x) => x.name === 'size')!;
    expect(f.widgets).toHaveLength(2);
    await history.execute(svc.remove(f, 0));
    expect((await doc.listFormFields()).find((x) => x.name === 'size')!.widgets).toHaveLength(1);
    await history.undo();
    expect((await doc.listFormFields()).find((x) => x.name === 'size')!.widgets).toHaveLength(2);
    await history.execute(svc.remove(f));
    expect((await doc.listFormFields()).find((x) => x.name === 'size')).toBeUndefined();
  });
});
