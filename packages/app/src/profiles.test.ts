import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@folio/ai';
import { applyToRect, pageToViewMatrix, rotatedSize } from '@folio/core';
import { scannedFormDoc } from '@folio/testkit';
import { createTestApp } from './testing.ts';

describe('Profiles and field templates editor @FR-FRM-20', () => {
  it('a profile built from scratch with six typed fields, reordered, then a template made from it @FR-FRM-20', async () => {
    const t = await createTestApp();
    const m = t.profiles();
    await m.load();
    // Built-in sets are listed and read-only.
    expect(m.templates.filter((x) => x.builtIn).length).toBeGreaterThanOrEqual(6);
    const p = (await m.create('Travel'))!;
    expect(m.editing).toBe(p.id);
    const keys: string[] = [];
    for (const [label, type] of [['Full name', 'text'], ['Date of birth', 'date'], ['E-mail', 'email'], ['Mobile phone', 'phone'], ['Seat', 'choice'], ['Notes', 'multiline']] as const)
      keys.push((await m.addField(p.id, label, type))!);
    expect(keys).toEqual(['full_name', 'date_of_birth', 'e_mail', 'mobile_phone', 'seat', 'notes']);
    expect(await m.addField(p.id, 'Full name')).toBe('full_name_2');
    await m.removeField(p.id, 'full_name_2');
    // Typed values are validated; invalid ones are refused with the reason and nothing is written.
    expect(await m.updateField(p.id, 'date_of_birth', { value: '31/02/1990' })).toBe(false);
    expect(t.toastKeys()).toContain('profiles.invalid.badDate');
    expect(await m.updateField(p.id, 'date_of_birth', { value: '1988-04-23' })).toBe(true);
    expect(await m.updateField(p.id, 'e_mail', { value: 'nope' })).toBe(false);
    expect(await m.updateField(p.id, 'seat', { value: 'Aisle', options: ['Aisle', 'Window'] })).toBe(true);
    await m.moveField(p.id, 'notes', -1);
    await m.moveField(p.id, 'notes', -1);
    await m.moveField(p.id, 'full_name', -1);
    expect(m.current!.fields.map((f) => f.key)).toEqual(['full_name', 'date_of_birth', 'e_mail', 'notes', 'mobile_phone', 'seat']);
    expect(m.current!.fields.find((f) => f.key === 'seat')).toMatchObject({ type: 'choice', options: ['Aisle', 'Window'], value: 'Aisle' });

    const tpl = (await m.saveAsTemplate(p.id, 'Travel header'))!;
    expect(tpl.fields.length).toBe(6);
    expect(JSON.stringify(tpl)).not.toContain('1988-04-23');
    // A second profile: the template adds its fields, duplicate keys are skipped and listed.
    const q = (await m.create('Second', []))!;
    await m.updateField(q.id, (await m.addField(q.id, 'Full name'))!, { value: 'Keep' });
    await m.addTemplate(q.id, tpl.id);
    expect(m.skipped).toEqual(['full_name']);
    expect(t.toastKeys()).toContain('profiles.skipped');
    expect(m.current!.fields.find((f) => f.key === 'full_name')!.value).toBe('Keep');
    expect(m.current!.fields.length).toBe(6);
  });

  it('changing a label keeps the key and the remembered mapping; changing a key forgets only its mappings @FR-FRM-20 @FR-AIF-08', async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    const m = t.profiles();
    await m.load();
    await m.create('Me', ['builtin:identity']);
    const profile = m.current!;
    await m.updateField(profile.id, 'full_name', { value: 'Marta Esempio' });
    await m.updateField(profile.id, 'country', { value: 'Italy' });
    const s = await t.open('acroform', '/form.pdf');
    const sf = t.smartFill(s);
    await sf.start();
    await sf.apply();
    const again = await t.open('acroform', '/copy.pdf');
    const sf2 = t.smartFill(again);
    await sf2.start();
    expect(sf2.result!.source).toBe('remembered');
    const requests = ai.requests.length;

    // The label changes: the key does not, the mapping still works with no request.
    await m.updateField(profile.id, 'full_name', { label: 'Nominativo completo' });
    expect(m.current!.fields.find((f) => f.key === 'full_name')!.label).toBe('Nominativo completo');
    const third = await t.open('acroform', '/third.pdf');
    const sf3 = t.smartFill(third);
    await sf3.start();
    expect(sf3.result!.source).toBe('remembered');
    expect(sf3.suggestions.find((x) => x.ref === 'person.name')).toMatchObject({ profileKey: 'full_name', accepted: true });
    expect(ai.requests.length).toBe(requests);

    // The key changes after confirmation: that mapping entry is forgotten, the form falls back to matching.
    t.prompts.confirmAnswers = [false];
    expect(await m.changeKey(profile.id, 'full_name', 'complete_name')).toBe(false);
    t.prompts.confirmAnswers = [true];
    expect(await m.changeKey(profile.id, 'full_name', 'complete_name')).toBe(true);
    expect(m.current!.fields.some((f) => f.key === 'complete_name')).toBe(true);
    const fourth = await t.open('acroform', '/fourth.pdf');
    const sf4 = t.smartFill(fourth);
    await sf4.start();
    expect(sf4.suggestions.find((x) => x.ref === 'person.name')).toMatchObject({ profileKey: 'complete_name' });
    expect(sf4.result!.source).not.toBe('remembered');
    // Removing an entry drops it from the mappings of the profile as well.
    await m.removeField(profile.id, 'country');
    expect(m.current!.fields.some((f) => f.key === 'country')).toBe(false);
  });

  it('exports and imports a template and refuses a newer version; deleting asks first @FR-FRM-20', async () => {
    const t = await createTestApp();
    const m = t.profiles();
    await m.load();
    const tpl = (await m.createTemplate('Mine'))!;
    await m.updateTemplate(tpl.id, { fields: [{ key: 'name', label: 'Name', type: 'text', aliases: [], sensitive: false, options: [] }] });
    t.files.nextSave.push('/out/mine.template.json');
    expect(await m.exportTemplate(tpl.id)).toBe(true);
    const text = new TextDecoder().decode(t.files.get('/out/mine.template.json')!);
    expect(JSON.parse(text)).toMatchObject({ version: 1, kind: 'folio-field-template', name: 'Mine' });
    t.files.nextOpen.push(['/out/mine.template.json']);
    const imported = (await m.importTemplate())!;
    expect(imported.fields.map((f) => f.key)).toEqual(['name']);
    expect(m.templates.filter((x) => x.name === 'Mine').length).toBe(2);
    t.files.put('/out/newer.json', new TextEncoder().encode(JSON.stringify({ ...JSON.parse(text), version: 9 })));
    t.files.nextOpen.push(['/out/newer.json']);
    expect(await m.importTemplate()).toBeNull();
    expect(t.toastKeys()).toContain('error.invalidArgument.templateNewer');
    t.prompts.confirmAnswers = [false];
    expect(await m.removeTemplate(tpl.id)).toBe(false);
    t.prompts.confirmAnswers = [true];
    expect(await m.removeTemplate(tpl.id)).toBe(true);
    expect(m.templates.some((x) => x.id === tpl.id)).toBe(false);
    // A built-in template cannot be removed.
    t.prompts.confirmAnswers = [true];
    expect(await m.removeTemplate('builtin:identity')).toBe(true);
    expect(m.templates.some((x) => x.id === 'builtin:identity')).toBe(true);
    expect(t.toastKeys()).toContain('error.invalidArgument.builtInTemplate');
  });

  it('a profile built in the editor fills a scanned form through detection (recorded response) @FR-FRM-20 @FR-AIF-14', async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    const m = t.profiles();
    await m.load();
    const p = (await m.create('Scan me'))!;
    for (const [label, value] of [['First name', 'Marta'], ['Last name', 'Esempio']] as const) await m.updateField(p.id, (await m.addField(p.id, label))!, { value });
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true, preflightAcknowledged: ['mapping_only'] });
    const { pdf, areas } = await scannedFormDoc({ rotate: 90 });
    t.files.put('/scan.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/scan.pdf')))!;
    const info = s.pageInfos[0]!;
    const shown = rotatedSize(info.size, info.rotation);
    const mx = pageToViewMatrix(info.size, info.rotation, 1);
    ai.enqueue((req) => ({
      fields: [],
      newAreas: areas.slice(0, 2).map((a) => {
        const v = applyToRect(mx, a.rect);
        return { page: req.pages[0]!.page, bbox: [v.x / shown.width, v.y / shown.height, (v.x + v.width) / shown.width, (v.y + v.height) / shown.height], label: a.label, fieldType: 'text', profileKey: a.label === 'First name' ? 'first_name' : 'last_name', confidence: 0.9 };
      }),
    }));
    const sf = t.smartFill(s);
    await sf.start();
    expect(sf.stage).toBe('preflight');
    // No fields at all: the image goes along for this run although the setting is off.
    expect(sf.preflight).toMatchObject({ includesImage: true, imageForThisRun: true });
    await sf.confirmPreflight(false);
    expect(sf.suggestions.map((x) => x.value).sort()).toEqual(['Esempio', 'Marta']);
    expect(await sf.apply()).toBe(2);
    expect((await s.doc.listFormFields()).map((f) => f.value).sort()).toEqual(['Esempio', 'Marta']);
    // The same document again: the created fields carry the remembered mapping.
    const requests = ai.requests.length;
    const sf2 = t.smartFill(s);
    await sf2.start();
    expect(sf2.result!.source).toBe('remembered');
    expect(ai.requests.length).toBe(requests);
  });
});
