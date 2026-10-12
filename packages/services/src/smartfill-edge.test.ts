// Smart Fill value handling: what gets written into a user's form must be exact or absent (FR-AIF-05, FR-AIF-09).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FieldMapping } from '@folio/ports';
import { SmartFillService, applyTransform, type SmartCandidate, type SmartProfile } from './smartfill.ts';

const profile: SmartProfile = {
  id: 'p',
  name: 'Me',
  fields: [
    {
      key: 'first_name',
      label: 'First name',
      type: 'text',
      value: 'Marta',
      sensitive: false,
      aliases: [],
    },
    {
      key: 'last_name',
      label: 'Last name',
      type: 'text',
      value: 'Rossi',
      sensitive: false,
      aliases: [],
    },
    {
      key: 'country',
      label: 'Country',
      type: 'text',
      value: 'Italy',
      sensitive: false,
      aliases: [],
    },
    {
      key: 'newsletter',
      label: 'Newsletter',
      type: 'text',
      value: 'no',
      sensitive: false,
      aliases: [],
    },
    {
      key: 'empty',
      label: 'Empty',
      type: 'text',
      value: '',
      sensitive: false,
      aliases: [],
    },
    {
      key: 'birth_date',
      label: 'Birth date',
      type: 'date',
      value: '1988-04-23',
      sensitive: false,
      aliases: [],
    },
  ],
};

const cand = (over: Partial<SmartCandidate> & { ref: string }): SmartCandidate =>
  ({
    page: 0,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    kind: 'acroform',
    fieldType: 'text',
    label: over.ref,
    ...over,
  }) as SmartCandidate;
const map = (over: Partial<FieldMapping> & { ref: string }): FieldMapping =>
  ({
    label: over.ref,
    fieldType: 'text',
    profileKey: 'first_name',
    transform: 'none',
    choiceValue: null,
    confidence: 0.95,
    ...over,
  }) as FieldMapping;
// `resolve` is pure: it needs no collaborators.
const svc = new SmartFillService({} as never);

describe('date transforms never invent a date @FR-AIF-09', () => {
  it('formats real dates in each style', () => {
    expect(applyTransform('1988-04-23', 'date_dmy')).toBe('23/04/1988');
    expect(applyTransform('1988-04-23', 'date_mdy')).toBe('04/23/1988');
    expect(applyTransform('23/04/1988', 'date_iso')).toBe('1988-04-23');
    expect(applyTransform('23.4.1988', 'date_iso')).toBe('1988-04-23');
    expect(applyTransform('2024-02-29', 'date_dmy')).toBe('29/02/2024'); // leap day
  });

  it('leaves impossible dates exactly as they were instead of rolling them over', () => {
    for (const v of [
      '2026-02-30',
      '31/02/2026',
      '2026-13-01',
      '00/00/2026',
      '2025-02-29',
      '12/31/2026',
      '31/04/2026',
    ]) {
      for (const t of ['date_dmy', 'date_mdy', 'date_iso'] as const)
        expect(applyTransform(v, t), `${v} ${t}`).toBe(v);
    }
  });

  it('leaves text that is not a date alone', () => {
    for (const v of ['', 'tomorrow', '1988', '23 April 1988']) expect(applyTransform(v, 'date_iso')).toBe(v);
  });

  it('dmy → iso → dmy round-trips every valid date (property)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(1900, 0, 1), max: new Date(2100, 11, 31), noInvalidDate: true }),
        (d) => {
          const dmy = applyTransform(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, 'date_dmy');
          const iso = applyTransform(dmy, 'date_iso');
          expect(applyTransform(iso, 'date_dmy')).toBe(dmy);
          expect(iso).toBe(
            `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
          );
        },
      ),
    );
  });
});

describe('other transforms @FR-AIF-09', () => {
  it('splits and joins names with and without profile data', () => {
    expect(applyTransform('Marta Rossi', 'first_name', profile)).toBe('Marta');
    expect(applyTransform('Marta Rossi', 'last_name', profile)).toBe('Rossi');
    expect(applyTransform('Anna Maria De Luca', 'first_name')).toBe('Anna');
    expect(applyTransform('Anna Maria De Luca', 'last_name')).toBe('Maria De Luca');
    expect(applyTransform('Madonna', 'last_name')).toBe('Madonna');
    expect(applyTransform('  ', 'first_name')).toBe('  ');
    expect(applyTransform('x', 'full_name', profile)).toBe('Marta Rossi');
  });

  it('normalises phone numbers and keeps digits only', () => {
    expect(applyTransform('+39 (055) 123-4567', 'phone_e164')).toBe('+390551234567');
    expect(applyTransform('0039 055 1234567', 'phone_e164')).toBe('+390551234567');
    expect(applyTransform('055 1234567', 'phone_e164')).toBe('0551234567');
    expect(applyTransform('+39 3331234567', 'phone_national')).toBe('3331234567');
    expect(applyTransform('call me', 'phone_e164')).toBe('');
  });

  it('case transforms are locale-safe and idempotent (property)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const up = applyTransform(s, 'upper');
        expect(applyTransform(up, 'upper')).toBe(up);
        expect(applyTransform(applyTransform(s, 'lower'), 'lower')).toBe(applyTransform(s, 'lower'));
      }),
    );
    expect(applyTransform('straße', 'upper')).toBe('STRASSE');
  });
});

describe('SmartFillService.resolve @FR-AIF-05', () => {
  it('fills a text field from the mapped key and marks high confidence as accepted', () => {
    const [s] = svc.resolve([map({ ref: 'f' })], [cand({ ref: 'f' })], profile);
    expect(s).toMatchObject({ value: 'Marta', profileKey: 'first_name', confidence: 'high', accepted: true });
  });

  it('an unknown profile key yields no value and is never accepted', () => {
    const [s] = svc.resolve(
      [map({ ref: 'f', profileKey: 'iban_of_someone_else' })],
      [cand({ ref: 'f' })],
      profile,
    );
    expect(s).toMatchObject({ value: '', profileKey: null, accepted: false, score: 0 });
  });

  it('an empty profile value or a low score is shown but starts unticked', () => {
    const [empty, low] = svc.resolve(
      [map({ ref: 'e', profileKey: 'empty' }), map({ ref: 'l', confidence: 0.2 })],
      [cand({ ref: 'e' }), cand({ ref: 'l' })],
      profile,
    );
    expect(empty).toMatchObject({ value: '', accepted: false });
    expect(low).toMatchObject({ value: 'Marta', accepted: false, confidence: 'low' });
  });

  it('candidates without any mapping stay empty', () => {
    const out = svc.resolve([], [cand({ ref: 'x' }), cand({ ref: 'y' })], profile);
    expect(out.map((s) => [s.value, s.accepted, s.profileKey])).toEqual([
      ['', false, null],
      ['', false, null],
    ]);
  });

  it('choice fields accept only a real option; an invented one is cleared and downgraded', () => {
    const country = cand({ ref: 'c', fieldType: 'choice', options: ['Italy', 'France'] });
    const [ok, wrongCase, invented, none] = svc.resolve(
      [
        map({ ref: 'c', profileKey: 'country' }),
        map({ ref: 'c2', profileKey: 'country', choiceValue: 'FRANCE' }),
        map({ ref: 'c3', profileKey: 'country', choiceValue: 'Atlantis' }),
        map({ ref: 'c4', profileKey: 'empty' }),
      ],
      [country, { ...country, ref: 'c2' }, { ...country, ref: 'c3' }, { ...country, ref: 'c4' }],
      profile,
    );
    expect(ok).toMatchObject({ value: 'Italy', accepted: true });
    expect(wrongCase!.value).toBe('France');
    expect(invented).toMatchObject({ value: '', accepted: false });
    expect(invented!.score).toBeLessThanOrEqual(0.3);
    expect(none).toMatchObject({ value: '', accepted: false });
  });

  it('a blank option in a dropdown is never selected by an empty answer', () => {
    const c = cand({ ref: 'c', fieldType: 'choice', options: ['', 'Italy'] });
    const [s] = svc.resolve([map({ ref: 'c', profileKey: 'empty', choiceValue: '' })], [c], profile);
    expect(s!.accepted).toBe(false);
  });

  it('checkboxes follow the transform first, then the stored value', () => {
    const box = (ref: string) => cand({ ref, fieldType: 'checkbox' });
    const out = svc.resolve(
      [
        map({ ref: 'a', profileKey: 'newsletter', transform: 'checkbox_true' }),
        map({ ref: 'b', profileKey: 'first_name', transform: 'checkbox_false' }),
        map({ ref: 'c', profileKey: 'newsletter' }),
        map({ ref: 'd', profileKey: 'first_name' }),
      ],
      [box('a'), box('b'), box('c'), box('d')],
      profile,
    );
    expect(out.map((s) => s.value)).toEqual(['true', 'false', 'false', 'false']);
  });

  it('applies transforms from the mapping to the stored value, never the reverse', () => {
    const [s] = svc.resolve(
      [map({ ref: 'd', profileKey: 'birth_date', transform: 'date_dmy' })],
      [cand({ ref: 'd', fieldType: 'date' })],
      profile,
    );
    expect(s!.value).toBe('23/04/1988');
    expect(profile.fields.find((f) => f.key === 'birth_date')!.value).toBe('1988-04-23');
  });

  it('ignores mappings for refs that are not candidates', () => {
    const out = svc.resolve([map({ ref: 'ghost' })], [cand({ ref: 'f' })], profile);
    expect(out).toHaveLength(1);
    expect(out[0]!.ref).toBe('f');
  });
});
