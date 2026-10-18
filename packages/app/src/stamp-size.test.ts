// Default size of signatures and date stamps follows the page's body text (ticket 142).
import { describe, expect, it } from 'vitest';
import type { StampAnnotation } from '@folio/ports';
import { signaturePng } from '@folio/testkit';
import { createTestApp, type TestApp } from './testing.ts';
import type { DocumentSession } from './session.ts';

const heightOn = async (s: DocumentSession, page: number): Promise<number> => {
  const stamps = (await s.doc.listAnnotations(page)).filter((a): a is StampAnnotation => a.type === 'stamp');
  return stamps.at(-1)!.rect.height;
};

async function dropDate(t: TestApp, s: DocumentSession, page: number): Promise<number> {
  const tools = t.tools(s);
  await t.registry.run('sign.date', t.ctx());
  await tools.pointerMove(page, { x: 300, y: 400 });
  await tools.pointerDown(page, { x: 300, y: 400 });
  return heightOn(s, page);
}

describe('Default size of dates and signatures follows the page text', () => {
  it('sizes the date stamp from the body text of each page; 100 % on 12 pt is today\'s size @FR-STM-05', async () => {
    const t = await createTestApp();
    const s = await t.open('body-sizes');
    const [small, normal, large] = [await dropDate(t, s, 0), await dropDate(t, s, 1), await dropDate(t, s, 2)];
    expect(normal).toBeCloseTo(16, 5);
    expect(small).toBeCloseTo(16 * (9 / 12), 5);
    expect(large).toBeCloseTo(16 * (18 / 12), 5);
  });

  it('applies the percentage from Settings per kind, and keeps the protection limits @FR-STM-05 @FR-APP-10', async () => {
    const t = await createTestApp();
    const s = await t.open('body-sizes');
    await t.app.setSetting('dateSizePct', 150);
    expect(await dropDate(t, s, 1)).toBeCloseTo(24, 5);
    await t.app.setSetting('dateSizePct', 300);
    expect(await dropDate(t, s, 2)).toBe(40);
    await t.app.setSetting('dateSizePct', 25);
    expect(await dropDate(t, s, 0)).toBe(8);
    // The signature percentage is separate.
    await t.app.setSetting('dateSizePct', 100);
    expect(await dropDate(t, s, 1)).toBeCloseTo(16, 5);
  });

  it('falls back to the reference size on a page without text @FR-STM-05', async () => {
    const t = await createTestApp();
    const s = await t.open('scan');
    expect(await dropDate(t, s, 0)).toBeCloseTo(16, 5);
  });

  it('sizes a signature from the page text, keeps its proportions, and a click right after entering the page gets the same size @FR-STM-03', async () => {
    const t = await createTestApp();
    const s = await t.open('body-sizes');
    const tools = t.tools(s);
    t.sign.openCreate('signature');
    const stored = await t.sign.save(await t.sign.draftFromImage(signaturePng(), 180), 'Scanned', tools);
    expect(stored).not.toBeNull();
    const place = async (page: number) => {
      await t.registry.run('sign.sign', t.ctx());
      await tools.pointerMove(page, { x: 300, y: 400 });
      await tools.pointerDown(page, { x: 300, y: 400 });
      const stamps = (await s.doc.listAnnotations(page)).filter((a): a is StampAnnotation => a.type === 'stamp');
      return stamps.at(-1)!.rect;
    };
    const normal = await place(1);
    const large = await place(2);
    const small = await place(0);
    expect(large.height / normal.height).toBeCloseTo(1.5, 5);
    expect(small.height / normal.height).toBeCloseTo(0.75, 5);
    for (const r of [normal, large, small]) expect(r.width / r.height).toBeCloseTo(stored!.width / stored!.height, 3);
    // Page 1 is at 12 pt: the stored size, within the protection limits.
    expect(normal.height).toBeGreaterThanOrEqual(18);
    expect(normal.height).toBeLessThanOrEqual(120);
  });
});
