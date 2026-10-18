// A zoomed page is a blurry whole-page bitmap with a sharp tile on top (ticket 143). The tile must be
// shown exactly 1:1: a stray global style once gave it a border and padding, so it shrank by about 3 %
// and the text jumped when scrolling stopped and the tile appeared.
import { expect, openPdf, test } from './helpers.ts';

test('the sharp tile of a zoomed page is drawn at its own size, without box styling @FR-VIEW-01', async ({ app }) => {
  await openPdf(app, 'text.pdf');
  for (let i = 0; i < 8; i++) {
    await app.keyboard.press('Control+=');
    await app.waitForTimeout(120);
  }
  const tile = app.locator('.pv canvas.sharp').first();
  await expect(tile).toBeAttached();
  // The tile exists only once its sharp render has been placed (it is hidden until then).
  await expect(tile).toBeVisible({ timeout: 20_000 });

  const m = await tile.evaluate((c: HTMLCanvasElement) => {
    const s = getComputedStyle(c);
    const r = c.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      pixelsW: c.width,
      pixelsH: c.height,
      box: [s.borderTopWidth, s.borderLeftWidth, s.paddingTop, s.paddingLeft, s.borderTopLeftRadius],
    };
  });
  expect(m.box, 'no border, padding or radius on the tile').toEqual(['0px', '0px', '0px', '0px', '0px']);
  // At 100 % device pixel ratio the tile is one bitmap pixel per CSS pixel.
  expect(m.width).toBeCloseTo(m.pixelsW / (await app.evaluate(() => Math.min(2, window.devicePixelRatio || 1))), 1);
  expect(m.height).toBeCloseTo(m.pixelsH / (await app.evaluate(() => Math.min(2, window.devicePixelRatio || 1))), 1);
});
