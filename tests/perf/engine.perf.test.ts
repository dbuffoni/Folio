// Performance budgets that can be measured headlessly (SPEC §14). Budgets are the NFR values with a
// CI allowance: shared runners are slower and noisier than the reference laptop.
import { describe, expect, it } from 'vitest';
import { bigDoc, fixture, sharedEngine } from '@folio/testkit';

const ALLOWANCE = process.env.CI ? 4 : 2;
const ms = async (fn: () => Promise<unknown>): Promise<number> => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('engine performance budgets', () => {
  it('opens a 100-page document and shows its first page within 1 s @NFR-02', async () => {
    const engine = await sharedEngine();
    const bytes = await bigDoc(100);
    await (await engine.open(bytes)).dispose(); // warm the module
    let doc!: Awaited<ReturnType<typeof engine.open>>;
    const t = await ms(async () => {
      doc = await engine.open(bytes);
      await doc.render(0, { scale: 1.5 });
    });
    doc.dispose();
    expect(t).toBeLessThan(1000 * ALLOWANCE);
  });

  it('rotates and deletes pages within 150 ms, commits a text edit within 300 ms @NFR-04', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await bigDoc(100));
    const rotate: number[] = [];
    for (let i = 0; i < 5; i++) rotate.push(await ms(() => doc.rotatePages([i], 90)));
    const del: number[] = [];
    for (let i = 0; i < 5; i++) del.push(await ms(() => doc.deletePages([doc.pageCount - 1])));
    doc.dispose();
    expect(median(rotate)).toBeLessThan(150 * ALLOWANCE);
    expect(median(del)).toBeLessThan(150 * ALLOWANCE);

    const inv = await engine.open(await fixture('subset-font'));
    const layer = await inv.getTextLayer(0);
    const run = layer.runs.find((r) => r.text.includes('Invoce'))!;
    const edit = await ms(() => inv.replaceTextRun(0, run.objId!, 'Invoice'));
    inv.dispose();
    expect(edit).toBeLessThan(300 * ALLOWANCE);
  });

  it('renders visible pages fast enough for smooth scrolling @NFR-03', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await bigDoc(100));
    const times: number[] = [];
    for (let i = 10; i < 30; i++) times.push(await ms(() => doc.render(i, { scale: 1.5 })));
    doc.dispose();
    // A page must be ready well inside the 100 ms blank-flash budget.
    expect(median(times)).toBeLessThan(100 * ALLOWANCE);
  });

  it('keeps memory bounded while paging through a long document @NFR-05', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await bigDoc(100));
    for (let i = 0; i < 20; i++) await doc.render(i, { scale: 1 });
    globalThis.gc?.();
    const before = process.memoryUsage().rss;
    for (let round = 0; round < 3; round++) for (let i = 0; i < 100; i++) await doc.render(i, { scale: 1 });
    globalThis.gc?.();
    const grown = (process.memoryUsage().rss - before) / (1 << 20);
    doc.dispose();
    expect(grown).toBeLessThan(150);
  });
});
