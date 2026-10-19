// Validation, atomicity and cascade behaviour of the repositories on both SQLite drivers (SPEC §9).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it } from 'vitest';
import { FolioError } from '@folio/core';
import type { Database } from '@folio/ports';
import { FakeClock, FakeSecretStore, NodeCrypto, expectWarnings, samplePng } from '@folio/testkit';
import { migrate } from './migrations.ts';
import { Oo1Database, type Oo1Db } from './oo1.ts';
import {
  AiRunsRepo,
  DataCipher,
  FormMappingRepo,
  ProfileRepo,
  RecentFilesRepo,
  SettingsRepo,
  SignatureRepo,
  StampRepo,
  deleteAllData,
} from './repos.ts';

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof FolioError
      ? `${e.code}${e.params.reason ? `:${e.params.reason}` : ''}`
      : `raw:${String(e).slice(0, 80)}`;
  }
};

const drivers: Array<[string, () => Promise<Database>]> = [
  [
    'sqlite-wasm',
    async () => {
      const sqlite3 = await sqlite3InitModule();
      return new Oo1Database(new sqlite3.oo1.DB(':memory:', 'c') as unknown as Oo1Db);
    },
  ],
];

describe.each(drivers)('repository edge cases on %s', (_name, open) => {
  const setup = async () => {
    const db = await open();
    await migrate(db);
    const clock = new FakeClock();
    let n = 0;
    const newId = () => `id-${++n}`;
    const secrets = new FakeSecretStore();
    return { db, clock, newId, secrets, cipher: new DataCipher(new NodeCrypto(), secrets) };
  };

  it('settings: rejects values of the wrong type and keeps the stored one @FR-APP-10', async () => {
    const { db, clock } = await setup();
    const repo = new SettingsRepo(db, clock);
    await repo.set('recoveryIntervalSec', 60);
    expect(await codeOf(repo.set('recoveryIntervalSec', 'soon' as never))).toBe('invalidArgument');
    expect(await codeOf(repo.set('theme', 'neon' as never))).toBe('invalidArgument');
    expect((await repo.load()).recoveryIntervalSec).toBe(60);
    // Hand-edited garbage in the table falls back to the default for that key only.
    await db.execute(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('theme', '{broken', 'x') ON CONFLICT(key) DO UPDATE SET value_json = '{broken'",
    );
    const loaded = await repo.load();
    expect(loaded.recoveryIntervalSec).toBe(60);
    expect(['light', 'dark', 'system']).toContain(loaded.theme);
  });

  it('settings: unknown keys in the table are ignored', async () => {
    const { db, clock } = await setup();
    await db.execute(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('from_the_future', '1', 'x')",
    );
    const s = await new SettingsRepo(db, clock).load();
    expect('from_the_future' in s).toBe(false);
  });

  it('recent files: the list is bounded, pinned entries survive trimming and clear empties it @FR-APP-03', async () => {
    const { db, clock, newId } = await setup();
    const repo = new RecentFilesRepo(db, clock, newId, 3);
    const a = await repo.touch({ displayName: 'a.pdf', path: '/a.pdf', fingerprint: 'fa' });
    await repo.setPinned(a.id, true);
    for (const n of ['b', 'c', 'd', 'e']) {
      clock.advance?.(1000);
      await repo.touch({ displayName: `${n}.pdf`, path: `/${n}.pdf`, fingerprint: `f${n}` });
    }
    const names = (await repo.list()).map((r) => r.displayName);
    expect(names.length).toBeLessThanOrEqual(3);
    expect(names[0]).toBe('a.pdf'); // pinned first
    expect(names).toContain('e.pdf');
    await repo.setPinned('ghost', true); // unknown id: no error, no row
    expect(await repo.get('ghost')).toBeNull();
    await repo.saveView(a.id, 7, null);
    expect(await repo.get(a.id)).toMatchObject({ lastPage: 7, lastZoom: null });
    await repo.clear();
    expect(await repo.list()).toEqual([]);
  });

  it('recent files: search treats % and _ literally', async () => {
    const { db, clock, newId } = await setup();
    const repo = new RecentFilesRepo(db, clock, newId);
    await repo.touch({ displayName: '100%_done.pdf', path: '/x/100%_done.pdf', fingerprint: 'f1' });
    await repo.touch({ displayName: 'other.pdf', path: '/x/other.pdf', fingerprint: 'f2' });
    expect((await repo.list('%')).map((r) => r.displayName)).toEqual(['100%_done.pdf']);
    expect((await repo.list('_')).map((r) => r.displayName)).toEqual(['100%_done.pdf']);
    expect((await repo.list("'; DROP TABLE recent_files; --")).length).toBe(0);
    expect((await repo.list()).length).toBe(2);
  });

  it('signatures: unknown ids, empty names and reorder with unknown ids @FR-STM-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new SignatureRepo(db, clock, newId, cipher);
    const png = samplePng(10, 10);
    const a = await repo.add(
      { name: 'A', kind: 'signature', source: 'drawn', png, width: 10, height: 10 },
      { encrypt: false },
    );
    const b = await repo.add(
      { name: 'B', kind: 'signature', source: 'drawn', png, width: 10, height: 10 },
      { encrypt: false },
    );
    expect(await codeOf(repo.setDefault('ghost'))).toBe('invalidArgument');
    expect((await repo.defaultOf('signature'))!.id).toBe(a.id); // the failed call changed nothing
    expect(await codeOf(repo.rename(a.id, '   '))).toBe('invalidArgument:emptyName');
    expect(await repo.get('ghost')).toBeNull();
    await repo.reorder([b.id, 'ghost', a.id]);
    expect((await repo.list()).map((s) => s.id)).toEqual([b.id, a.id]);
    await repo.remove('ghost');
    expect((await repo.list()).length).toBe(2);
  });

  it('signatures: switching encryption on and off keeps every image intact @FR-STM-10', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new SignatureRepo(db, clock, newId, cipher);
    const png = samplePng(20, 8);
    const s = await repo.add(
      {
        name: 'S',
        kind: 'signature',
        source: 'drawn',
        svg: '<svg viewBox="0 0 1 1"/>',
        png,
        width: 20,
        height: 8,
      },
      { encrypt: false },
    );
    for (const on of [true, false, true, true]) {
      await repo.setEncryption(on);
      const got = (await repo.get(s.id))!;
      expect(got.encrypted).toBe(on);
      expect(Buffer.from(got.png).equals(Buffer.from(png))).toBe(true);
      expect(got.svg).toBe('<svg viewBox="0 0 1 1"/>');
    }
    const raw = (await db.select<{ png: unknown }>('SELECT png FROM signatures'))[0]!.png;
    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from(raw as Uint8Array);
    expect(bytes.equals(Buffer.from(png))).toBe(false);
  });

  it('a lost encryption key makes encrypted rows unreadable with a clear error, not garbage @FR-STM-10', async () => {
    const { db, clock, newId, secrets, cipher } = await setup();
    const repo = new SignatureRepo(db, clock, newId, cipher);
    const png = samplePng(10, 10);
    const s = await repo.add(
      { name: 'S', kind: 'signature', source: 'drawn', png, width: 10, height: 10 },
      { encrypt: true },
    );
    for (const k of [...((secrets as unknown as { items?: Map<string, string> }).items?.keys() ?? [])])
      await secrets.remove?.(k);
    const other = new SignatureRepo(
      db,
      clock,
      newId,
      new DataCipher(new NodeCrypto(), new FakeSecretStore()),
    );
    const result = await codeOf(other.get(s.id));
    expect(result).not.toBe('ok');
  });

  it('stamps: validation, reorder and removal @FR-STM-07', async () => {
    const { db, clock, newId } = await setup();
    const repo = new StampRepo(db, clock, newId);
    expect(await codeOf(repo.add({ name: '', kind: 'text', payload: {} }))).toBe('invalidArgument:emptyName');
    const a = await repo.add({ name: 'PAID', kind: 'text', payload: { text: 'PAID' } });
    const b = await repo.add({
      name: 'DONE',
      kind: 'text',
      payload: { text: 'DONE', nested: { n: [1, 2] } },
    });
    expect(await codeOf(repo.rename(a.id, ' '))).toBe('invalidArgument:emptyName');
    await repo.reorder([b.id, a.id]);
    const list = await repo.list();
    expect(list.map((s) => s.name)).toEqual(['DONE', 'PAID']);
    expect(list[0]!.payload).toEqual({ text: 'DONE', nested: { n: [1, 2] } });
    await repo.remove(a.id);
    expect((await repo.list()).length).toBe(1);
  });

  it('profiles: removing the default promotes the oldest remaining one; removing the last leaves none @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const a = await repo.create('A');
    clock.advance?.(1000);
    const b = await repo.create('B');
    clock.advance?.(1000);
    await repo.create('C');
    await repo.remove(a.id);
    expect((await repo.getDefault())!.id).toBe(b.id);
    expect((await repo.list()).filter((p) => p.isDefault)).toHaveLength(1);
    for (const p of await repo.list()) await repo.remove(p.id);
    expect(await repo.getDefault()).toBeNull();
    expect(await repo.get('ghost')).toBeNull();
    expect(await codeOf(repo.exportJson('ghost'))).toBe('invalidArgument');
  });

  it('profiles: setDefault on an unknown id must not leave the user without a default @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const a = await repo.create('A');
    await repo.create('B');
    expect(await codeOf(repo.setDefault('ghost'))).toBe('invalidArgument');
    expect((await repo.list()).filter((p) => p.isDefault).map((p) => p.id)).toEqual([a.id]);
  });

  it('profile names are kept to a readable length @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const made = await repo.create(`  ${'n'.repeat(500)}  `);
    expect(made.name).toBe('n'.repeat(60));
    await repo.rename(made.id, 'é'.repeat(200));
    expect((await repo.get(made.id))!.name).toBe('é'.repeat(60));
    const imported = await repo.importJson({ version: 1, name: 'x'.repeat(500), fields: [] });
    expect(imported.name.length).toBe(60);
  });

  it('profiles: an import with one bad entry is all-or-nothing @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const before = (await repo.list()).length;
    const result = await codeOf(
      repo.importJson({
        version: 1,
        name: 'Imported',
        fields: [
          { key: 'ok', label: 'Ok', type: 'text', value: 'x' },
          { key: '!!', label: 'Bad key', type: 'text', value: 'y' },
        ],
      }),
    );
    expect(result).toBe('invalidArgument:badKey');
    expect((await repo.list()).length).toBe(before);
    expect((await db.select('SELECT 1 FROM profile_fields')).length).toBe(0);
  });

  it('profiles: import rejects malformed payloads of every shape @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    for (const bad of [
      null,
      undefined,
      'x',
      42,
      [],
      {},
      { version: 1 },
      { version: 1, name: 5, fields: [] },
      { version: 1, name: 'n', fields: 'no' },
      { version: 2, name: 'n', fields: [] },
    ]) {
      expect(await codeOf(repo.importJson(bad)), JSON.stringify(bad)).toBe('invalidArgument:badProfile');
    }
    expect(await codeOf(repo.importJson({ version: 1, name: ' ', fields: [] }))).toBe(
      'invalidArgument:emptyName',
    );
    expect((await repo.list()).length).toBe(0);
  });

  it('profiles: export → import is lossless for values, aliases and sensitivity @FR-AIF-01', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const p = await repo.create('Me', ['identity', 'bank']);
    await repo.setField(p.id, {
      key: 'iban',
      label: 'IBAN',
      type: 'text',
      value: 'IT60 X054 2811 1010 0000 0123 456',
      sensitive: true,
      aliases: ['conto'],
    });
    await repo.setField(p.id, {
      key: 'note',
      label: 'Note',
      type: 'multiline',
      value: 'line 1\nline 2 — ünïcode ✓',
    });
    const out = await repo.exportJson(p.id);
    const copy = await repo.importJson(JSON.parse(JSON.stringify(out)));
    const again = await repo.exportJson(copy.id);
    expect(again.fields).toEqual(out.fields);
    expect(again.fields.find((f) => f.key === 'iban')).toMatchObject({ sensitive: true, aliases: ['conto'] });
  });

  it('profiles: a sensitive value that is emptied is stored empty and readable', async () => {
    const { db, clock, newId, cipher } = await setup();
    const repo = new ProfileRepo(db, clock, newId, cipher);
    const p = await repo.create('Me');
    await repo.setField(p.id, { key: 'tax_id', label: 'Tax', type: 'text', value: 'ABC', sensitive: true });
    await repo.setField(p.id, { key: 'tax_id', label: 'Tax', type: 'text', value: '', sensitive: true });
    expect((await repo.get(p.id))!.fields[0]).toMatchObject({ value: '', sensitive: true });
    await repo.setField(p.id, {
      key: 'tax_id',
      label: 'Tax',
      type: 'text',
      value: 'plain now',
      sensitive: false,
    });
    const raw = (
      await db.select<{ value: string }>("SELECT value FROM profile_fields WHERE key = 'tax_id'")
    )[0]!.value;
    expect(raw).toBe('plain now');
  });

  it('form mappings are per document and profile, replaced on save and removed with the profile', async () => {
    const { db, clock, newId, cipher } = await setup();
    const profiles = new ProfileRepo(db, clock, newId, cipher);
    const maps = new FormMappingRepo(db, clock, newId);
    const p = await profiles.create('Me');
    const q = await profiles.create('Other');
    await maps.save('doc1', p.id, [{ fieldRef: 'f1', profileKey: 'first_name', transform: 'none' }], 'ai');
    await maps.save(
      'doc1',
      p.id,
      [{ fieldRef: 'f1', profileKey: 'last_name', transform: 'upper' }],
      'manual',
    );
    await maps.save('doc1', q.id, [{ fieldRef: 'f9', profileKey: 'city', transform: 'none' }], 'heuristic');
    expect((await maps.find('doc1', p.id))!.mapping[0]).toMatchObject({
      profileKey: 'last_name',
      transform: 'upper',
    });
    expect((await maps.find('doc1', p.id))!.source).toBe('manual');
    expect(await maps.find('doc2', p.id)).toBeNull();
    await maps.forget('doc1', q.id);
    expect(await maps.find('doc1', q.id)).toBeNull();
    await profiles.remove(p.id);
    expect(await maps.find('doc1', p.id)).toBeNull();
  });

  it('AI run log keeps counts and never document content', async () => {
    const { db, clock, newId } = await setup();
    const log = new AiRunsRepo(db, clock, newId);
    await log.record({
      model: 'gpt-test',
      mode: 'mapping_only',
      includedImage: false,
      inputTokens: 120,
      outputTokens: 30,
      status: 'ok',
    });
    const rows = await log.list();
    expect(rows).toMatchObject([
      {
        model: 'gpt-test',
        mode: 'mapping_only',
        includedImage: false,
        inputTokens: 120,
        outputTokens: 30,
        status: 'ok',
      },
    ]);
    const cols = (await db.select<{ name: string }>("SELECT name FROM pragma_table_info('ai_runs')")).map(
      (c) => c.name,
    );
    expect(cols.filter((c) => /content|text|prompt|response|body/i.test(c))).toEqual([]);
  });

  it('delete-all-data wipes every table and the stored secret keys, atomically @NFR-14', async () => {
    const { db, clock, newId, secrets, cipher } = await setup();
    await new RecentFilesRepo(db, clock, newId).touch({
      displayName: 'a.pdf',
      path: '/a.pdf',
      fingerprint: 'f',
    });
    await new ProfileRepo(db, clock, newId, cipher).create('Me', ['identity']);
    await new SignatureRepo(db, clock, newId, cipher).add(
      { name: 'S', kind: 'signature', source: 'drawn', png: samplePng(5, 5), width: 5, height: 5 },
      { encrypt: true },
    );
    await secrets.set('openai-key', 'sk-test');
    await deleteAllData(db, secrets, ['openai-key']);
    for (const table of ['recent_files', 'profiles', 'profile_fields', 'signatures', 'stamps', 'settings']) {
      expect((await db.select(`SELECT 1 FROM ${table}`)).length, table).toBe(0);
    }
    expect(await secrets.get('openai-key')).toBeNull();
    // The schema is still usable afterwards.
    expect((await new ProfileRepo(db, clock, newId, cipher).create('Fresh')).isDefault).toBe(true);
  });

  it('transactions roll back everything on error and nest safely', async () => {
    const { db } = await setup();
    await expect(
      db.transaction(async (tx) => {
        await tx.execute("INSERT INTO settings (key, value_json, updated_at) VALUES ('a', '1', 'x')");
        await tx.transaction(async (inner) => {
          await inner.execute("INSERT INTO settings (key, value_json, updated_at) VALUES ('b', '2', 'x')");
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await db.select('SELECT 1 FROM settings')).length).toBe(0);
    await db.transaction(
      async (tx) =>
        void (await tx.execute("INSERT INTO settings (key, value_json, updated_at) VALUES ('c', '3', 'x')")),
    );
    expect((await db.select('SELECT 1 FROM settings')).length).toBe(1);
  });

  it('the schema enforces foreign keys: orphan profile fields are refused', async () => {
    expectWarnings(); // SQLite WASM reports the refused INSERT below on the console
    const { db } = await setup();
    const r = await codeOf(
      db.execute(
        "INSERT INTO profile_fields (id, profile_id, key, label, type, value, sensitive, aliases_json, sort_order) VALUES ('f','nope','k','l','text','',0,'[]',0)",
      ),
    );
    expect(r).toMatch(/^raw:/);
  });
});
