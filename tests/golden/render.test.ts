// Golden images (SPEC §15): the first page of each fixture rendered by the engine, compared with a
// reviewed baseline. Regenerate deliberately with FOLIO_UPDATE_GOLDENS=1 and review the PNG diff.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, compareGolden, fixture, sharedEngine } from '@folio/testkit';

const dir = join(import.meta.dirname, 'baselines');
const CASES = ['text', 'invoice', 'subset-font', 'acroform', 'annotated', 'images', 'rotated-pages', 'unicode', 'flat-form'].filter((n) => n in FIXTURES);

describe('engine rendering matches the reviewed baselines', () => {
  it.each(CASES)('%s page 1 at 72 dpi @FR-VIEW-01', async (name) => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture(name));
    const result = await compareGolden(await doc.render(0, { scale: 1 }), join(dir, `${name}.png`), 0.005);
    doc.dispose();
    expect(result.pass, `difference ratio ${result.ratio}; see tests/golden/baselines/__diff__`).toBe(true);
  });

  it('text page with a quarter-turn view rotation @FR-VIEW-01', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture('text'));
    const result = await compareGolden(await doc.render(0, { scale: 1, rotation: 90 }), join(dir, 'text-rot90.png'), 0.005);
    doc.dispose();
    expect(result.pass).toBe(true);
  });
});
