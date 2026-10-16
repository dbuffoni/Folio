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
  }
});
