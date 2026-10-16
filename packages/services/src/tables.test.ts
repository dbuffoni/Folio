import { describe, expect, it } from 'vitest';
import { AiError, grid, toCsv, toTsv } from '@folio/core';
import { FakeAiProvider } from '@folio/ai';
import { NodeImageCodec, TABLE_TRUTH, fixture, sharedEngine } from '@folio/testkit';
import { TableService } from './tables.ts';

const open = async (name = 'tables') => (await sharedEngine()).open(await fixture(name));

describe('Extract tables @FR-OPT-12', () => {
  it('a ruled table gives its cells, a two-line cell becomes one cell, numbers stay as printed @FR-OPT-12', async () => {
    const doc = await open();
    const out = await new TableService({}).extractLocal(doc, 0, TABLE_TRUTH.ruledArea);
    expect(out).toMatchObject({ source: 'local', ruled: true, skippedRotated: false });
    expect(out!.rows).toEqual(TABLE_TRUTH.ruled);
  });

  it('a table without lines is found from alignment and gaps; the paragraph above is not part of it @FR-OPT-12', async () => {
    const doc = await open();
    const out = await new TableService({}).extractLocal(doc, 1, TABLE_TRUTH.plainArea);
    expect(out).toMatchObject({ ruled: false });
    expect(out!.rows).toEqual(TABLE_TRUTH.plain);
    // The whole page: the paragraph is a one-cell line above the table; the cells are still intact.
    const page = await new TableService({}).extractLocal(doc, 1, null);
    expect(page!.rows).toEqual(TABLE_TRUTH.plain);
  });

  it('nothing in the area gives null; rotated text is left out and reported @FR-OPT-12', async () => {
    const doc = await open();
    expect(await new TableService({}).extractLocal(doc, 0, { x: 0, y: 0, width: 50, height: 40 })).toBeNull();
    const rotated = await open('rotated-text');
    const out = await new TableService({}).extractLocal(rotated, 0, null);
    expect(out === null || out.skippedRotated).toBe(true);
  });

  it('writes RFC 4180 CSV: quotes, delimiters, line breaks, BOM and the semicolon variant @FR-OPT-12', () => {
    const rows = [['Name', 'Note'], ['Rossi, Marta', 'said "hi"'], ['multi\nline', '1,250.00'], ['', '€ 3,20']];
    const csv = toCsv(rows);
    expect(csv).toBe('Name,Note\r\n"Rossi, Marta","said ""hi"""\r\n"multi\nline","1,250.00"\r\n,"€ 3,20"\r\n');
    expect(toCsv(rows, { delimiter: ';' })).toContain('Name;Note\r\n');
    expect(toCsv(rows, { delimiter: ';' })).toContain('Rossi, Marta;');
    expect(toCsv(rows, { bom: true }).charCodeAt(0)).toBe(0xfeff);
    expect(toCsv([])).toBe('');
    expect(toTsv(rows)).toBe('Name\tNote\nRossi, Marta\tsaid "hi"\nmulti line\t1,250.00\n\t€ 3,20');
    const bytes = new TableService({}).csv(rows, { bom: true });
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TableService({}).fileName('Report.pdf', 2)).toBe('Report page 3 table.csv');
  });

  it('grid edits: cells, merge and split columns, delete, header move @FR-OPT-12', () => {
    let g = TABLE_TRUTH.ruled.map((r) => [...r]);
    g = grid.setCell(g, 1, 0, 'Widget XL');
    expect(g[1]![0]).toBe('Widget XL');
    g = grid.mergeColumns(g, 0);
    expect(g[0]).toEqual(['Item Qty', 'Price']);
    g = grid.splitColumn(g, 0);
    expect(g[0]).toEqual(['Item', 'Qty', 'Price']);
    expect(grid.deleteColumn(g, 1)[0]).toEqual(['Item', 'Price']);
    expect(grid.deleteRow(g, 0)[0]).toEqual(g[1]);
    expect(grid.moveRow(g, 3, 0)[0]![0]).toBe('Total');
    expect(grid.square([['a'], ['b', 'c']])).toEqual([['a', ''], ['b', 'c']]);
  });

  it('AI path: a recorded answer fills the grid; only the area image is sent; errors surface @FR-OPT-12', async () => {
    const doc = await (await sharedEngine()).open(await fixture('scanned-text'));
    const ai = new FakeAiProvider();
    ai.enqueueTable({ rows: [['Item', 'Qty'], ['Pen', 3], [' Ink ', null], ['', '']] as unknown as string[][] });
    const svc = new TableService({ ai, images: new NodeImageCodec() });
    const out = await svc.extractAi(doc, 0, { x: 72, y: 500, width: 300, height: 200 });
    expect(out).toMatchObject({ source: 'ai', rows: [['Item', 'Qty'], ['Pen', '3'], ['Ink', '']] });
    expect(ai.tableRequests).toEqual([{ page: 0, width: expect.any(Number), height: expect.any(Number) }]);
    expect(ai.tableRequests[0]!.width / ai.tableRequests[0]!.height).toBeCloseTo(300 / 200, 1);
    ai.enqueueTable(new AiError('rateLimited'));
    await expect(svc.extractAi(doc, 0, null)).rejects.toBeInstanceOf(AiError);
    ai.configured = false;
    await expect(svc.extractAi(doc, 0, null)).rejects.toMatchObject({ code: 'invalidArgument' });
  });
});
