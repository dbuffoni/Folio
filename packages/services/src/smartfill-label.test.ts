import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@folio/ai';
import { flatFormDoc, sharedEngine, NodeCrypto, NodeImageCodec } from '@folio/testkit';
import { SmartFillService, tokenSetRatio, type SmartCandidate, type SmartProfile } from './smartfill.ts';

const profile: SmartProfile = {
  id: 'p',
  name: 'Family',
  fields: [
    { key: 'first_name', label: 'First name', type: 'text', value: 'Marta', sensitive: false, aliases: ['nome'] },
    { key: 'last_name', label: 'Last name', type: 'text', value: 'Esempio', sensitive: false, aliases: ['cognome'] },
    { key: 'father', label: 'Father', type: 'text', value: 'Luca Esempio', sensitive: false, aliases: ['genitore di', 'padre di', 'tutore di', 'tutore legale di'] },
    { key: 'mother', label: 'Mother', type: 'text', value: 'Anna Rossi', sensitive: false, aliases: ['madre di'] },
  ],
};
const cand = (label: string): SmartCandidate => ({ ref: 'r', page: 0, rect: { x: 0, y: 0, width: 100, height: 14 }, kind: 'detected', fieldType: 'text', label });
const svc = new SmartFillService({} as never);
const keyFor = (label: string): string | null => svc.heuristic([cand(label)], profile)[0]!.profileKey;

describe('Smart Fill heuristic: a label that contains an alias phrase @FR-AIF-07', () => {
  it("matches the alias 'tutore legale di' inside a longer printed label @FR-AIF-07", () => {
    expect(keyFor("genitore o tutore legale dell'alunno/a")).toBe('father');
    expect(keyFor('genitore o tutore legale dell’alunno/a')).toBe('father');
    expect(tokenSetRatio('x', 'y')).toBe(0);
  });
  it('keeps other labels apart from the new containment rule @FR-AIF-07', () => {
    expect(keyFor('Nome del padre')).not.toBe('first_name');
    expect(keyFor('madre di')).toBe('mother');
    expect(keyFor('Firma')).toBeNull();
    expect(keyFor('Cognome')).toBe('last_name');
  });
});

describe('Smart Fill: the AI answers null for a label that names an alias @FR-AIF-07 @FR-AIF-03', () => {
  it("still maps 'genitore o tutore legale dell'alunno/a' to Father when the model gives no key", async () => {
    const ai = new FakeAiProvider();
    const engine = await sharedEngine();
    const crypto = new NodeCrypto();
    const mappings = { find: async () => null, save: async () => undefined, forget: async () => undefined };
    const sf = new SmartFillService({ crypto, forms: {} as never, annotations: {} as never, stamps: {} as never, mappings, ai, images: new NodeImageCodec() });
    const { pdf } = await flatFormDoc([
      { key: 'first_name', label: 'First name', kind: 'underline' },
      { key: 'father', label: "genitore o tutore legale dell'alunno/a", kind: 'underscores' },
    ]);
    const doc = await engine.open(pdf);
    ai.enqueue((req) => ({
      fields: req.candidates.map((c) => ({ ref: c.ref, label: c.label ?? '', fieldType: 'text', profileKey: null, transform: 'none', choiceValue: null, confidence: 0.3 })),
      newAreas: [],
    }));
    const res = await sf.analyze(doc, [0], profile, { useAi: true, mode: 'mapping_only' });
    expect(res.source).toBe('ai');
    const father = res.suggestions.find((s) => /tutore/.test(s.label));
    expect(father).toMatchObject({ profileKey: 'father', value: 'Luca Esempio' });
  });
});
