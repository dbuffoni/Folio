import { describe, expect, it } from 'vitest';
import { AiError, History, NetworkError } from '@folio/core';
import { FakeAiProvider } from '@folio/ai';
import { DataCipher, FormMappingRepo, PROFILE_TEMPLATES, AiRunsRepo, ProfileRepo, migrate } from '@folio/db';
import type { FreeTextAnnotation, PdfDocument } from '@folio/ports';
import { FORMS_CORPUS, FakeClock, FakeSecretStore, InMemoryDatabase, NodeCrypto, NodeImageCodec, PERSON, corpusForm, fixture, flatFormDoc, injectionForm, pdfcpuFormFields, sharedEngine } from '@folio/testkit';
import { AnnotationService } from './annotation.ts';
import { FormService } from './form.ts';
import { SmartFillService, applyTransform, tokenSetRatio, tokens, type SmartProfile, type Suggestion } from './smartfill.ts';
import { StampService } from './stamp.ts';

const VALUES: Record<string, string> = {
  first_name: PERSON.firstName, last_name: PERSON.lastName, full_name: PERSON.fullName, birth_date: PERSON.birthDate, birth_place: 'Firenze', nationality: 'Italian',
  tax_id: PERSON.taxId, id_number: 'YA1234567', street: PERSON.street, postal_code: PERSON.postalCode, city: PERSON.city, province: 'FI', country: PERSON.country,
  email: PERSON.email, phone: PERSON.phone, company: PERSON.company, vat_number: 'IT01234567890', job_title: 'Designer', iban: PERSON.iban, bic: 'EXAMPLEXXX', bank_name: 'Banca Esempio', today: '2026-10-11',
};

const setup = async (ai?: FakeAiProvider) => {
  const engine = await sharedEngine();
  const db = new InMemoryDatabase();
  await migrate(db);
  const clock = new FakeClock();
  let n = 0;
  const newId = () => `s-${++n}`;
  const crypto = new NodeCrypto();
  const profiles = new ProfileRepo(db, clock, newId, new DataCipher(crypto, new FakeSecretStore()));
  const created = await profiles.create('Personal', Object.keys(PROFILE_TEMPLATES));
  for (const f of created.fields) await profiles.setField(created.id, { ...f, value: VALUES[f.key] ?? '' });
  const profile = (await profiles.get(created.id)) as SmartProfile;
  const mappings = new FormMappingRepo(db, clock, newId);
  const runs = new AiRunsRepo(db, clock, newId);
  const forms = new FormService({ newId });
  const annotations = new AnnotationService({ author: () => 'Marta', now: () => clock.now(), newId });
  const stamps = new StampService({ now: () => clock.now(), locale: () => 'en' });
  const svc = new SmartFillService({ crypto, forms, annotations, stamps, mappings, ai, runs, images: new NodeImageCodec() });
  const open = async (bytes: Uint8Array): Promise<{ doc: PdfDocument; history: History }> => {
    const doc = await engine.open(bytes);
    return { doc, history: new History({ doc, engine }) };
  };
  return { svc, profile, profiles, mappings, runs, open, db };
};
const sizes = new Map([[0, { width: 612, height: 792 }]]);
const byLabel = (list: Suggestion[]): Record<string, Suggestion> => Object.fromEntries(list.map((s) => [s.label, s]));

describe('local matching', () => {
  it('normalises labels and scores them regardless of language, order and small typos @FR-AIF-07', () => {
    expect(tokens('Città / Località:')).toEqual(['citta', 'localita']);
    expect(tokens('txtFirstName')).toEqual(['txt', 'first', 'name']);
    expect(tokenSetRatio('First name', 'first name')).toBe(1);
    expect(tokenSetRatio('Name, first', 'First name')).toBe(1);
    expect(tokenSetRatio('Surname', 'surname')).toBe(1);
    expect(tokenSetRatio('E-mail address', 'email address')).toBeGreaterThan(0.6);
    expect(tokenSetRatio('Telefone', 'telefono')).toBeGreaterThan(0.7);
    expect(tokenSetRatio('Allergies', 'address')).toBe(0);
    expect(tokenSetRatio('Monthly income', 'company name')).toBe(0);
    expect(tokenSetRatio('', 'x')).toBe(0);
  });

  it('applies value transforms locally @FR-AIF-09', async () => {
    const { profile } = await setup();
    expect(applyTransform('Marta Esempio', 'upper')).toBe('MARTA ESEMPIO');
    expect(applyTransform('Marta', 'lower')).toBe('marta');
    expect(applyTransform('1988-04-23', 'date_dmy')).toBe('23/04/1988');
    expect(applyTransform('1988-04-23', 'date_mdy')).toBe('04/23/1988');
    expect(applyTransform('23/04/1988', 'date_iso')).toBe('1988-04-23');
    expect(applyTransform('not a date', 'date_dmy')).toBe('not a date');
    expect(applyTransform('Maria Luisa Rossi', 'first_name')).toBe('Maria');
    expect(applyTransform('Maria Luisa Rossi', 'last_name')).toBe('Luisa Rossi');
    expect(applyTransform('x', 'first_name', profile)).toBe('Marta');
    expect(applyTransform('', 'full_name', { ...profile, fields: profile.fields.filter((f) => f.key !== 'full_name') })).toBe('Marta Esempio');
    expect(applyTransform('+39 055 5550123', 'phone_e164')).toBe('+390555550123');
    expect(applyTransform('0039 055 555 0123', 'phone_e164')).toBe('+390555550123');
    expect(applyTransform('+39 055 5550123', 'phone_national')).toBe('0555550123');
    expect([applyTransform('x', 'checkbox_true'), applyTransform('x', 'checkbox_false'), applyTransform('x', 'none')]).toEqual(['true', 'false', 'x']);
  });

  it('maps the labelled corpus (tax, bank, medical, rental; EN and IT) with at least 85 % accuracy @FR-AIF-07', async () => {
    const { svc, profile, open } = await setup();
    let correct = 0;
    let total = 0;
    const misses: string[] = [];
    for (const form of FORMS_CORPUS) {
      const { pdf, truth } = await corpusForm(form);
      const { doc } = await open(pdf);
      const res = await svc.analyze(doc, [0], profile, { useAi: false, mode: 'mapping_only' });
      expect(res.source).toBe('heuristic');
      const got = byLabel(res.suggestions);
      for (const t of truth) {
        total++;
        const s = got[t.label];
        if (s && s.profileKey === t.key) correct++;
        else misses.push(`${form.name}: "${t.label}" → ${s ? s.profileKey : 'not detected'} (want ${t.key})`);
      }
      doc.dispose();
    }
    const accuracy = correct / total;
    expect(total).toBeGreaterThan(60);
    expect(accuracy, misses.join('\n')).toBeGreaterThanOrEqual(0.85);
  });
});

describe('SmartFillService', () => {
  it('fills an AcroForm from the profile without any network when no key is configured @FR-AIF-03 @FR-AIF-06 @FR-AIF-07', async () => {
    const { svc, profile, open } = await setup();
    const { doc, history } = await open(await fixture('acroform'));
    const res = await svc.analyze(doc, [0], profile, { useAi: true, mode: 'mapping_only' });
    expect(res).toMatchObject({ source: 'heuristic', fallbackReason: 'notConfigured' });
    const s = Object.fromEntries(res.suggestions.map((x) => [x.ref, x]));
    expect(s['person.name']).toMatchObject({ profileKey: 'full_name', value: 'Marta Esempio', kind: 'acroform', accepted: true });
    expect(s['country']).toMatchObject({ profileKey: 'country', value: 'Italy', fieldType: 'choice', accepted: true });
    expect(s['notes']).toMatchObject({ profileKey: null, value: '', accepted: false, confidence: 'low' });
    expect(res.suggestions.find((x) => x.ref === 'ref')).toBeUndefined();
    expect(svc.unmatched(res.suggestions).map((x) => x.ref).sort()).toEqual(['agree', 'code', 'color', 'langs', 'notes']);
    await history.execute(svc.apply(res.suggestions, sizes)!);
    expect(history.state.done.length).toBe(1);
    const rows = Object.fromEntries((await pdfcpuFormFields(await doc.save())).map((r) => [r.name, r.value]));
    expect(rows).toMatchObject({ 'person.name': 'Marta Esempio', country: 'Italy', notes: '' });
    await history.undo();
    expect((await doc.listFormFields()).filter((f) => f.value && f.value !== 'Off' && f.name !== 'ref')).toEqual([]);
    expect(svc.apply(res.suggestions.map((x) => ({ ...x, accepted: false })), sizes)).toBeNull();
    doc.dispose();
  });

  it('uses the AI mapping, resolves values locally and applies everything as one undo step @FR-AIF-03 @FR-AIF-05 @FR-AIF-06', async () => {
    const ai = new FakeAiProvider();
    const { svc, profile, open, runs } = await setup(ai);
    const { pdf, areas } = await flatFormDoc();
    const { doc, history } = await open(pdf);
    ai.enqueue((req) => ({
      fields: req.candidates.map((c) => {
        const key = { 'First name': 'first_name', 'Last name': 'last_name', 'Date of birth': 'birth_date', Email: 'email', 'Tax code': 'tax_id', 'Send me the newsletter': null }[c.label ?? ''] ?? null;
        return { ref: c.ref, label: c.label ?? '', fieldType: c.fieldType, profileKey: key, transform: key === 'birth_date' ? 'date_dmy' : key === 'last_name' ? 'upper' : c.fieldType === 'checkbox' ? 'checkbox_true' : 'none', choiceValue: null, confidence: key === 'email' ? 0.55 : 0.93 };
      }),
      newAreas: [],
    }));
    const res = await svc.analyze(doc, [0], profile, { useAi: true, mode: 'mapping_only' });
    expect(res.source).toBe('ai');
    expect(res.fallbackReason).toBeUndefined();
    // Mapping-only: keys and aliases left the machine, values did not — not even non-sensitive ones.
    const sent = JSON.stringify(ai.requests[0]);
    expect(sent).toContain('first_name');
    expect(sent).toContain('First name');
    for (const v of [PERSON.firstName, PERSON.email, PERSON.taxId, PERSON.birthDate]) expect(sent).not.toContain(v);
    const s = byLabel(res.suggestions);
    expect(s['First name']).toMatchObject({ value: 'Marta', confidence: 'high', accepted: true, kind: 'detected' });
    expect(s['Last name']!.value).toBe('ESEMPIO');
    expect(s['Date of birth']!.value).toBe('23/04/1988');
    expect(s['Email']).toMatchObject({ value: PERSON.email, confidence: 'low', accepted: false });
    expect(s['Tax code']!.value).toBe(PERSON.taxId);
    expect(s['Send me the newsletter']).toMatchObject({ profileKey: null, accepted: false });
    const cmd = svc.apply(res.suggestions, sizes)!;
    await history.execute(cmd);
    const placed = await doc.listAnnotations(0);
    expect(placed.map((a) => a.type)).toEqual(['freetext', 'freetext', 'freetext', 'freetext']);
    // Text boxes sit inside the detected areas, within 3 pt (epic E5).
    for (const [k, a] of placed.entries()) {
      const truth = areas[[0, 1, 2, 4][k]!]!.rect;
      expect(Math.abs(a.rect.x - truth.x)).toBeLessThanOrEqual(3);
      expect(Math.abs(a.rect.y - truth.y)).toBeLessThanOrEqual(3);
    }
    expect((placed[0] as FreeTextAnnotation).contents).toBe('Marta');
    await expect(await doc.save()).toBeValidPdf();
    expect(await history.undo()).toBe(true);
    expect(await doc.listAnnotations(0)).toEqual([]);
    expect(history.state.canUndo).toBe(false);
    expect(await runs.list()).toMatchObject([{ model: 'fake', mode: 'mapping_only', includedImage: false, status: 'ok' }]);
    doc.dispose();
  });

  it('lets the user edit, accept and reject suggestions before applying @FR-AIF-05 @FR-AIF-10', async () => {
    const { svc, profile, open, profiles } = await setup();
    const { doc, history } = await open((await flatFormDoc()).pdf);
    const res = await svc.analyze(doc, [0], profile, { useAi: false, mode: 'mapping_only' });
    const s = byLabel(res.suggestions);
    const news = s['Send me the newsletter']!;
    expect(news).toMatchObject({ fieldType: 'checkbox', profileKey: null });
    // "Add to profile": create the entry, then re-map the suggestion to it.
    await profiles.setField(profile.id, { key: 'newsletter', label: 'Newsletter', type: 'choice', value: 'yes' });
    const updated = (await profiles.get(profile.id)) as SmartProfile;
    const mapped = svc.edit(news, { profileKey: 'newsletter' }, updated);
    expect(mapped).toMatchObject({ profileKey: 'newsletter', value: 'true', accepted: true, confidence: 'high' });
    const typed = svc.edit(s['Email']!, { value: 'other@example.com' }, updated);
    expect(typed).toMatchObject({ value: 'other@example.com', accepted: true });
    const rejected = svc.edit(s['First name']!, { accepted: false }, updated);
    expect(svc.edit(s['Last name']!, { profileKey: null }, updated)).toMatchObject({ profileKey: null, value: '', accepted: false });
    await history.execute(svc.apply([mapped, typed, rejected], sizes)!);
    const placed = await doc.listAnnotations(0);
    expect(placed.map((a) => a.type).sort()).toEqual(['freetext', 'stamp']);
    expect(Math.abs(placed.find((a) => a.type === 'stamp')!.rect.width - 12)).toBeLessThan(2);
    expect(svc.acceptHigh(res.suggestions).filter((x) => x.accepted).every((x) => x.confidence === 'high')).toBe(true);
    doc.dispose();
  });

  it('remembers the accepted mapping and reuses it next time without calling the provider @FR-AIF-08', async () => {
    const ai = new FakeAiProvider();
    const { svc, profile, open } = await setup(ai);
    const pdf = await fixture('acroform');
    const first = await open(pdf);
    ai.enqueue((req) => ({ fields: req.candidates.map((c) => ({ ref: c.ref, label: c.label ?? '', fieldType: c.fieldType, profileKey: c.ref === 'person.name' ? 'full_name' : c.ref === 'notes' ? 'company' : null, transform: c.ref === 'person.name' ? 'upper' : 'none', choiceValue: null, confidence: 0.9 })), newAreas: [] }));
    const res = await svc.analyze(first.doc, [0], profile, { useAi: true, mode: 'mapping_only' });
    expect(res.source).toBe('ai');
    await svc.remember(res, res.suggestions, profile);
    first.doc.dispose();

    const second = await open(pdf);
    const again = await svc.analyze(second.doc, [0], profile, { useAi: true, mode: 'mapping_only' });
    expect(again.source).toBe('remembered');
    expect(again.fingerprint).toBe(res.fingerprint);
    expect(ai.requests.length).toBe(1);
    const s = Object.fromEntries(again.suggestions.map((x) => [x.ref, x]));
    expect(s['person.name']).toMatchObject({ value: 'MARTA ESEMPIO', confidence: 'high', accepted: true });
    expect(s['notes']!.value).toBe(PERSON.company);
    expect(s['country']).toMatchObject({ profileKey: null, accepted: false });
    // "Re-analyse" ignores the stored mapping; forgetting removes it.
    ai.enqueue({ fields: [], newAreas: [] });
    expect((await svc.analyze(second.doc, [0], profile, { useAi: true, mode: 'mapping_only', reanalyze: true })).source).toBe('ai');
    expect(ai.requests.length).toBe(2);
    await svc.forget(again, profile);
    expect((await svc.analyze(second.doc, [0], profile, { useAi: false, mode: 'mapping_only' })).source).toBe('heuristic');
    // A different form has a different fingerprint.
    const other = await open(await fixture('acroform-2'));
    expect((await svc.analyze(other.doc, [0], profile, { useAi: false, mode: 'mapping_only' })).fingerprint).not.toBe(res.fingerprint);
    second.doc.dispose();
    other.doc.dispose();
  });

  it('shows exactly what would be sent; sensitive values never leave in any mode @FR-AIF-04', async () => {
    const ai = new FakeAiProvider();
    const { svc, profile, open } = await setup(ai);
    const { doc } = await open((await flatFormDoc()).pdf);
    const { candidates, layers } = await svc.collect(doc, [0]);
    const mapping = svc.buildRequest(candidates, layers, sizes, profile, 'mapping_only');
    const pre = svc.preflight(mapping, profile);
    expect(pre).toMatchObject({ mode: 'mapping_only', pages: [1], candidateCount: 6, keyCount: profile.fields.length, valueKeys: [], withheldKeys: [], includesImage: false });
    expect(pre.sampleLabels).toContain('First name');
    expect(pre.textLineCount).toBeGreaterThan(4);
    expect(pre.estimatedTokens).toBeGreaterThan(300);
    const withValues = svc.buildRequest(candidates, layers, sizes, profile, 'with_values');
    const pre2 = svc.preflight(withValues, profile);
    expect(pre2.valueKeys).toContain('first_name');
    expect(pre2.withheldKeys.sort()).toEqual(['iban', 'id_number', 'tax_id']);
    const text = JSON.stringify(withValues);
    expect(text).toContain(PERSON.email);
    for (const secret of [PERSON.taxId, PERSON.iban, 'YA1234567']) expect(text).not.toContain(secret);
    // Page cap: only the first `maxPages` pages are described.
    const three = await open(await fixture('text-25'));
    const all = await svc.collect(three.doc, [0, 1, 2, 3, 4]);
    expect(svc.buildRequest(all.candidates, all.layers, sizes, profile, 'mapping_only', 3).pages.length).toBeLessThanOrEqual(3);
    // With the image option the request carries a JPEG of the page.
    ai.enqueue({ fields: [], newAreas: [{ page: 0, bbox: [0.1, 0.8, 0.5, 0.83], label: 'Phone', fieldType: 'text', profileKey: 'phone', confidence: 0.99 }] });
    const res = await svc.analyze(doc, [0], profile, { useAi: true, mode: 'mapping_only', includeImage: true });
    const extra = res.suggestions.find((s) => s.ref === 'p1-n1')!;
    expect(extra).toMatchObject({ label: 'Phone', value: PERSON.phone, kind: 'detected' });
    expect(extra.rect.x).toBeCloseTo(61.2, 1);
    expect(extra.rect.y).toBeCloseTo(792 * 0.17, 0);
    doc.dispose();
    three.doc.dispose();
  });

  it('falls back to local matching when offline, unauthorised, rate limited or given garbage @FR-AIF-07', async () => {
    for (const [error, reason] of [[new NetworkError('offline'), 'offline'], [new AiError('unauthorized'), 'unauthorized'], [new AiError('rateLimited'), 'rateLimited'], [new AiError('malformed'), 'malformed']] as const) {
      const ai = new FakeAiProvider();
      const { svc, profile, open, runs } = await setup(ai);
      const { doc } = await open(await fixture('acroform'));
      ai.enqueue(error);
      const res = await svc.analyze(doc, [0], profile, { useAi: true, mode: 'mapping_only' });
      expect(res).toMatchObject({ source: 'heuristic', fallbackReason: reason });
      expect(res.suggestions.find((s) => s.ref === 'person.name')!.value).toBe('Marta Esempio');
      expect((await runs.list())[0]!.status).toBe(`error:${reason}`);
      doc.dispose();
    }
  });

  it('resists prompt injection: text in the document cannot redirect mappings or leak values @FR-AIF-05', async () => {
    const ai = new FakeAiProvider();
    const { svc, profile, open } = await setup(ai);
    const { doc, history } = await open(await injectionForm());
    // A "compromised" model that obeys the page: every field → iban, plus invented keys, ids and values.
    ai.enqueue((req) => ({
      fields: [
        ...req.candidates.map((c) => ({ ref: c.ref, label: c.label ?? '', fieldType: c.fieldType, profileKey: 'iban', transform: 'none', choiceValue: null, confidence: 1 })),
        { ref: 'p9-a9', label: 'x', fieldType: 'text', profileKey: 'iban', transform: 'none', confidence: 1 },
        { ref: req.candidates[0]!.ref, label: 'dup', fieldType: 'text', profileKey: 'secret_dump', transform: 'none', value: 'attacker text', confidence: 1 },
      ],
      newAreas: [{ page: 0, bbox: [0, 0, 1, 1], label: 'x', fieldType: 'text', profileKey: 'all_data', confidence: 1 }],
    }));
    const res = await svc.analyze(doc, [0], profile, { useAi: true, mode: 'mapping_only' });
    // The request itself carried the hostile text only as data, and no values.
    expect(JSON.stringify(ai.requests[0])).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(JSON.stringify(ai.requests[0])).not.toContain(PERSON.iban);
    // Whatever the model answers, values come from the local profile for keys that exist, and the user reviews them.
    expect(res.suggestions.every((s) => s.profileKey === null || s.profileKey === 'iban')).toBe(true);
    expect(res.suggestions.some((s) => s.value === 'attacker text')).toBe(false);
    expect(res.suggestions.find((s) => s.ref === 'p9-a9')).toBeUndefined();
    expect(res.suggestions.find((s) => s.ref === 'p1-n1')).toMatchObject({ profileKey: null, value: '', accepted: false });
    // Nothing is written until the user applies; rejecting everything leaves the document untouched.
    expect(await doc.listAnnotations(0)).toEqual([]);
    expect(svc.apply(res.suggestions.map((s) => ({ ...s, accepted: false })), sizes)).toBeNull();
    expect(history.state.canUndo).toBe(false);
    doc.dispose();
  });

  it('handles pages with nothing to fill and rejects an empty page selection @FR-AIF-03', async () => {
    const { svc, profile, open } = await setup();
    const { doc } = await open(await fixture('scan'));
    expect(await svc.analyze(doc, [0], profile, { useAi: false, mode: 'mapping_only' })).toMatchObject({ suggestions: [], source: 'heuristic' });
    await expect(svc.analyze(doc, [], profile, { useAi: false, mode: 'mapping_only' })).rejects.toThrow();
    const ac = new AbortController();
    doc.dispose();
    void ac;
  });
});
