import { describe, expect, it } from 'vitest';
import { fixture } from '@folio/testkit';
import { FieldDetectionService } from './index.ts';
import { openFixture } from './testing.ts';

describe('Dotted leaders of word-processor forms @FR-FRM-15 @FR-FRM-07', () => {
  it('each "label ………" line becomes a text field named after the words before it', async () => {
    const { engine } = await openFixture('text');
    const doc = await engine.open(await fixture('dotted-form'));
    const out = await new FieldDetectionService({}).detect(doc, [0], { useAi: false });
    expect(out.proposals.map((p) => [p.type, p.label])).toEqual([
      ['text', 'Il/la sottoscritto/a'],
      ['text', 'codice fiscale'],
      ['text', 'Numero di telefono'],
    ]);
    // The field covers the leader, not the label.
    for (const p of out.proposals) expect(p.rect.width).toBeGreaterThan(150);
    expect(out.notice).toBeUndefined();
  });
});
