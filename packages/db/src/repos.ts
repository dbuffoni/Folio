import { DEFAULT_SETTINGS, InvalidArgumentError, fromBase64, fromHex, parseSettings, toBase64, toHex, utf8, type Settings, type SettingsKey } from '@folio/core';
import type { Clock, CryptoService, Database, SecretStore } from '@folio/ports';

const iso = (clock: Clock): string => clock.now().toISOString();
const bool = (v: unknown): boolean => Number(v) === 1;

// Binary values are stored base64-encoded so every driver (Node SQLite, SQLite WASM, the Tauri SQL
// plugin, which serialises parameters as JSON) round-trips them identically. See ADR 0005.
const enc = (b: Uint8Array | null | undefined): string | null => (b ? toBase64(b) : null);
const dec = (v: unknown): Uint8Array | null => (typeof v === 'string' ? fromBase64(v) : v instanceof Uint8Array ? v : null);

// ---- settings --------------------------------------------------------------------------------

/** FR-APP-10. One row per top-level key; unknown or invalid rows fall back to defaults on load. */
export class SettingsRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  async load(): Promise<Settings> {
    const rows = await this.db.select<{ key: string; value_json: string }>('SELECT key, value_json FROM settings');
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value_json);
      } catch {
        // ignored: falls back to the default
      }
    }
    return parseSettings(raw);
  }
  async set<K extends SettingsKey>(key: K, value: Settings[K]): Promise<Settings> {
    const next = parseSettings({ ...(await this.load()), [key]: value });
    if (JSON.stringify(next[key]) !== JSON.stringify(value)) throw new InvalidArgumentError(`Invalid value for setting "${key}"`, { key });
    await this.db.execute('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at', [key, JSON.stringify(value), iso(this.clock)]);
    return next;
  }
  /** Reset to defaults. */
  async reset(): Promise<Settings> {
    await this.db.execute('DELETE FROM settings');
    return { ...DEFAULT_SETTINGS };
  }
}

// ---- recent files ----------------------------------------------------------------------------

export interface RecentFile {
  id: string;
  displayName: string;
  path: string | null;
  fingerprint: string;
  pageCount: number | null;
  lastPage: number;
  lastZoom: number | null;
  thumbnail: Uint8Array | null;
  lastOpenedAt: string;
  pinned: boolean;
}
type RecentRow = { id: string; display_name: string; path: string | null; fingerprint: string; page_count: number | null; last_page: number | null; last_zoom: number | null; thumbnail: unknown; last_opened_at: string; pinned: number };
const toRecent = (r: RecentRow): RecentFile => ({ id: r.id, displayName: r.display_name, path: r.path, fingerprint: r.fingerprint, pageCount: r.page_count, lastPage: r.last_page ?? 0, lastZoom: r.last_zoom, thumbnail: dec(r.thumbnail), lastOpenedAt: r.last_opened_at, pinned: bool(r.pinned) });

export class RecentFilesRepo {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly newId: () => string, private readonly max = 50) {}

  /** Records an open. The same file (by path, else by fingerprint) is updated, not duplicated. */
  async touch(file: { displayName: string; path?: string | null; fingerprint: string; pageCount?: number; thumbnail?: Uint8Array | null }): Promise<RecentFile> {
    const existing = file.path
      ? await this.db.select<RecentRow>('SELECT * FROM recent_files WHERE path = ? LIMIT 1', [file.path])
      : await this.db.select<RecentRow>('SELECT * FROM recent_files WHERE path IS NULL AND fingerprint = ? LIMIT 1', [file.fingerprint]);
    const id = existing[0]?.id ?? this.newId();
    const now = iso(this.clock);
    if (existing[0]) {
      await this.db.execute('UPDATE recent_files SET display_name = ?, fingerprint = ?, page_count = ?, thumbnail = COALESCE(?, thumbnail), last_opened_at = ? WHERE id = ?', [file.displayName, file.fingerprint, file.pageCount ?? null, enc(file.thumbnail), now, id]);
    } else {
      await this.db.execute('INSERT INTO recent_files (id, display_name, path, fingerprint, page_count, thumbnail, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, file.displayName, file.path ?? null, file.fingerprint, file.pageCount ?? null, enc(file.thumbnail), now]);
      // Keep the list bounded; pinned entries never fall off.
      await this.db.execute('DELETE FROM recent_files WHERE pinned = 0 AND id NOT IN (SELECT id FROM recent_files ORDER BY pinned DESC, last_opened_at DESC LIMIT ?)', [this.max]);
    }
    return (await this.get(id))!;
  }
  async get(id: string): Promise<RecentFile | null> {
    const rows = await this.db.select<RecentRow>('SELECT * FROM recent_files WHERE id = ?', [id]);
    return rows[0] ? toRecent(rows[0]) : null;
  }
  /** Pinned first, then most recently opened. `search` filters by name or folder. */
  async list(search = ''): Promise<RecentFile[]> {
    const rows = await this.db.select<RecentRow>('SELECT * FROM recent_files ORDER BY pinned DESC, last_opened_at DESC');
    const needle = search.trim().toLowerCase();
    return rows.map(toRecent).filter((r) => !needle || r.displayName.toLowerCase().includes(needle) || (r.path ?? '').toLowerCase().includes(needle));
  }
  /** Remember where the user was (FR-VIEW-08). */
  async saveView(id: string, lastPage: number, lastZoom: number | null): Promise<void> {
    await this.db.execute('UPDATE recent_files SET last_page = ?, last_zoom = ? WHERE id = ?', [lastPage, lastZoom, id]);
  }
  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.db.execute('UPDATE recent_files SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
  }
  async remove(id: string): Promise<void> {
    await this.db.execute('DELETE FROM recent_files WHERE id = ?', [id]);
  }
  /** "Clear recent files" (SPEC §12.9). */
  async clear(): Promise<void> {
    await this.db.execute('DELETE FROM recent_files');
  }
}

// ---- at-rest encryption ----------------------------------------------------------------------

const KEY_NAME = 'folio.data-key';
/** AES-256-GCM for stored signatures and sensitive profile values (FR-STM-10, SPEC §12.5). */
export class DataCipher {
  constructor(private readonly crypto: CryptoService, private readonly secrets: SecretStore) {}
  private async key(create: boolean): Promise<Uint8Array | null> {
    const stored = await this.secrets.get(KEY_NAME);
    if (stored) return fromHex(stored);
    if (!create) return null;
    const key = this.crypto.randomBytes(32);
    await this.secrets.set(KEY_NAME, toHex(key));
    return key;
  }
  async encrypt(plain: Uint8Array): Promise<Uint8Array> {
    return this.crypto.encrypt((await this.key(true))!, plain);
  }
  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    const key = await this.key(false);
    if (!key) throw new InvalidArgumentError('The encryption key is not available on this device', { reason: 'noKey' });
    return this.crypto.decrypt(key, data);
  }
  encryptText = async (s: string): Promise<string> => toBase64(await this.encrypt(utf8.encode(s)));
  decryptText = async (s: string): Promise<string> => utf8.decode(await this.decrypt(fromBase64(s)));
}

// ---- signatures ------------------------------------------------------------------------------

export interface StoredSignature {
  id: string;
  name: string;
  kind: 'signature' | 'initials';
  source: 'drawn' | 'typed' | 'image';
  svg: string | null;
  /** PNG bytes (transparent). */
  png: Uint8Array;
  width: number;
  height: number;
  encrypted: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
}
type SigRow = { id: string; name: string; kind: StoredSignature['kind']; source: StoredSignature['source']; svg: string | null; png: unknown; width: number; height: number; encrypted: number; is_default: number; sort_order: number; created_at: string };

/** FR-STM-01 signature and initials library, optionally encrypted at rest (FR-STM-10). */
export class SignatureRepo {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly newId: () => string, private readonly cipher: DataCipher) {}

  private async fromRow(r: SigRow): Promise<StoredSignature> {
    const encrypted = bool(r.encrypted);
    let png = dec(r.png)!;
    let svg = r.svg;
    if (encrypted) {
      png = await this.cipher.decrypt(png);
      svg = svg ? await this.cipher.decryptText(svg) : null;
    }
    return { id: r.id, name: r.name, kind: r.kind, source: r.source, svg, png, width: r.width, height: r.height, encrypted, isDefault: bool(r.is_default), sortOrder: r.sort_order, createdAt: r.created_at };
  }

  async list(kind?: StoredSignature['kind']): Promise<StoredSignature[]> {
    const rows = await this.db.select<SigRow>(`SELECT * FROM signatures ${kind ? 'WHERE kind = ?' : ''} ORDER BY sort_order, created_at`, kind ? [kind] : []);
    return Promise.all(rows.map((r) => this.fromRow(r)));
  }
  async get(id: string): Promise<StoredSignature | null> {
    const rows = await this.db.select<SigRow>('SELECT * FROM signatures WHERE id = ?', [id]);
    return rows[0] ? this.fromRow(rows[0]) : null;
  }
  /** The default of a kind, or the first one. */
  async defaultOf(kind: StoredSignature['kind']): Promise<StoredSignature | null> {
    const list = await this.list(kind);
    return list.find((s) => s.isDefault) ?? list[0] ?? null;
  }

  async add(sig: { name: string; kind: StoredSignature['kind']; source: StoredSignature['source']; svg?: string | null; png: Uint8Array; width: number; height: number }, opts: { encrypt: boolean }): Promise<StoredSignature> {
    if (!sig.name.trim()) throw new InvalidArgumentError('Give the signature a name', { reason: 'emptyName' });
    const id = this.newId();
    const first = (await this.db.select<{ n: number }>('SELECT COUNT(*) AS n FROM signatures WHERE kind = ?', [sig.kind]))[0]!.n === 0;
    const order = (await this.db.select<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM signatures'))[0]!.m ?? -1;
    const png = opts.encrypt ? await this.cipher.encrypt(sig.png) : sig.png;
    const svg = sig.svg ? (opts.encrypt ? await this.cipher.encryptText(sig.svg) : sig.svg) : null;
    await this.db.execute('INSERT INTO signatures (id, name, kind, source, svg, png, width, height, encrypted, is_default, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, sig.name.trim(), sig.kind, sig.source, svg, enc(png), sig.width, sig.height, opts.encrypt ? 1 : 0, first ? 1 : 0, Number(order) + 1, iso(this.clock)]);
    return (await this.get(id))!;
  }
  async rename(id: string, name: string): Promise<void> {
    if (!name.trim()) throw new InvalidArgumentError('Give the signature a name', { reason: 'emptyName' });
    await this.db.execute('UPDATE signatures SET name = ? WHERE id = ?', [name.trim(), id]);
  }
  /** One default per kind. */
  async setDefault(id: string): Promise<void> {
    const sig = await this.get(id);
    if (!sig) throw new InvalidArgumentError('Unknown signature');
    await this.db.transaction(async (tx) => {
      await tx.execute('UPDATE signatures SET is_default = 0 WHERE kind = ?', [sig.kind]);
      await tx.execute('UPDATE signatures SET is_default = 1 WHERE id = ?', [id]);
    });
  }
  async remove(id: string): Promise<void> {
    const sig = await this.get(id);
    await this.db.execute('DELETE FROM signatures WHERE id = ?', [id]);
    if (sig?.isDefault) {
      const next = (await this.list(sig.kind))[0];
      if (next) await this.setDefault(next.id);
    }
  }
  async reorder(ids: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (let k = 0; k < ids.length; k++) await tx.execute('UPDATE signatures SET sort_order = ? WHERE id = ?', [k, ids[k]]);
    });
  }
  /** Applies the "encrypt stored signatures" setting to everything already stored. */
  async setEncryption(on: boolean): Promise<number> {
    const rows = await this.db.select<SigRow>('SELECT * FROM signatures WHERE encrypted = ?', [on ? 0 : 1]);
    for (const r of rows) {
      const sig = await this.fromRow(r);
      const png = on ? await this.cipher.encrypt(sig.png) : sig.png;
      const svg = sig.svg ? (on ? await this.cipher.encryptText(sig.svg) : sig.svg) : null;
      await this.db.execute('UPDATE signatures SET png = ?, svg = ?, encrypted = ? WHERE id = ?', [enc(png), svg, on ? 1 : 0, r.id]);
    }
    return rows.length;
  }
}

// ---- stamps ----------------------------------------------------------------------------------

export interface StoredStamp {
  id: string;
  name: string;
  kind: 'builtin' | 'text' | 'image' | 'date' | 'selection';
  /** Style, text, colour, date format… */
  payload: Record<string, unknown>;
  png: Uint8Array | null;
  sortOrder: number;
}
type StampRow = { id: string; name: string; kind: StoredStamp['kind']; payload_json: string; png: unknown; sort_order: number };

/** FR-STM-07 custom stamp library (built-ins live in code and are not stored). */
export class StampRepo {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly newId: () => string) {}
  async list(): Promise<StoredStamp[]> {
    const rows = await this.db.select<StampRow>('SELECT * FROM stamps ORDER BY sort_order, created_at');
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, payload: JSON.parse(r.payload_json) as Record<string, unknown>, png: dec(r.png), sortOrder: r.sort_order }));
  }
  async add(stamp: { name: string; kind: StoredStamp['kind']; payload: Record<string, unknown>; png?: Uint8Array | null }): Promise<StoredStamp> {
    if (!stamp.name.trim()) throw new InvalidArgumentError('Give the stamp a name', { reason: 'emptyName' });
    const id = this.newId();
    const order = (await this.db.select<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM stamps'))[0]!.m ?? -1;
    await this.db.execute('INSERT INTO stamps (id, name, kind, payload_json, png, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, stamp.name.trim(), stamp.kind, JSON.stringify(stamp.payload), enc(stamp.png), Number(order) + 1, iso(this.clock)]);
    return (await this.list()).find((s) => s.id === id)!;
  }
  async rename(id: string, name: string): Promise<void> {
    if (!name.trim()) throw new InvalidArgumentError('Give the stamp a name', { reason: 'emptyName' });
    await this.db.execute('UPDATE stamps SET name = ? WHERE id = ?', [name.trim(), id]);
  }
  async remove(id: string): Promise<void> {
    await this.db.execute('DELETE FROM stamps WHERE id = ?', [id]);
  }
  async reorder(ids: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (let k = 0; k < ids.length; k++) await tx.execute('UPDATE stamps SET sort_order = ? WHERE id = ?', [k, ids[k]]);
    });
  }
}

// ---- profiles --------------------------------------------------------------------------------

export type ProfileFieldType = 'text' | 'date' | 'number' | 'phone' | 'email' | 'address' | 'choice' | 'multiline';
export interface ProfileField {
  id: string;
  key: string;
  label: string;
  type: ProfileFieldType;
  value: string;
  /** Never sent to an AI provider in any mode; encrypted at rest. */
  sensitive: boolean;
  aliases: string[];
  sortOrder: number;
}
export interface Profile {
  id: string;
  name: string;
  isDefault: boolean;
  fields: ProfileField[];
}
export interface ProfileExport {
  version: 1;
  name: string;
  fields: Array<Pick<ProfileField, 'key' | 'label' | 'type' | 'value' | 'sensitive' | 'aliases'>>;
}
type PFRow = { id: string; profile_id: string; key: string; label: string; type: ProfileFieldType; value: string | null; sensitive: number; aliases_json: string; sort_order: number };

const t = (key: string, label: string, type: ProfileFieldType, aliases: string[], sensitive = false): Omit<ProfileField, 'id' | 'value' | 'sortOrder'> => ({ key, label, type, aliases, sensitive });
/** Templates for common reference data sets, with aliases in English and Italian (FR-AIF-01). */
export const PROFILE_TEMPLATES: Record<string, Array<Omit<ProfileField, 'id' | 'value' | 'sortOrder'>>> = {
  identity: [
    t('first_name', 'First name', 'text', ['given name', 'forename', 'nome']),
    t('last_name', 'Last name', 'text', ['surname', 'family name', 'cognome']),
    t('full_name', 'Full name', 'text', ['name', 'name and surname', 'nome e cognome', 'nominativo']),
    t('birth_date', 'Date of birth', 'date', ['birth date', 'dob', 'born on', 'data di nascita', 'nato il']),
    t('birth_place', 'Place of birth', 'text', ['birthplace', 'born in', 'luogo di nascita', 'nato a']),
    t('nationality', 'Nationality', 'text', ['citizenship', 'cittadinanza', 'nazionalità']),
    t('tax_id', 'Tax code', 'text', ['tax id', 'tax number', 'fiscal code', 'ssn', 'tin', 'codice fiscale'], true),
    t('id_number', 'ID document number', 'text', ['passport number', 'id card number', 'document number', 'numero documento', "carta d'identità"], true),
  ],
  address: [
    t('street', 'Street address', 'address', ['address', 'address line 1', 'street', 'indirizzo', 'via', 'residenza']),
    t('postal_code', 'Postal code', 'text', ['zip', 'zip code', 'postcode', 'cap']),
    t('city', 'City', 'text', ['town', 'city / town', 'comune', 'città', 'località']),
    t('province', 'Province / State', 'text', ['state', 'region', 'county', 'provincia', 'prov']),
    t('country', 'Country', 'text', ['nation', 'paese', 'stato', 'nazione']),
  ],
  contacts: [
    t('email', 'Email', 'email', ['e-mail', 'email address', 'posta elettronica', 'indirizzo email']),
    t('phone', 'Phone', 'phone', ['telephone', 'phone number', 'mobile', 'cell', 'telefono', 'cellulare', 'recapito telefonico']),
  ],
  company: [
    t('company', 'Company name', 'text', ['organisation', 'organization', 'employer', 'business name', 'azienda', 'società', 'ragione sociale', 'datore di lavoro']),
    t('vat_number', 'VAT number', 'text', ['vat', 'vat id', 'partita iva', 'p.iva', 'p. iva']),
    t('job_title', 'Job title', 'text', ['position', 'role', 'occupation', 'profession', 'professione', 'qualifica', 'mansione']),
  ],
  bank: [
    t('iban', 'IBAN', 'text', ['bank account', 'account number', 'conto corrente', 'coordinate bancarie'], true),
    t('bic', 'BIC / SWIFT', 'text', ['swift', 'swift code', 'bic code']),
    t('bank_name', 'Bank name', 'text', ['bank', 'banca', 'istituto di credito']),
  ],
  dates: [t('today', "Today's date", 'date', ['date', 'data', 'date of signature', 'data odierna', 'signed on', 'lì'])],
};

/** FR-AIF-01 reference data for auto-fill. */
/** Longer names do not fit any list or dialog; they are cut when stored. */
export const PROFILE_NAME_MAX = 60;

export class ProfileRepo {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly newId: () => string, private readonly cipher: DataCipher) {}

  private async fields(profileId: string): Promise<ProfileField[]> {
    const rows = await this.db.select<PFRow>('SELECT * FROM profile_fields WHERE profile_id = ? ORDER BY sort_order, key', [profileId]);
    const out: ProfileField[] = [];
    for (const r of rows) {
      const sensitive = bool(r.sensitive);
      let value = r.value ?? '';
      if (sensitive && value.startsWith('enc:')) value = await this.cipher.decryptText(value.slice(4));
      out.push({ id: r.id, key: r.key, label: r.label, type: r.type, value, sensitive, aliases: JSON.parse(r.aliases_json) as string[], sortOrder: r.sort_order });
    }
    return out;
  }
  async list(): Promise<Profile[]> {
    const rows = await this.db.select<{ id: string; name: string; is_default: number }>('SELECT * FROM profiles ORDER BY is_default DESC, created_at');
    return Promise.all(rows.map(async (r) => ({ id: r.id, name: r.name, isDefault: bool(r.is_default), fields: await this.fields(r.id) })));
  }
  async get(id: string): Promise<Profile | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }
  async getDefault(): Promise<Profile | null> {
    const all = await this.list();
    return all.find((p) => p.isDefault) ?? all[0] ?? null;
  }

  /** Creates a profile, optionally seeded with template sets (values empty). */
  async create(name: string, templates: Array<keyof typeof PROFILE_TEMPLATES> = []): Promise<Profile> {
    if (!name.trim()) throw new InvalidArgumentError('Give the profile a name', { reason: 'emptyName' });
    const id = this.newId();
    const first = (await this.db.select<{ n: number }>('SELECT COUNT(*) AS n FROM profiles'))[0]!.n === 0;
    await this.db.execute('INSERT INTO profiles (id, name, is_default, created_at) VALUES (?, ?, ?, ?)', [id, name.trim().slice(0, PROFILE_NAME_MAX), first ? 1 : 0, iso(this.clock)]);
    for (const set of templates) for (const f of PROFILE_TEMPLATES[set] ?? []) await this.setField(id, { ...f, value: '' });
    return (await this.get(id))!;
  }
  async rename(id: string, name: string): Promise<void> {
    if (!name.trim()) throw new InvalidArgumentError('Give the profile a name', { reason: 'emptyName' });
    await this.db.execute('UPDATE profiles SET name = ? WHERE id = ?', [name.trim().slice(0, PROFILE_NAME_MAX), id]);
  }
  async setDefault(id: string): Promise<void> {
    if ((await this.db.select('SELECT 1 FROM profiles WHERE id = ?', [id])).length === 0) throw new InvalidArgumentError('Unknown profile');
    await this.db.transaction(async (tx) => {
      await tx.execute('UPDATE profiles SET is_default = 0');
      await tx.execute('UPDATE profiles SET is_default = 1 WHERE id = ?', [id]);
    });
  }
  /** Fields and remembered mappings go with it (FK cascade / set null). */
  async remove(id: string): Promise<void> {
    await this.db.execute('DELETE FROM profiles WHERE id = ?', [id]);
    const rest = await this.db.select<{ id: string }>('SELECT id FROM profiles WHERE is_default = 1');
    if (rest.length === 0) {
      const next = (await this.db.select<{ id: string }>('SELECT id FROM profiles ORDER BY created_at LIMIT 1'))[0];
      if (next) await this.setDefault(next.id);
    }
  }

  /** Adds or updates one entry by key. Sensitive values are encrypted at rest. */
  async setField(profileId: string, field: { key: string; label: string; type: ProfileFieldType; value: string; sensitive?: boolean; aliases?: string[] }): Promise<void> {
    const key = field.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!key) throw new InvalidArgumentError('The key needs at least one letter or digit', { reason: 'badKey' });
    const sensitive = !!field.sensitive;
    const value = sensitive && field.value !== '' ? `enc:${await this.cipher.encryptText(field.value)}` : field.value;
    const existing = await this.db.select<{ id: string }>('SELECT id FROM profile_fields WHERE profile_id = ? AND key = ?', [profileId, key]);
    if (existing[0]) {
      await this.db.execute('UPDATE profile_fields SET label = ?, type = ?, value = ?, sensitive = ?, aliases_json = ? WHERE id = ?', [field.label, field.type, value, sensitive ? 1 : 0, JSON.stringify(field.aliases ?? []), existing[0].id]);
    } else {
      const order = (await this.db.select<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM profile_fields WHERE profile_id = ?', [profileId]))[0]!.m ?? -1;
      await this.db.execute('INSERT INTO profile_fields (id, profile_id, key, label, type, value, sensitive, aliases_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [this.newId(), profileId, key, field.label, field.type, value, sensitive ? 1 : 0, JSON.stringify(field.aliases ?? []), Number(order) + 1]);
    }
  }
  async removeField(profileId: string, key: string): Promise<void> {
    await this.db.execute('DELETE FROM profile_fields WHERE profile_id = ? AND key = ?', [profileId, key]);
  }

  async exportJson(id: string): Promise<ProfileExport> {
    const p = await this.get(id);
    if (!p) throw new InvalidArgumentError('Unknown profile');
    return { version: 1, name: p.name, fields: p.fields.map(({ key, label, type, value, sensitive, aliases }) => ({ key, label, type, value, sensitive, aliases })) };
  }
  async importJson(data: unknown): Promise<Profile> {
    const d = data as Partial<ProfileExport> | null;
    if (!d || d.version !== 1 || typeof d.name !== 'string' || !Array.isArray(d.fields)) throw new InvalidArgumentError('This is not a Folio profile file', { reason: 'badProfile' });
    const types = ['text', 'date', 'number', 'phone', 'email', 'address', 'choice', 'multiline'];
    const fields = d.fields.filter((f) => f && typeof f.key === 'string' && typeof f.label === 'string' && types.includes(f.type) && typeof f.value === 'string');
    return this.db.transaction(async () => {
      const profile = await this.create(d.name!);
      for (const f of fields) await this.setField(profile.id, { ...f, aliases: Array.isArray(f.aliases) ? f.aliases.filter((a) => typeof a === 'string') : [] });
      return (await this.get(profile.id))!;
    });
  }
}

// ---- remembered form mappings and AI usage ---------------------------------------------------

export interface StoredMappingEntry {
  fieldRef: string;
  profileKey: string;
  transform: string;
  choiceValue?: string | null;
}
export interface StoredMapping {
  id: string;
  docFingerprint: string;
  profileId: string | null;
  mapping: StoredMappingEntry[];
  source: 'ai' | 'heuristic' | 'manual';
  createdAt: string;
}

/** FR-AIF-08: the same form fills instantly next time. */
export class FormMappingRepo {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly newId: () => string) {}
  async find(docFingerprint: string, profileId: string): Promise<StoredMapping | null> {
    const rows = await this.db.select<{ id: string; doc_fingerprint: string; profile_id: string | null; mapping_json: string; source: StoredMapping['source']; created_at: string }>('SELECT * FROM form_mappings WHERE doc_fingerprint = ? AND profile_id = ?', [docFingerprint, profileId]);
    const r = rows[0];
    return r ? { id: r.id, docFingerprint: r.doc_fingerprint, profileId: r.profile_id, mapping: JSON.parse(r.mapping_json) as StoredMappingEntry[], source: r.source, createdAt: r.created_at } : null;
  }
  async save(docFingerprint: string, profileId: string, mapping: StoredMappingEntry[], source: StoredMapping['source']): Promise<void> {
    await this.db.execute('INSERT INTO form_mappings (id, doc_fingerprint, profile_id, mapping_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(doc_fingerprint, profile_id) DO UPDATE SET mapping_json = excluded.mapping_json, source = excluded.source, created_at = excluded.created_at', [this.newId(), docFingerprint, profileId, JSON.stringify(mapping), source, iso(this.clock)]);
  }
  async forget(docFingerprint: string, profileId: string): Promise<void> {
    await this.db.execute('DELETE FROM form_mappings WHERE doc_fingerprint = ? AND profile_id = ?', [docFingerprint, profileId]);
  }
}

export interface AiRun {
  model: string;
  mode: 'mapping_only' | 'with_values';
  includedImage: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** 'ok' or 'error:<code>'. */
  status: string;
}
/** Usage log for transparency. Never stores document content. */
export class AiRunsRepo {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly newId: () => string) {}
  async record(run: AiRun): Promise<void> {
    await this.db.execute('INSERT INTO ai_runs (id, at, model, mode, included_image, input_tokens, output_tokens, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [this.newId(), iso(this.clock), run.model, run.mode, run.includedImage ? 1 : 0, run.inputTokens ?? null, run.outputTokens ?? null, run.status]);
  }
  async list(): Promise<Array<AiRun & { at: string }>> {
    const rows = await this.db.select<{ at: string; model: string; mode: AiRun['mode']; included_image: number; input_tokens: number | null; output_tokens: number | null; status: string }>('SELECT * FROM ai_runs ORDER BY at DESC');
    return rows.map((r) => ({ at: r.at, model: r.model, mode: r.mode, includedImage: bool(r.included_image), inputTokens: r.input_tokens ?? undefined, outputTokens: r.output_tokens ?? undefined, status: r.status }));
  }
}

/** "Delete all app data" (SPEC §12.9): every table emptied, secrets removed. */
export async function deleteAllData(db: Database, secrets: SecretStore, secretKeys: string[] = []): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of ['form_mappings', 'profile_fields', 'profiles', 'signatures', 'stamps', 'recent_files', 'ai_runs', 'history_spill', 'settings']) await tx.execute(`DELETE FROM ${table}`);
  });
  for (const key of [KEY_NAME, ...secretKeys]) await secrets.remove(key);
}
