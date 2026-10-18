import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FolioError } from '@folio/core';
import type { Database } from '@folio/ports';
import { FakeClock, FakeSecretStore, InMemoryDatabase, NodeCrypto, samplePng } from '@folio/testkit';
import { MIGRATIONS, migrate, splitStatements } from './migrations.ts';
import { Oo1Database, type Oo1Db } from './oo1.ts';
import { AiRunsRepo, CertificateRepo, DataCipher, FieldTemplateRepo, FormMappingRepo, PROFILE_TEMPLATES, ProfileRepo, RecentFilesRepo, SettingsRepo, SignatureRepo, StampRepo, certSecretKey, deleteAllData } from './repos.ts';

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof FolioError ? `${e.code}${e.params.reason ? `:${e.params.reason}` : ''}` : `raw:${String(e).slice(0, 60)}`;
  }
};

// SPEC §9 / spike S5: the same migrations and repositories on Node SQLite and on SQLite WASM.
const drivers: Array<[string, () => Promise<Database>]> = [
  ['node:sqlite', async () => new InMemoryDatabase()],
  [
    'sqlite-wasm',
    async () => {
      const sqlite3 = await sqlite3InitModule();
      return new Oo1Database(new sqlite3.oo1.DB(':memory:', 'c') as unknown as Oo1Db);
    },
  ],
];

describe.each(drivers)('database on %s', (_name, open) => {
  const setup = async () => {
    const db = await open();
    await migrate(db);
    const clock = new FakeClock();
    let n = 0;
    const newId = () => `id-${++n}`;
    const secrets = new FakeSecretStore();
    const cipher = new DataCipher(new NodeCrypto(), secrets);
    return { db, clock, newId, secrets, cipher };
  };

  it('applies migrations once, in order, transactionally @FR-APP-10', async () => {
    const db = await open();
    expect(await migrate(db)).toEqual([1, 2, 3, 4, 5]);
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((t) => t.name);
    expect(tables).toEqual(['ai_runs', 'certificates', 'field_templates', 'form_mappings', 'history_spill', 'profile_fields', 'profiles', 'recent_files', 'schema_migrations', 'settings', 'signatures', 'stamps']);
    expect(splitStatements(MIGRATIONS[0]!.sql).length).toBe(10);
    const bad = [...MIGRATIONS, { version: 6, name: 'bad', sql: 'CREATE TABLE x (a INTEGER); CREATE TABLE x (a INTEGER);' }];
    await expect(migrate(db, bad)).rejects.toThrow();
    expect((await db.select("SELECT name FROM sqlite_master WHERE name='x'")).length).toBe(0);
    expect((await db.select('SELECT version FROM schema_migrations')).length).toBe(5);
  });

  it('the signature a profile named before becomes a signature entry @FR-FRM-20', async () => {
    const db = await open();
    await migrate(db, MIGRATIONS.slice(0, 4));
    await db.execute("INSERT INTO signatures (id, name, kind, source, png, width, height) VALUES ('s1', 'Mine', 'signature', 'drawn', x'00', 10, 5)");
    await db.execute("INSERT INTO profiles (id, name, signature_id) VALUES ('p1', 'A', 's1'), ('p2', 'B', NULL)");
    await db.execute("INSERT INTO profile_fields (id, profile_id, key, label, type, value) VALUES ('f1', 'p1', 'first_name', 'First name', 'text', 'Ada')");
    expect(await migrate(db)).toEqual([5]);
    const rows = await db.select<{ profile_id: string; key: string; type: string; value: string; sort_order: number }>('SELECT profile_id, key, type, value, sort_order FROM profile_fields ORDER BY profile_id, sort_order');
    expect(rows).toEqual([
      { profile_id: 'p1', key: 'first_name', type: 'text', value: 'Ada', sort_order: 0 },
      { profile_id: 'p1', key: 'signature', type: 'signature', value: 's1', sort_order: 1 },
    ]);
  });

  it('stores settings per key, validates them and resets to defaults @FR-APP-10', async () => {
    const { db, clock } = await setup();
    const repo = new SettingsRepo(db, clock);
    expect(await repo.load()).toEqual(DEFAULT_SETTINGS);
    await repo.set('theme', 'dark');
    await repo.set('units', 'in');
    await repo.set('recoveryIntervalSec', 60);
    await repo.set('ai', { ...DEFAULT_SETTINGS.ai, model: 'my-model', mode: 'with_values' });
    expect(await new SettingsRepo(db, clock).load()).toMatchObject({ theme: 'dark', units: 'in', recoveryIntervalSec: 60, ai: { model: 'my-model', mode: 'with_values', baseUrl: 'https://api.openai.com/v1' }, keepBackup: true });
    expect(await codeOf(repo.set('recoveryIntervalSec', 1))).toBe('invalidArgument');
    expect(await codeOf(repo.set('theme', 'neon' as 'dark'))).toBe('invalidArgument');
    await db.execute("INSERT INTO settings (key, value_json) VALUES ('units', '{broken')  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json");
    expect((await repo.load()).units).toBe('mm');
    expect(await repo.reset()).toEqual(DEFAULT_SETTINGS);
    expect(await repo.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps recent files: no duplicates, last page and zoom, search, pin, bounded list @FR-APP-03 @FR-VIEW-08', async () => {
    const { db, clock, newId } = await setup();
    const repo = new RecentFilesRepo(db, clock, newId, 3);
    const thumb = samplePng(8, 8);
    const a = await repo.touch({ displayName: 'a.pdf', path: '/docs/a.pdf', fingerprint: 'fa', pageCount: 3, thumbnail: thumb });
    expect(a).toMatchObject({ displayName: 'a.pdf', pageCount: 3, lastPage: 0, pinned: false });
    expect(Buffer.from(a.thumbnail!).equals(Buffer.from(thumb))).toBe(true);
    clock.advance(1000);
    await repo.touch({ displayName: 'b.pdf', path: '/work/b.pdf', fingerprint: 'fb' });
    clock.advance(1000);
    const again = await repo.touch({ displayName: 'a.pdf', path: '/docs/a.pdf', fingerprint: 'fa2', pageCount: 4 });
    expect(again.id).toBe(a.id);
    expect(again.thumbnail).not.toBeNull();
    expect((await repo.list()).map((r) => r.displayName)).toEqual(['a.pdf', 'b.pdf']);
    await repo.saveView(a.id, 7, 1.25);
    expect(await repo.get(a.id)).toMatchObject({ lastPage: 7, lastZoom: 1.25, fingerprint: 'fa2', pageCount: 4 });
    // Web build: no path, identity by fingerprint.
    const w1 = await repo.touch({ displayName: 'web.pdf', fingerprint: 'fw' });
    expect((await repo.touch({ displayName: 'web renamed.pdf', fingerprint: 'fw' })).id).toBe(w1.id);
    expect((await repo.list('work')).map((r) => r.displayName)).toEqual(['b.pdf']);
    expect((await repo.list('WEB')).length).toBe(1);
    const b = (await repo.list('b.pdf'))[0]!;
    await repo.setPinned(b.id, true);
    clock.advance(1000);
    await repo.touch({ displayName: 'c.pdf', path: '/c.pdf', fingerprint: 'fc' });
    clock.advance(1000);
    await repo.touch({ displayName: 'd.pdf', path: '/d.pdf', fingerprint: 'fd' });
    expect((await repo.list()).map((r) => r.displayName)).toEqual(['b.pdf', 'd.pdf', 'c.pdf']);
    await repo.remove(b.id);
    expect((await repo.list()).length).toBe(2);
    await repo.clear();
    expect(await repo.list()).toEqual([]);
  });

  it('stores signatures and initials with one default per kind @FR-STM-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new SignatureRepo(db, clock, newId, cipher);
    const png = samplePng(30, 10);
    const s1 = await repo.add({ name: ' Formal ', kind: 'signature', source: 'drawn', svg: '<svg/>', png, width: 120, height: 48 }, { encrypt: false });
    const s2 = await repo.add({ name: 'Quick', kind: 'signature', source: 'typed', png, width: 90, height: 48 }, { encrypt: false });
    const i1 = await repo.add({ name: 'ME', kind: 'initials', source: 'image', png, width: 40, height: 32 }, { encrypt: false });
    expect(s1).toMatchObject({ name: 'Formal', isDefault: true, svg: '<svg/>', encrypted: false, width: 120 });
    expect([s2.isDefault, i1.isDefault]).toEqual([false, true]);
    expect(Buffer.from(s1.png).equals(Buffer.from(png))).toBe(true);
    expect((await repo.list()).map((s) => s.name)).toEqual(['Formal', 'Quick', 'ME']);
    expect((await repo.list('initials')).map((s) => s.name)).toEqual(['ME']);
    await repo.setDefault(s2.id);
    expect((await repo.defaultOf('signature'))!.id).toBe(s2.id);
    expect((await repo.defaultOf('initials'))!.id).toBe(i1.id);
    await repo.rename(s2.id, 'Fast');
    await repo.reorder([s2.id, i1.id, s1.id]);
    expect((await repo.list()).map((s) => s.name)).toEqual(['Fast', 'ME', 'Formal']);
    await repo.remove(s2.id);
    expect((await repo.defaultOf('signature'))!.id).toBe(s1.id);
    expect(await codeOf(repo.add({ name: ' ', kind: 'signature', source: 'drawn', png, width: 1, height: 1 }, { encrypt: false }))).toBe('invalidArgument:emptyName');
    expect(await codeOf(db.execute("INSERT INTO signatures (id, name, kind, source, png, width, height) VALUES ('x','x','bogus','drawn','', 1, 1)"))).toMatch(/^raw:/);
    expect(await repo.defaultOf('initials')).not.toBeNull();
    await repo.remove(i1.id);
    expect(await repo.defaultOf('initials')).toBeNull();
  });

  it('encrypts stored signatures at rest with a key kept in the secret store @FR-STM-10', async () => {
    const { db, clock, newId, cipher, secrets } = await setup();
    const repo = new SignatureRepo(db, clock, newId, cipher);
    const png = samplePng(30, 10);
    const svg = '<svg viewBox="0 0 10 10"><path d="M1 1L9 9"/></svg>';
    const plain = await repo.add({ name: 'Plain', kind: 'signature', source: 'drawn', svg, png, width: 100, height: 48 }, { encrypt: false });
    const secret = await repo.add({ name: 'Secret', kind: 'signature', source: 'drawn', svg, png, width: 100, height: 48 }, { encrypt: true });
    expect(secret.encrypted).toBe(true);
    expect(Buffer.from(secret.png).equals(Buffer.from(png))).toBe(true);
    expect(secret.svg).toBe(svg);
    const raw = async (id: string) => (await db.select<{ png: string; svg: string; encrypted: number }>('SELECT png, svg, encrypted FROM signatures WHERE id = ?', [id]))[0]!;
    const stored = await raw(secret.id);
    expect(stored.svg).not.toContain('<svg');
    expect(stored.png).not.toBe((await raw(plain.id)).png);
    expect(secrets.values.get('folio.data-key')).toMatch(/^[0-9a-f]{64}$/);
    expect(await repo.setEncryption(true)).toBe(1);
    expect((await raw(plain.id)).encrypted).toBe(1);
    expect((await repo.get(plain.id))!.svg).toBe(svg);
    expect(await repo.setEncryption(false)).toBe(2);
    expect((await raw(secret.id)).svg).toBe(svg);
    // Without the key (another machine, wiped keychain) the data cannot be read.
    await repo.setEncryption(true);
    await secrets.remove('folio.data-key');
    expect(await codeOf(repo.list())).toBe('invalidArgument:noKey');
    await secrets.set('folio.data-key', '00'.repeat(32));
    expect(await codeOf(repo.list())).toBe('invalidArgument');
  });

  it('stores custom stamps: add, rename, reorder, delete @FR-STM-07', async () => {
    const { db, clock, newId } = await setup();
    const repo = new StampRepo(db, clock, newId);
    const a = await repo.add({ name: 'Received', kind: 'text', payload: { text: 'RECEIVED', color: { r: 1, g: 2, b: 3 }, rotation: 12 } });
    const b = await repo.add({ name: 'Logo', kind: 'image', payload: {}, png: samplePng(10, 10) });
    const c = await repo.add({ name: 'Clip', kind: 'selection', payload: { from: 'page 2' }, png: samplePng(5, 5) });
    expect(a).toMatchObject({ kind: 'text', payload: { text: 'RECEIVED', rotation: 12 }, png: null });
    expect(b.png!.length).toBe(samplePng(10, 10).length);
    await repo.rename(c.id, 'Clipping');
    await repo.reorder([c.id, a.id, b.id]);
    expect((await repo.list()).map((s) => s.name)).toEqual(['Clipping', 'Received', 'Logo']);
    await repo.remove(a.id);
    expect((await repo.list()).length).toBe(2);
    expect(await codeOf(repo.add({ name: '', kind: 'text', payload: {} }))).toBe('invalidArgument:emptyName');
  });

  it('manages profiles: templates, entries, default, import and export @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const p = await repo.create('Personal', ['identity', 'address', 'contacts']);
    expect(p).toMatchObject({ name: 'Personal', isDefault: true });
    expect(p.fields.length).toBe(PROFILE_TEMPLATES.identity!.length + PROFILE_TEMPLATES.address!.length + PROFILE_TEMPLATES.contacts!.length);
    expect(p.fields.find((f) => f.key === 'first_name')).toMatchObject({ label: 'First name', type: 'text', value: '', sensitive: false });
    expect(p.fields.find((f) => f.key === 'first_name')!.aliases).toContain('nome');
    await repo.setField(p.id, { key: 'first_name', label: 'First name', type: 'text', value: 'Marta', aliases: ['nome'] });
    await repo.setField(p.id, { key: 'Pet Name!', label: 'Pet', type: 'text', value: 'Fido' });
    await repo.setField(p.id, { key: 'tax_id', label: 'Tax code', type: 'text', value: 'SMPMRT88D63D612X', sensitive: true });
    const loaded = (await repo.get(p.id))!;
    expect(loaded.fields.find((f) => f.key === 'pet_name')!.value).toBe('Fido');
    expect(loaded.fields.find((f) => f.key === 'tax_id')).toMatchObject({ value: 'SMPMRT88D63D612X', sensitive: true });
    const rawTax = (await db.select<{ value: string }>("SELECT value FROM profile_fields WHERE key = 'tax_id'"))[0]!.value;
    expect(rawTax.startsWith('enc:')).toBe(true);
    expect(rawTax).not.toContain('SMPMRT');
    expect(loaded.fields.filter((f) => f.key === 'first_name').length).toBe(1);
    const company = await repo.create('Company', ['company']);
    expect(company.isDefault).toBe(false);
    await repo.setDefault(company.id);
    expect((await repo.getDefault())!.name).toBe('Company');
    await repo.rename(company.id, 'Work');
    await repo.removeField(p.id, 'pet_name');
    // A signature entry holds the id of a saved signature: stored as is, never written to an export file.
    await repo.setField(p.id, { key: 'signature', label: 'Signature', type: 'signature', value: 'sig-1', aliases: ['firma'] });
    expect((await repo.get(p.id))!.fields.find((f) => f.key === 'signature')).toMatchObject({ type: 'signature', value: 'sig-1', aliases: ['firma'] });
    expect((await repo.exportJson(p.id)).fields.find((f) => f.key === 'signature')).toMatchObject({ type: 'signature', value: '' });
    const exported = await repo.exportJson(p.id);
    expect(exported).toMatchObject({ version: 1, name: 'Personal' });
    expect(exported.fields.find((f) => f.key === 'tax_id')!.value).toBe('SMPMRT88D63D612X');
    const copy = await repo.importJson(JSON.parse(JSON.stringify({ ...exported, name: 'Imported', fields: [...exported.fields, { key: 'x', label: 'x', type: 'bogus', value: '' }, null] })));
    expect(copy.name).toBe('Imported');
    expect(copy.fields.length).toBe(exported.fields.length);
    expect(copy.fields.find((f) => f.key === 'first_name')!.value).toBe('Marta');
    expect(await codeOf(repo.importJson({ version: 3 }))).toBe('invalidArgument:badProfile');
    expect(await codeOf(repo.create(' '))).toBe('invalidArgument:emptyName');
    expect(await codeOf(repo.setField(p.id, { key: '!!', label: 'x', type: 'text', value: '' }))).toBe('invalidArgument:badKey');
    await repo.remove(company.id);
    expect((await repo.list()).map((x) => [x.name, x.isDefault])).toEqual([['Personal', true], ['Imported', false]]);
    expect((await db.select('SELECT id FROM profile_fields WHERE profile_id = ?', [company.id])).length).toBe(0);
  });

  it('associates a saved signature with a profile; deleting the signature clears it @FR-STM-01 @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const sigs = new SignatureRepo(db, clock, newId, cipher);
    const profiles = new ProfileRepo(db, clock, newId, cipher);
    const sig = await sigs.add({ name: 'Formal', kind: 'signature', source: 'drawn', png: samplePng(30, 10), width: 120, height: 48 }, { encrypt: false });
    const p = await profiles.create('Personal');
    expect(p.signatureId).toBeNull();
    await profiles.setSignature(p.id, sig.id);
    expect((await profiles.get(p.id))!.signatureId).toBe(sig.id);
    expect((await profiles.duplicate(p.id)).signatureId).toBe(sig.id);
    await expect(profiles.setSignature(p.id, 'nope')).rejects.toThrow('Unknown signature');
    await sigs.remove(sig.id);
    expect((await profiles.get(p.id))!.signatureId).toBeNull();
    await profiles.setSignature(p.id, null);
  });

  it('remembers form mappings per form and profile, and logs AI runs without content @FR-AIF-08', async () => {
    const { db, clock, newId, cipher, secrets } = await setup();
    const profiles = new ProfileRepo(db, clock, newId, cipher);
    const p = await profiles.create('Personal');
    const repo = new FormMappingRepo(db, clock, newId);
    expect(await repo.find('fp1', p.id)).toBeNull();
    await repo.save('fp1', p.id, [{ fieldRef: 'person.name', profileKey: 'full_name', transform: 'none' }], 'ai');
    await repo.save('fp1', p.id, [{ fieldRef: 'person.name', profileKey: 'full_name', transform: 'upper' }, { fieldRef: 'p1-a2', profileKey: 'email', transform: 'none' }], 'manual');
    const found = (await repo.find('fp1', p.id))!;
    expect(found).toMatchObject({ source: 'manual', docFingerprint: 'fp1' });
    expect(found.mapping.map((m) => m.transform)).toEqual(['upper', 'none']);
    expect(await repo.find('fp2', p.id)).toBeNull();
    await repo.forget('fp1', p.id);
    expect(await repo.find('fp1', p.id)).toBeNull();
    await repo.save('fp1', p.id, [], 'heuristic');
    await profiles.remove(p.id);
    expect((await db.select<{ profile_id: string | null }>('SELECT profile_id FROM form_mappings'))[0]!.profile_id).toBeNull();
    const runs = new AiRunsRepo(db, clock, newId);
    await runs.record({ model: 'm', mode: 'mapping_only', includedImage: false, inputTokens: 1200, outputTokens: 300, status: 'ok' });
    clock.advance(1000);
    await runs.record({ model: 'm', mode: 'with_values', includedImage: true, status: 'error:unauthorized' });
    expect((await runs.list()).map((r) => [r.mode, r.includedImage, r.inputTokens, r.status])).toEqual([['with_values', true, undefined, 'error:unauthorized'], ['mapping_only', false, 1200, 'ok']]);
    expect((await db.select<{ name: string }>("SELECT name FROM pragma_table_info('ai_runs')")).map((c) => c.name)).toEqual(['id', 'at', 'model', 'mode', 'included_image', 'input_tokens', 'output_tokens', 'status']);
    await secrets.set('folio.openai-key', 'sk-test');
    await deleteAllData(db, secrets, ['folio.openai-key']);
    for (const table of ['settings', 'recent_files', 'signatures', 'stamps', 'profiles', 'form_mappings', 'ai_runs', 'certificates']) expect((await db.select(`SELECT * FROM ${table}`)).length).toBe(0);
    expect(secrets.values.size).toBe(0);
  });

  it('stores certificates by fingerprint and kind, refreshes duplicates and wipes identity secrets @FR-CRT-03 @FR-CRT-04', async () => {
    const { db, clock, secrets } = await setup();
    const repo = new CertificateRepo(db, clock);
    const base = { commonName: 'Ada', subject: 'CN=Ada', issuer: 'CN=Root', serial: '01', notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z', keyAlgorithm: 'RSA', keyUsage: ['digitalSignature'], selfSigned: false, isCa: false, der: new Uint8Array([1, 2, 3, 255]) };
    await repo.upsert({ ...base, fingerprint: 'aa', kind: 'identity' });
    await repo.upsert({ ...base, fingerprint: 'aa', kind: 'trusted' });
    await repo.upsert({ ...base, fingerprint: 'bb', kind: 'trusted', commonName: 'bob' });
    await repo.upsert({ ...base, fingerprint: 'aa', kind: 'identity', commonName: 'Ada L.' });
    expect((await repo.list('identity')).map((c) => [c.fingerprint, c.commonName])).toEqual([['aa', 'Ada L.']]);
    expect((await repo.list('trusted')).map((c) => c.fingerprint)).toEqual(['aa', 'bb']);
    expect((await repo.get('aa', 'identity'))!.der).toEqual(new Uint8Array([1, 2, 3, 255]));
    expect((await repo.get('aa', 'identity'))!.keyUsage).toEqual(['digitalSignature']);
    // No column can hold private key material.
    const cols = (await db.select<{ name: string }>("SELECT name FROM pragma_table_info('certificates')")).map((c) => c.name);
    expect(cols.filter((c) => /key(?!_)|private|pkcs|password|secret|p12/i.test(c.replace('key_algorithm', '').replace('key_usage_json', '')))).toEqual([]);
    await repo.remove('aa', 'trusted');
    expect((await repo.list('trusted')).map((c) => c.fingerprint)).toEqual(['bb']);
    await secrets.set(certSecretKey('aa'), '{"p12":"AA=="}');
    await deleteAllData(db, secrets);
    expect(await secrets.get(certSecretKey('aa'))).toBeNull();
    expect(await repo.list()).toEqual([]);
  });

  it('duplicates, reorders and edits profile entries with typed options and validation @FR-FRM-20', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const p = await repo.create('Work', []);
    await repo.setField(p.id, { key: 'level', label: 'Level', type: 'choice', value: 'B', options: ['A', 'B', ' B ', ''] });
    await repo.setField(p.id, { key: 'born', label: 'Born', type: 'date', value: '1988-04-23' });
    await repo.setField(p.id, { key: 'secret', label: 'Secret', type: 'text', value: 'hunter2', sensitive: true });
    expect((await repo.get(p.id))!.fields.find((f) => f.key === 'level')).toMatchObject({ type: 'choice', options: ['A', 'B'], value: 'B' });
    // Validation: unique key by repo slug, dates exist, e-mail and numbers are shaped.
    expect(await codeOf(repo.setField(p.id, { key: 'b', label: 'B', type: 'date', value: '2026-02-31' }))).toBe('invalidArgument:badDate');
    expect(await codeOf(repo.setField(p.id, { key: 'b', label: 'B', type: 'email', value: 'not an email' }))).toBe('invalidArgument:badEmail');
    expect(await codeOf(repo.setField(p.id, { key: 'b', label: 'B', type: 'number', value: '12x' }))).toBe('invalidArgument:badNumber');
    expect(await codeOf(repo.setField(p.id, { key: 'b', label: 'B', type: 'phone', value: '+39 055 555 0123' }))).toBe('ok');
    expect(await codeOf(repo.setField(p.id, { key: 'c', label: 'C', type: 'email', value: '' }))).toBe('ok');
    // Reorder: listed keys first, the rest after.
    await repo.reorder(p.id, ['secret', 'born']);
    expect((await repo.get(p.id))!.fields.map((f) => f.key)).toEqual(['secret', 'born', 'level', 'b', 'c']);
    // Duplicate keeps values (also the encrypted one) and is a separate profile.
    const copy = await repo.duplicate(p.id);
    expect(copy.name).toBe('Work copy');
    expect(copy.isDefault).toBe(false);
    expect(copy.fields.map((f) => [f.key, f.value, f.sensitive])).toEqual((await repo.get(p.id))!.fields.map((f) => [f.key, f.value, f.sensitive]));
    await repo.setField(copy.id, { key: 'born', label: 'Born', type: 'date', value: '2000-01-01' });
    expect((await repo.get(p.id))!.fields.find((f) => f.key === 'born')!.value).toBe('1988-04-23');
    expect((await db.select<{ value: string }>("SELECT value FROM profile_fields WHERE key = 'secret' AND profile_id = ?", [copy.id]))[0]!.value.startsWith('enc:')).toBe(true);
  });

  it('keys stay stable when the label changes; renaming a key forgets only the mappings that used it @FR-FRM-20', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const mappings = new FormMappingRepo(db, clock, newId);
    const p = await repo.create('Me', ['identity']);
    await repo.setField(p.id, { key: 'first_name', label: 'Given name (renamed)', type: 'text', value: 'Marta' });
    const first = (await repo.get(p.id))!.fields.find((f) => f.key === 'first_name')!;
    expect(first.label).toBe('Given name (renamed)');
    await mappings.save('form-a', p.id, [{ fieldRef: 'a', profileKey: 'first_name', transform: 'none' }, { fieldRef: 'b', profileKey: 'last_name', transform: 'none' }], 'manual');
    await mappings.save('form-b', p.id, [{ fieldRef: 'x', profileKey: 'first_name', transform: 'none' }], 'ai');
    await mappings.save('form-c', p.id, [{ fieldRef: 'y', profileKey: 'email', transform: 'none' }], 'ai');
    expect(await repo.renameKey(p.id, 'first_name', 'Given Name')).toBe('given_name');
    expect(await mappings.dropKey(p.id, 'first_name')).toBe(2);
    expect((await mappings.find('form-a', p.id))!.mapping).toEqual([{ fieldRef: 'b', profileKey: 'last_name', transform: 'none' }]);
    expect(await mappings.find('form-b', p.id)).toBeNull();
    expect((await mappings.find('form-c', p.id))!.mapping.length).toBe(1);
    expect(await codeOf(repo.renameKey(p.id, 'given_name', 'last_name'))).toBe('invalidArgument:keyTaken');
    expect(await codeOf(repo.renameKey(p.id, 'given_name', '  !!  '))).toBe('invalidArgument:badKey');
  });

  it('field templates: built-in sets are read-only, user templates are edited, saved from a profile and added without duplicates @FR-FRM-20', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const templates = new FieldTemplateRepo(db, clock, newId);
    const all = await templates.list();
    expect(all.filter((t) => t.builtIn).map((t) => t.name)).toEqual(Object.keys(PROFILE_TEMPLATES));
    expect(await codeOf(templates.update(all[0]!.id, { name: 'x' }))).toBe('invalidArgument:builtInTemplate');
    expect(await codeOf(templates.remove(all[0]!.id))).toBe('invalidArgument:builtInTemplate');
    const mine = await templates.create('Header', [
      { key: 'name', label: 'Name', type: 'text', aliases: ['nome'], sensitive: false, options: [] },
      { key: 'Address', label: 'Address', type: 'address', aliases: [], sensitive: false, options: [] },
      { key: 'name', label: 'Duplicate', type: 'text', aliases: [], sensitive: false, options: [] },
      { key: 'date', label: 'Date', type: 'bogus' as never, aliases: [], sensitive: false, options: [] },
    ]);
    expect(mine.fields.map((f) => [f.key, f.type])).toEqual([['name', 'text'], ['address', 'address'], ['date', 'text']]);
    const renamed = await templates.update(mine.id, { name: 'Letter header' });
    expect(renamed.name).toBe('Letter header');
    expect((await templates.duplicate(all[0]!.id)).builtIn).toBe(false);
    // From a profile: structure only, never a value.
    const p = await repo.create('Me', []);
    await repo.setField(p.id, { key: 'iban', label: 'IBAN', type: 'text', value: 'IT60X0542811101000000123456', sensitive: true });
    await repo.setField(p.id, { key: 'name', label: 'Name', type: 'text', value: 'Marta' });
    const saved = await templates.fromProfile((await repo.get(p.id))!, 'From Me');
    expect(JSON.stringify(saved)).not.toContain('IT60');
    expect(JSON.stringify(saved)).not.toContain('Marta');
    expect(saved.fields.map((f) => f.key)).toEqual(['iban', 'name']);
    // Add to a second profile: duplicates are skipped and listed.
    const q = await repo.create('Other', []);
    await repo.setField(q.id, { key: 'name', label: 'Name', type: 'text', value: 'Keep me' });
    expect(await repo.addTemplate(q.id, renamed.fields)).toEqual({ added: ['address', 'date'], skipped: ['name'] });
    const after = (await repo.get(q.id))!.fields;
    expect(after.find((f) => f.key === 'name')!.value).toBe('Keep me');
    expect(after.find((f) => f.key === 'address')!.value).toBe('');
    await templates.remove(mine.id);
    expect((await templates.get(mine.id))).toBeNull();
  });

  it('exports and imports profiles and templates, and refuses a newer template version @FR-FRM-20', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const templates = new FieldTemplateRepo(db, clock, newId);
    const p = await repo.create('Me', []);
    await repo.setField(p.id, { key: 'size', label: 'Size', type: 'choice', value: 'M', options: ['S', 'M', 'L'], aliases: ['taglia'] });
    await repo.setField(p.id, { key: 'name', label: 'Name', type: 'text', value: 'Marta', sensitive: true });
    const out = await repo.exportJson(p.id);
    expect(out.version).toBe(1);
    const back = await repo.importJson(JSON.parse(JSON.stringify(out)));
    expect(back.fields.map(({ key, label, type, value, sensitive, aliases, options }) => ({ key, label, type, value, sensitive, aliases, options }))).toEqual(
      (await repo.get(p.id))!.fields.map(({ key, label, type, value, sensitive, aliases, options }) => ({ key, label, type, value, sensitive, aliases, options })),
    );
    const t = await templates.create('Sizes', [{ key: 'size', label: 'Size', type: 'choice', aliases: ['taglia'], sensitive: false, options: ['S', 'M'] }]);
    const file = JSON.parse(JSON.stringify(templates.exportJson(t))) as ReturnType<FieldTemplateRepo['exportJson']>;
    expect(file).toMatchObject({ version: 1, kind: 'folio-field-template', name: 'Sizes' });
    const imported = await templates.importJson(file);
    expect({ ...imported, id: '' }).toEqual({ ...t, id: '' });
    expect(await codeOf(templates.importJson({ ...file, version: 2 }))).toBe('invalidArgument:templateNewer');
    expect(await codeOf(templates.importJson({ nope: true }))).toBe('invalidArgument:badTemplate');
    expect(await codeOf(templates.importJson({ ...file, kind: 'profile' }))).toBe('invalidArgument:badTemplate');
  });
});
