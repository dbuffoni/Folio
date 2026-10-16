import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@folio/ai';
import { TABLE_TRUTH } from '@folio/testkit';
import { createTestApp } from './testing.ts';

describe('Extract table dialog model @FR-OPT-12', () => {
  it('the area tool opens the grid; edits, CSV with separator and BOM, and TSV on the clipboard @FR-OPT-12', async () => {
    const t = await createTestApp();
    const s = await t.open('tables');
    const m = t.tables(s);
    // Drawing a rectangle with the Extract table tool (view mode) hands the area to the model.
    t.tools(s).setTool('table');
    const a = TABLE_TRUTH.ruledArea;
    await t.tools(s).pointerDown(0, { x: a.x, y: a.y }, {});
    await t.tools(s).pointerMove(0, { x: a.x + a.width, y: a.y + a.height }, {});
    await t.tools(s).pointerUp(0, { x: a.x + a.width, y: a.y + a.height }, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(m.open).toBe(true);
    expect(m.rows).toEqual(TABLE_TRUTH.ruled);
    expect(m.ruled).toBe(true);

    m.setCell(1, 0, 'Widget, large');
    m.deleteRow(3);
    m.setOptions({ delimiter: ';', bom: true });
    t.files.nextSave.push('/out/table.csv');
    expect(await m.saveCsv()).toBe(true);
    const bytes = t.files.get('/out/table.csv')!;
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(text).toBe('\uFEFFItem;Qty;Price\r\nWidget, large;2;10.50\r\nGadget with a long name;5;3,20\r\n');
    expect(await m.copy()).toBe(true);
    expect(t.clipboard.text).toBe('Item\tQty\tPrice\nWidget, large\t2\t10.50\nGadget with a long name\t5\t3,20');
    expect(t.toastKeys()).toEqual(expect.arrayContaining(['toast.tableSaved', 'toast.tableCopied']));
  });

  it('whole page, nothing found, and AI with pre-flight; no AI without a vision model @FR-OPT-12', async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    const s = await t.open('scan');
    const m = t.tables(s);
    await m.extract(0, null);
    expect(m.empty).toBe(true);
    expect(await m.aiAvailable()).toBe(false);
    expect(await m.useAi()).toBe(false);
    expect(t.toastKeys()).toContain('ai.gate.noVision');
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true });
    expect(await m.aiAvailable()).toBe(true);
    ai.enqueueTable({ rows: [['Item', 'Qty'], ['Pen', '3']] });
    t.prompts.confirmAnswers = [false];
    expect(await m.useAi()).toBe(false);
    expect(ai.tableRequests.length).toBe(0);
    t.prompts.confirmAnswers = [true];
    expect(await m.useAi()).toBe(true);
    expect(m.rows).toEqual([['Item', 'Qty'], ['Pen', '3']]);
    expect(m.source).toBe('ai');
    expect(ai.tableRequests.length).toBe(1);
    m.mergeColumns(0);
    expect(m.rows[0]).toEqual(['Item Qty']);
    m.splitColumn(0);
    expect(m.rows[0]).toEqual(['Item', 'Qty']);
    m.close();
    expect(m.open).toBe(false);
  });
});
