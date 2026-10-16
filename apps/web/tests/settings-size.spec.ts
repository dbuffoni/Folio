// The Settings window keeps its size and position when another section is chosen.
import { expect, test } from './helpers.ts';

test('Settings keeps the same size and position for every section @FR-APP-10', async ({ app }) => {
  await app.getByRole('button', { name: 'Settings' }).click();
  const dialog = app.getByRole('dialog', { name: 'Settings' });
  const nav = dialog.getByRole('navigation', { name: 'Settings' });
  const buttons = nav.getByRole('button');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(3);
  let first: { x: number; y: number; width: number; height: number } | null = null;
  for (let i = 0; i < count; i++) {
    await buttons.nth(i).click();
    const box = (await dialog.boundingBox())!;
    first ??= box;
    expect(box).toEqual(first);
    // The scrollbar of a long section never covers its controls: they end before the scrollable edge.
    const overlap = await dialog.evaluate((el) => {
      const pane = el.querySelector('.setpane')!;
      const edge = pane.getBoundingClientRect().left + pane.clientWidth;
      const right = Math.max(...[...pane.querySelectorAll('input, select, button, textarea')].map((c) => c.getBoundingClientRect().right));
      return right - edge;
    });
    expect(overlap).toBeLessThanOrEqual(-8);
  }
});
