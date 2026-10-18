import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@folio/ai';
import { applyToRect, pageToViewMatrix, rotatedSize } from '@folio/core';
import { flatFormDoc, inkRatio, samplePng, scannedFormDoc } from '@folio/testkit';
import { vectorFromStrokes, vectorToSvg } from '@folio/services';
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
    expect(keys).toEqual(['full_name', 'date_of_birth', 'email', 'phone', 'seat', 'notes']);
    expect(await m.addField(p.id, 'Full name')).toBe('full_name_2');
    await m.removeField(p.id, 'full_name_2');
    // Typed values are validated; invalid ones are refused with the reason and nothing is written.
    expect(await m.updateField(p.id, 'date_of_birth', { value: '31/02/1990' })).toBe(false);
    expect(t.toastKeys()).toContain('profiles.invalid.badDate');
    expect(await m.updateField(p.id, 'date_of_birth', { value: '1988-04-23' })).toBe(true);
    expect(await m.updateField(p.id, 'email', { value: 'nope' })).toBe(false);
    expect(await m.updateField(p.id, 'seat', { value: 'Aisle', options: ['Aisle', 'Window'] })).toBe(true);
    await m.moveField(p.id, 'notes', -1);
    await m.moveField(p.id, 'notes', -1);
    await m.moveField(p.id, 'full_name', -1);
    expect(m.current!.fields.map((f) => f.key)).toEqual(['full_name', 'date_of_birth', 'email', 'notes', 'phone', 'seat']);
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

  it('a profile carries a signature that Smart Fill puts into empty signature fields, once, as one undo step @FR-STM-01 @FR-AIF-04', async () => {
    const t = await createTestApp();
    const s = await t.open('acroform', '/sig.pdf');
    const rect = { x: 72, y: 100, width: 200, height: 50 };
    await s.run(t.services.authoring.create([t.services.authoring.spec('signature', 'Applicant signature', 0, rect)]));
    const sig = await t.services.signaturesRepo.add({ name: 'Formal', kind: 'signature', source: 'drawn', png: samplePng(120, 40), width: 120, height: 40 }, { encrypt: false });
    const m = t.profiles();
    await m.load();
    expect(m.signatures.map((x) => x.name)).toEqual(['Formal']);
    const p = (await m.create('Personal'))!;
    await m.setSignature(p.id, sig.id);
    expect(m.current!.signatureId).toBe(sig.id);

    const sf = t.smartFill(s);
    await sf.start();
    expect(sf.stage).toBe('review');
    expect(sf.signFields).toBe(1);
    expect(sf.signWith!.name).toBe('Formal');
    const count = await sf.apply(false);
    expect(count).toBeGreaterThanOrEqual(1);
    const stamps = (await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp');
    expect(stamps.map((a) => (a.type === 'stamp' ? a.name : ''))).toEqual(['Signature']);
    const placed = stamps[0]!.rect;
    // Fitted inside the field with its aspect ratio (3:1), centred.
    expect(placed.x).toBeGreaterThanOrEqual(rect.x);
    expect(placed.x + placed.width).toBeLessThanOrEqual(rect.x + rect.width);
    expect(placed.y).toBeGreaterThanOrEqual(rect.y);
    expect(placed.y + placed.height).toBeLessThanOrEqual(rect.y + rect.height);
    expect(placed.width / placed.height).toBeCloseTo(3, 1);
    // A second run finds it already signed.
    const again = t.smartFill(s);
    await again.start();
    expect(again.signFields).toBe(0);
    // One undo removes the signature again.
    await s.undo();
    expect((await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp')).toEqual([]);
    // A profile without a signature offers nothing.
    await m.setSignature(p.id, null);
    const none = t.smartFill(s);
    await none.start();
    expect(none.signFields).toBe(0);
  });

  it('the profile signature goes onto a "Firma" line of a flat form that has no signature field @FR-STM-01 @FR-AIF-06', async () => {
    const t = await createTestApp();
    const { pdf, areas } = await flatFormDoc([
      { key: 'first_name', label: 'First name', kind: 'underline' },
      { key: 'signature', label: 'Firma del genitore', kind: 'underline' },
    ]);
    t.files.put('/flat.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/flat.pdf')))!;
    const sig = await t.services.signaturesRepo.add({ name: 'Formal', kind: 'signature', source: 'drawn', png: samplePng(120, 40), width: 120, height: 40 }, { encrypt: false });
    const m = t.profiles();
    await m.load();
    const p = (await m.create('Flat'))!;
    await m.updateField(p.id, (await m.addField(p.id, 'First name'))!, { value: 'Marta' });
    await m.setSignature(p.id, sig.id);
    const sf = t.smartFill(s);
    await sf.start();
    expect(sf.signFields).toBe(1);
    await sf.apply(false);
    const stamps = (await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp');
    expect(stamps.length).toBe(1);
    const line = areas[1]!.rect;
    const r = stamps[0]!.rect;
    expect(r.x).toBeGreaterThanOrEqual(line.x - 1);
    expect(r.x + r.width).toBeLessThanOrEqual(line.x + line.width + 1);
    expect(r.y + r.height / 2).toBeGreaterThan(line.y);
  });

  it('with the AI on, a dotted "Firma" line still gets the profile signature, and a remembered form does not skip the AI silently @FR-STM-01 @FR-AIF-08', async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    const { pdf } = await flatFormDoc([
      { key: 'first_name', label: 'First name', kind: 'underline' },
      { key: 'signature', label: 'Firma', kind: 'dots' },
    ]);
    t.files.put('/flat2.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/flat2.pdf')))!;
    const sig = await t.services.signaturesRepo.add({ name: 'Formal', kind: 'signature', source: 'drawn', png: samplePng(120, 40), width: 120, height: 40 }, { encrypt: false });
    const m = t.profiles();
    await m.load();
    const p = (await m.create('Flat'))!;
    await m.updateField(p.id, (await m.addField(p.id, 'First name'))!, { value: 'Marta' });
    await m.setSignature(p.id, sig.id);
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true, baseUrl: 'http://localhost:11434/v1', model: 'm', preflightAcknowledged: ['mapping_only'] });
    ai.enqueue((req) => ({ fields: req.candidates.map((c) => ({ ref: c.ref, label: c.label ?? '', fieldType: /Firma/.test(c.label ?? '') ? 'signature' : 'text', profileKey: c.label === 'First name' ? 'first_name' : null, transform: 'none', choiceValue: null, confidence: 0.9 })), newAreas: [] }));
    const sf = t.smartFill(s);
    await sf.start();
    expect(sf.result!.source).toBe('ai');
    expect(sf.signFields).toBe(1);
    await sf.apply(false);
    expect((await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp').length).toBe(1);
    // Same form again: the stored mapping is used, and the panel says so.
    const sf2 = t.smartFill(s);
    await sf2.start();
    expect(sf2.result!.source).toBe('remembered');
  });

  it('a second run on a form where Smart Fill already created fields still finds the "Firma" line @FR-STM-01 @FR-AIF-14', async () => {
    const t = await createTestApp();
    const { pdf } = await flatFormDoc([
      { key: 'first_name', label: 'First name', kind: 'underline' },
      { key: 'signature', label: 'Firma', kind: 'dots' },
    ]);
    t.files.put('/flat3.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/flat3.pdf')))!;
    const sig = await t.services.signaturesRepo.add({ name: 'Formal', kind: 'signature', source: 'drawn', png: samplePng(120, 40), width: 120, height: 40 }, { encrypt: false });
    const m = t.profiles();
    await m.load();
    const p = (await m.create('Flat'))!;
    await m.updateField(p.id, (await m.addField(p.id, 'First name'))!, { value: 'Marta' });
    await m.setSignature(p.id, sig.id);
    const first = t.smartFill(s);
    await first.start();
    first.setSignIt(false);
    await first.apply(false);
    expect((await s.doc.listFormFields()).length).toBe(1);
    expect((await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp').length).toBe(0);
    const again = t.smartFill(s);
    await again.start();
    expect(again.signFields).toBe(1);
    await again.apply(false);
    expect((await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp').length).toBe(1);
  });
  it("the reported 'doposcuola' form: Haiku leaves the tutore line empty, the profile's father and signature still arrive @FR-AIF-07 @FR-STM-01", async () => {
    const ai = new FakeAiProvider();
    const t = await createTestApp({ ai });
    const labels = ['Il/la sottoscritto/a', 'codice fiscale', 'indirizzo di residenza (comune, via e cap)', 'genitore o tutore legale dell’alunno/a', 'appartenente alla classe', 'Firma', 'Numero di telefono per eventuali comunicazioni', '(Indirizzo email per ricevere copia della fattura', 'Firma', 'Data'];
    const { pdf } = await flatFormDoc(labels.map((label) => ({ key: '', label, kind: 'dots' as const })), 'ISCRIZIONE');
    t.files.put('/doposcuola.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/doposcuola.pdf')))!;
    // A drawn signature, as the signature pad stores it: a vector path and its raster.
    const vector = vectorFromStrokes([[{ x: 0, y: 30 }, { x: 40, y: 0 }, { x: 80, y: 30 }, { x: 120, y: 5 }], [{ x: 10, y: 38 }, { x: 110, y: 36 }]]);
    const sig = await t.services.signaturesRepo.add({ name: 'Daniele', kind: 'signature', source: 'drawn', svg: vectorToSvg(vector), png: samplePng(120, 40), width: vector.width, height: vector.height }, { encrypt: false });
    const m = t.profiles();
    await m.load();
    const p = (await m.create('Daniele'))!;
    const father = (await m.addField(p.id, 'Father'))!;
    await m.updateField(p.id, father, { value: 'Marco Rossi', aliases: ['genitore di', 'padre di', 'tutore di', 'tutore legale di'] });
    const classe = (await m.addField(p.id, 'Classe'))!;
    await m.updateField(p.id, classe, { value: '3A' });
    await m.setSignature(p.id, sig.id);
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true, baseUrl: 'http://localhost:11434/v1', model: 'm', preflightAcknowledged: ['mapping_only'] });
    ai.enqueue((req) => ({
      fields: req.candidates.map((c) => ({
        ref: c.ref,
        label: c.label ?? '',
        fieldType: /^Firma/.test(c.label ?? '') ? 'signature' : 'text',
        profileKey: c.label === 'appartenente alla classe' ? 'classe' : null,
        transform: 'none',
        choiceValue: null,
        confidence: /tutore/.test(c.label ?? '') ? 0.3 : 0.9,
      })),
      newAreas: [],
    }));
    const sf = t.smartFill(s);
    await sf.start();
    expect(sf.result!.source).toBe('ai');
    expect(sf.suggestions.find((x) => /tutore/.test(x.label))).toMatchObject({ profileKey: 'father', value: 'Marco Rossi', confidence: 'high', accepted: true });
    expect(sf.signFields).toBe(2);
    await sf.apply(false);
    const stamps = (await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp');
    expect(stamps.length).toBe(2);
    // The page shows the drawn signature where the stamps are.
    const page = await s.doc.render(0, { scale: 1 });
    for (const st of stamps) expect(inkRatio(page, { x: st.rect.x, y: 792 - st.rect.y - st.rect.height, width: st.rect.width, height: st.rect.height })).toBeGreaterThan(0.01);
    expect((await s.doc.listFormFields()).map((f) => f.value)).toEqual(expect.arrayContaining(['Marco Rossi']));
  });
  it('e-mail and phone entries are chosen by type and named after it, whatever label is typed or stored @FR-FRM-20 @FR-AIF-01', async () => {
    const t = await createTestApp();
    const m = t.profiles();
    await m.load();
    const p = (await m.create('Typed'))!;
    expect(await m.addField(p.id, 'ignored label', 'email')).toBe('email');
    expect(await m.addField(p.id, '', 'phone')).toBe('phone');
    expect(await m.addField(p.id, 'Class', 'text')).toBe('class');
    expect(m.current!.fields.map((f) => [f.key, f.label, f.type])).toEqual([['email', 'Email', 'email'], ['phone', 'Phone', 'phone'], ['class', 'Class', 'text']]);
    // The label of a typed entry cannot be changed; a text entry keeps its own.
    await m.updateField(p.id, 'email', { label: 'me@example.com', value: 'me@example.com' });
    await m.updateField(p.id, 'class', { label: 'Classe' });
    expect(m.current!.fields.map((f) => f.label)).toEqual(['Email', 'Phone', 'Classe']);
    // Turning a text entry into an e-mail entry names it after the type.
    await m.updateField(p.id, 'class', { type: 'email' });
    expect(m.current!.fields.find((f) => f.key === 'class')!.label).toBe('Email');
    // A profile saved before, with the address typed as the label, is read and sent by its type.
    await t.services.profiles.setField(p.id, { key: 'old', label: 'old@example.com', type: 'email', value: 'old@example.com' });
    const sf = t.smartFill((await t.open('acroform', '/typed.pdf')));
    await sf.loadProfiles();
    expect(sf.profile!.fields.find((f) => f.key === 'old')!.label).toBe('Email');
  });

  it('the Sign option also writes the date of the day on the "Data" line, and leaves it empty when Sign is off @FR-STM-01 @FR-AIF-04', async () => {
    const t = await createTestApp();
    const { pdf } = await flatFormDoc([
      { key: 'first_name', label: 'First name', kind: 'underline' },
      { key: 'signature', label: 'Firma', kind: 'dots' },
      { key: 'date', label: 'Data', kind: 'dots' },
    ]);
    t.files.put('/dated.pdf', pdf);
    const s = (await t.app.openRef(t.files.ref('/dated.pdf')))!;
    const sig = await t.services.signaturesRepo.add({ name: 'Formal', kind: 'signature', source: 'drawn', png: samplePng(120, 40), width: 120, height: 40 }, { encrypt: false });
    const m = t.profiles();
    await m.load();
    const p = (await m.create('Dated'))!;
    await m.updateField(p.id, (await m.addField(p.id, 'First name'))!, { value: 'Marta' });
    await m.setSignature(p.id, sig.id);
    const day = t.app.services.platform.clock.now();
    const expected = `${String(day.getDate()).padStart(2, '0')}/${String(day.getMonth() + 1).padStart(2, '0')}/${day.getFullYear()}`;
    const off = t.smartFill(s);
    await off.start();
    expect(off.dateLines).toBe(1);
    off.setSignIt(false);
    await off.apply(false);
    expect((await s.doc.listFormFields()).map((f) => f.value)).not.toContain(expected);
    await s.undo();
    const on = t.smartFill(s);
    await on.start();
    await on.apply(false);
    expect((await s.doc.listFormFields()).map((f) => f.value)).toContain(expected);
    expect((await s.doc.listAnnotations(0)).filter((a) => a.type === 'stamp').length).toBe(1);
  });
});
