// Snapshot tool: the clipboard write is requested inside the user gesture, before the render finishes.
import { expect, firstPage, openPdf, test, tool } from './helpers.ts';

test('snapshot asks the clipboard first and hands it the image when ready @FR-OPT-04', async ({ app }) => {
  await app.evaluate(() => {
    const w = window as unknown as { __clip: { promised: boolean; type: string }[] };
    w.__clip = [];
    class FakeItem {
      constructor(readonly data: Record<string, unknown>) {}
      get types(): string[] {
        return Object.keys(this.data);
      }
    }
    (window as unknown as { ClipboardItem: unknown }).ClipboardItem = FakeItem;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items: FakeItem[]) => {
          const value = items[0]!.data['image/png'];
          w.__clip.push({ promised: value instanceof Promise, type: (await value as Blob).type });
        },
        writeText: async () => undefined,
        read: async () => [],
      },
    });
  });
  await openPdf(app, 'invoice.pdf');
  await tool(app, 'Snapshot').click();
  const box = (await firstPage(app).boundingBox())!;
  await app.mouse.move(box.x + 60, box.y + 60);
  await app.mouse.down();
  await app.mouse.move(box.x + 260, box.y + 200, { steps: 5 });
  await app.mouse.up();
  await expect(app.getByText('Snapshot copied to the clipboard')).toBeVisible();
  const log = await app.evaluate(() => (window as unknown as { __clip: unknown[] }).__clip);
  expect(log).toEqual([{ promised: true, type: 'image/png' }]);
});
