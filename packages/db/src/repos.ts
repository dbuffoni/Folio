import { DEFAULT_SETTINGS, InvalidArgumentError, certSecretKey, fromBase64, fromHex, parseSettings, toBase64, toHex, utf8, type Settings, type SettingsKey } from '@folio/core';
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
  /** Choices of a `choice` field; empty for every other type. */
  options: string[];
}
export interface Profile {
  id: string;
  name: string;
  isDefault: boolean;
  /** Saved signature put into signature fields when this profile fills a form; null when none. */
  signatureId: string | null;
  fields: ProfileField[];
}
export interface ProfileExport {
  version: 1;
  name: string;
  fields: Array<Pick<ProfileField, 'key' | 'label' | 'type' | 'value' | 'sensitive' | 'aliases'> & { options?: string[] }>;
}
type PFRow = { id: string; profile_id: string; key: string; label: string; type: ProfileFieldType; value: string | null; sensitive: number; aliases_json: string; sort_order: number; options_json?: string };

const t = (key: string, label: string, type: ProfileFieldType, aliases: string[], sensitive = false): Omit<ProfileField, 'id' | 'value' | 'sortOrder'> => ({ key, label, type, aliases, sensitive, options: [] });
/** Templates for common reference data sets, with aliases in English and Italian (FR-AIF-01). */
export type FieldDefinition = Omit<ProfileField, 'id' | 'value' | 'sortOrder'>;
export const PROFILE_TEMPLATES: Record<string, FieldDefinition[]> = {
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

/** The stable key of an entry: lower-case words joined by underscores. */
export function slugKey(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
/** A free key derived from a label: "Date of birth" → date_of_birth, then date_of_birth_2… */
export function uniqueKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugKey(label) || 'field';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}
/**
 * Validation of a typed value (FR-FRM-20 editor): empty is always allowed; returns the reason key of the
 * problem, or null. Dates are ISO (YYYY-MM-DD) and must exist.
 */
export function validateProfileValue(type: ProfileFieldType, value: string): 'badDate' | 'badEmail' | 'badNumber' | 'badPhone' | null {
  const v = value.trim();
  if (v === '') return null;
  switch (type) {
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m) return 'badDate';
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? null : 'badDate';
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : 'badEmail';
    case 'number':
      return /^[-+]?\d+([.,]\d+)?$/.test(v) ? null : 'badNumber';
    case 'phone':
      return /^[+()\d][\d\s().-]{3,}$/.test(v) ? null : 'badPhone';
    default:
      return null;
  }
}

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
      out.push({ id: r.id, key: r.key, label: r.label, type: r.type, value, sensitive, aliases: JSON.parse(r.aliases_json) as string[], sortOrder: r.sort_order, options: JSON.parse(r.options_json ?? '[]') as string[] });
    }
    return out;
  }
  async list(): Promise<Profile[]> {
    const rows = await this.db.select<{ id: string; name: string; is_default: number; signature_id: string | null }>('SELECT * FROM profiles ORDER BY is_default DESC, created_at');
    return Promise.all(rows.map(async (r) => ({ id: r.id, name: r.name, isDefault: bool(r.is_default), signatureId: r.signature_id ?? null, fields: await this.fields(r.id) })));
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
  /** Associates a saved signature (or none) with the profile. */
  async setSignature(id: string, signatureId: string | null): Promise<void> {
    if ((await this.db.select('SELECT 1 FROM profiles WHERE id = ?', [id])).length === 0) throw new InvalidArgumentError('Unknown profile');
    if (signatureId !== null && (await this.db.select('SELECT 1 FROM signatures WHERE id = ?', [signatureId])).length === 0) throw new InvalidArgumentError('Unknown signature');
    await this.db.execute('UPDATE profiles SET signature_id = ? WHERE id = ?', [signatureId, id]);
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
  async setField(profileId: string, field: { key: string; label: string; type: ProfileFieldType; value: string; sensitive?: boolean; aliases?: string[]; options?: string[] }): Promise<void> {
    const key = slugKey(field.key);
    if (!key) throw new InvalidArgumentError('The key needs at least one letter or digit', { reason: 'badKey' });
    const problem = validateProfileValue(field.type, field.value);
    if (problem) throw new InvalidArgumentError(`Not a valid ${field.type}`, { reason: problem, key });
    const options = JSON.stringify(field.type === 'choice' ? [...new Set((field.options ?? []).map((o) => o.trim()).filter(Boolean))] : []);
    const sensitive = !!field.sensitive;
    const value = sensitive && field.value !== '' ? `enc:${await this.cipher.encryptText(field.value)}` : field.value;
    const existing = await this.db.select<{ id: string }>('SELECT id FROM profile_fields WHERE profile_id = ? AND key = ?', [profileId, key]);
    if (existing[0]) {
      await this.db.execute('UPDATE profile_fields SET label = ?, type = ?, value = ?, sensitive = ?, aliases_json = ?, options_json = ? WHERE id = ?', [field.label, field.type, value, sensitive ? 1 : 0, JSON.stringify(field.aliases ?? []), options, existing[0].id]);
    } else {
      const order = (await this.db.select<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM profile_fields WHERE profile_id = ?', [profileId]))[0]!.m ?? -1;
      await this.db.execute('INSERT INTO profile_fields (id, profile_id, key, label, type, value, sensitive, aliases_json, sort_order, options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [this.newId(), profileId, key, field.label, field.type, value, sensitive ? 1 : 0, JSON.stringify(field.aliases ?? []), Number(order) + 1, options]);
    }
  }
  async removeField(profileId: string, key: string): Promise<void> {
    await this.db.execute('DELETE FROM profile_fields WHERE profile_id = ? AND key = ?', [profileId, key]);
  }

  /** A copy with every field and value, as the new default-less profile "<name> copy". */
  async duplicate(id: string, name?: string): Promise<Profile> {
    const src = await this.get(id);
    if (!src) throw new InvalidArgumentError('Unknown profile');
    return this.db.transaction(async () => {
      const copy = await this.create(name ?? `${src.name} copy`);
      for (const f of src.fields) await this.setField(copy.id, { ...f, options: f.options });
      if (src.signatureId) await this.setSignature(copy.id, src.signatureId);
      return (await this.get(copy.id))!;
    });
  }
  /** Puts the entries in the given key order; keys not listed keep their relative order after the listed ones. */
  async reorder(profileId: string, keys: string[]): Promise<void> {
    const rows = await this.db.select<{ key: string }>('SELECT key FROM profile_fields WHERE profile_id = ? ORDER BY sort_order, key', [profileId]);
    const existing = rows.map((r) => r.key);
    const order = [...keys.filter((k) => existing.includes(k)), ...existing.filter((k) => !keys.includes(k))];
    await this.db.transaction(async (tx) => {
      for (const [i, key] of order.entries()) await tx.execute('UPDATE profile_fields SET sort_order = ? WHERE profile_id = ? AND key = ?', [i, profileId, key]);
    });
  }
  /**
   * Appends a template's fields (no values). Keys the profile already has are skipped and returned, so the
   * editor can list them in a notice.
   */
  async addTemplate(profileId: string, fields: FieldDefinition[]): Promise<{ added: string[]; skipped: string[] }> {
    const have = new Set((await this.db.select<{ key: string }>('SELECT key FROM profile_fields WHERE profile_id = ?', [profileId])).map((r) => r.key));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const f of fields) {
      const key = slugKey(f.key);
      if (have.has(key)) {
        skipped.push(key);
        continue;
      }
      await this.setField(profileId, { ...f, value: '', sensitive: f.sensitive, options: f.options });
      have.add(key);
      added.push(key);
    }
    return { added, skipped };
  }
  /**
   * Changes the key of an entry. Remembered mappings that used the old key are rewritten by the caller
   * (`FormMappingRepo.dropKey`); a key already in use is refused.
   */
  async renameKey(profileId: string, oldKey: string, newKey: string): Promise<string> {
    const key = slugKey(newKey);
    if (!key) throw new InvalidArgumentError('The key needs at least one letter or digit', { reason: 'badKey' });
    if (key === oldKey) return key;
    if ((await this.db.select('SELECT 1 FROM profile_fields WHERE profile_id = ? AND key = ?', [profileId, key])).length) throw new InvalidArgumentError('That key is already used in this profile', { reason: 'keyTaken', key });
    await this.db.execute('UPDATE profile_fields SET key = ? WHERE profile_id = ? AND key = ?', [key, profileId, oldKey]);
    return key;
  }

  async exportJson(id: string): Promise<ProfileExport> {
    const p = await this.get(id);
    if (!p) throw new InvalidArgumentError('Unknown profile');
    return { version: 1, name: p.name, fields: p.fields.map(({ key, label, type, value, sensitive, aliases, options }) => ({ key, label, type, value, sensitive, aliases, ...(options.length ? { options } : {}) })) };
  }
  async importJson(data: unknown): Promise<Profile> {
    const d = data as Partial<ProfileExport> | null;
    if (!d || d.version !== 1 || typeof d.name !== 'string' || !Array.isArray(d.fields)) throw new InvalidArgumentError('This is not a Folio profile file', { reason: 'badProfile' });
    const types = ['text', 'date', 'number', 'phone', 'email', 'address', 'choice', 'multiline'];
    const fields = d.fields.filter((f) => f && typeof f.key === 'string' && typeof f.label === 'string' && types.includes(f.type) && typeof f.value === 'string');
    return this.db.transaction(async () => {
      const profile = await this.create(d.name!);
      for (const f of fields) await this.setField(profile.id, { ...f, aliases: Array.isArray(f.aliases) ? f.aliases.filter((a) => typeof a === 'string') : [], options: Array.isArray(f.options) ? f.options.filter((o) => typeof o === 'string') : [] });
      return (await this.get(profile.id))!;
    });
  }
}

// ---- field templates (FR-FRM-20) -------------------------------------------------------------

export interface FieldTemplate {
  id: string;
  name: string;
  builtIn: boolean;
  /** Definitions only: never a value (a template holds nothing sensitive). */
  fields: FieldDefinition[];
}
export interface FieldTemplateExport {
  version: 1;
  kind: 'folio-field-template';
  name: string;
  fields: FieldDefinition[];
}
export const TEMPLATE_EXPORT_VERSION = 1;
const TYPES: ProfileFieldType[] = ['text', 'date', 'number', 'phone', 'email', 'address', 'choice', 'multiline'];

/** Cleans a definition list read from storage or a file: known types, unique slugs, no values. */
export function cleanDefinitions(raw: unknown): FieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FieldDefinition[] = [];
  for (const f of raw as Array<Partial<FieldDefinition>>) {
    if (!f || typeof f.label !== 'string' || !f.label.trim()) continue;
    const key = slugKey(typeof f.key === 'string' && f.key ? f.key : f.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const type = TYPES.includes(f.type as ProfileFieldType) ? (f.type as ProfileFieldType) : 'text';
    out.push({
      key,
      label: f.label.trim(),
      type,
      aliases: Array.isArray(f.aliases) ? f.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '') : [],
      sensitive: !!f.sensitive,
      options: type === 'choice' && Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '') : [],
    });
  }
  return out;
}

export class FieldTemplateRepo {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly newId: () => string) {}

  /** The built-in sets are rows too, written on first use, so users can duplicate and list them like their own. */
  private async seed(): Promise<void> {
    const have = new Set((await this.db.select<{ id: string }>('SELECT id FROM field_templates WHERE built_in = 1')).map((r) => r.id));
    for (const [name, fields] of Object.entries(PROFILE_TEMPLATES)) {
      const id = `builtin:${name}`;
      if (!have.has(id)) await this.db.execute('INSERT INTO field_templates (id, name, built_in, fields_json, created_at) VALUES (?, ?, 1, ?, ?)', [id, name, JSON.stringify(fields), iso(this.clock)]);
    }
  }
  async list(): Promise<FieldTemplate[]> {
    await this.seed();
    const rows = await this.db.select<{ id: string; name: string; built_in: number; fields_json: string }>('SELECT * FROM field_templates ORDER BY built_in DESC, created_at, name');
    const order = Object.keys(PROFILE_TEMPLATES);
    const rank = (t: { name: string; builtIn: boolean }): number => (t.builtIn ? order.indexOf(t.name) : order.length);
    return rows
      .map((r) => ({ id: r.id, name: r.name, builtIn: bool(r.built_in), fields: cleanDefinitions(JSON.parse(r.fields_json)) }))
      .sort((a, b) => rank(a) - rank(b));
  }
  async get(id: string): Promise<FieldTemplate | null> {
    return (await this.list()).find((t) => t.id === id) ?? null;
  }
  private checkName(name: string): string {
    const n = name.trim();
    if (!n) throw new InvalidArgumentError('Give the template a name', { reason: 'emptyName' });
    return n.slice(0, PROFILE_NAME_MAX);
  }
  async create(name: string, fields: FieldDefinition[] = []): Promise<FieldTemplate> {
    await this.seed();
    const id = this.newId();
    await this.db.execute('INSERT INTO field_templates (id, name, built_in, fields_json, created_at) VALUES (?, ?, 0, ?, ?)', [id, this.checkName(name), JSON.stringify(cleanDefinitions(fields)), iso(this.clock)]);
    return (await this.get(id))!;
  }
  /** Replaces the name and/or the fields of a user template. Built-in templates are read-only. */
  async update(id: string, patch: { name?: string; fields?: FieldDefinition[] }): Promise<FieldTemplate> {
    const t = await this.get(id);
    if (!t) throw new InvalidArgumentError('Unknown template');
    if (t.builtIn) throw new InvalidArgumentError('Built-in templates cannot be changed. Duplicate it first.', { reason: 'builtInTemplate' });
    await this.db.execute('UPDATE field_templates SET name = ?, fields_json = ? WHERE id = ?', [patch.name !== undefined ? this.checkName(patch.name) : t.name, JSON.stringify(cleanDefinitions(patch.fields ?? t.fields)), id]);
    return (await this.get(id))!;
  }
  async duplicate(id: string, name?: string): Promise<FieldTemplate> {
    const t = await this.get(id);
    if (!t) throw new InvalidArgumentError('Unknown template');
    return this.create(name ?? `${t.name} copy`, t.fields);
  }
  async remove(id: string): Promise<void> {
    const t = await this.get(id);
    if (!t) return;
    if (t.builtIn) throw new InvalidArgumentError('Built-in templates cannot be deleted.', { reason: 'builtInTemplate' });
    await this.db.execute('DELETE FROM field_templates WHERE id = ?', [id]);
  }
  /** "Save structure as template": a profile's definitions without values. */
  async fromProfile(profile: Profile, name: string): Promise<FieldTemplate> {
    return this.create(name, profile.fields.map(({ key, label, type, aliases, sensitive, options }) => ({ key, label, type, aliases, sensitive, options })));
  }
  exportJson(t: FieldTemplate): FieldTemplateExport {
    return { version: TEMPLATE_EXPORT_VERSION, kind: 'folio-field-template', name: t.name, fields: t.fields };
  }
  /** A file with a newer version is refused with a message of its own, so the user knows to update Folio. */
  async importJson(data: unknown): Promise<FieldTemplate> {
    const d = data as Partial<FieldTemplateExport> | null;
    if (!d || d.kind !== 'folio-field-template' || typeof d.name !== 'string' || !Array.isArray(d.fields) || typeof d.version !== 'number')
      throw new InvalidArgumentError('This is not a Folio field template file', { reason: 'badTemplate' });
    if (d.version > TEMPLATE_EXPORT_VERSION) throw new InvalidArgumentError('This template was made by a newer version of Folio', { reason: 'templateNewer' });
    return this.create(d.name, cleanDefinitions(d.fields));
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
  /**
   * An entry was deleted or its key changed: mappings that used it lose that entry, the rest is kept; a
   * mapping left empty is removed. @returns how many remembered forms changed.
   */
  async dropKey(profileId: string, key: string): Promise<number> {
    const rows = await this.db.select<{ id: string; mapping_json: string }>('SELECT id, mapping_json FROM form_mappings WHERE profile_id = ?', [profileId]);
    let changed = 0;
    for (const r of rows) {
      const entries = JSON.parse(r.mapping_json) as StoredMappingEntry[];
      const kept = entries.filter((e) => e.profileKey !== key);
      if (kept.length === entries.length) continue;
      changed++;
      if (kept.length === 0) await this.db.execute('DELETE FROM form_mappings WHERE id = ?', [r.id]);
      else await this.db.execute('UPDATE form_mappings SET mapping_json = ? WHERE id = ?', [JSON.stringify(kept), r.id]);
    }
    return changed;
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
  // Signing identities keep their private material in the secret store, named by fingerprint.
  const identities = await db.select<{ fingerprint: string }>("SELECT fingerprint FROM certificates WHERE kind = 'identity'");
  for (const { fingerprint } of identities) await secrets.remove(certSecretKey(fingerprint));
  await db.transaction(async (tx) => {
    for (const table of ['certificates', 'field_templates', 'form_mappings', 'profile_fields', 'profiles', 'signatures', 'stamps', 'recent_files', 'ai_runs', 'history_spill', 'settings']) await tx.execute(`DELETE FROM ${table}`);
  });
  for (const key of [KEY_NAME, ...secretKeys]) await secrets.remove(key);
}

// ---- certificates (digital signatures) ---------------------------------------------------------

export { certSecretKey };

export type CertificateKind = 'identity' | 'trusted';
/** Public facts of one certificate plus its DER encoding. No private key material, ever. */
export interface StoredCertificate {
  fingerprint: string;
  kind: CertificateKind;
  commonName: string;
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  keyAlgorithm: string;
  keyUsage: string[];
  selfSigned: boolean;
  isCa: boolean;
  der: Uint8Array;
  createdAt: string;
}
type CertRow = { fingerprint: string; kind: CertificateKind; common_name: string; subject: string; issuer: string; serial: string; not_before: string; not_after: string; key_algorithm: string; key_usage_json: string; self_signed: number; is_ca: number; der: unknown; created_at: string };
const toCert = (r: CertRow): StoredCertificate => ({
  fingerprint: r.fingerprint,
  kind: r.kind,
  commonName: r.common_name,
  subject: r.subject,
  issuer: r.issuer,
  serial: r.serial,
  notBefore: r.not_before,
  notAfter: r.not_after,
  keyAlgorithm: r.key_algorithm,
  keyUsage: JSON.parse(r.key_usage_json) as string[],
  selfSigned: bool(r.self_signed),
  isCa: bool(r.is_ca),
  der: dec(r.der) ?? new Uint8Array(),
  createdAt: r.created_at,
});

/** FR-CRT-03. Signing identities (public part) and trusted certificates. */
export class CertificateRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  async list(kind?: CertificateKind): Promise<StoredCertificate[]> {
    const rows = kind
      ? await this.db.select<CertRow>('SELECT * FROM certificates WHERE kind = ? ORDER BY common_name COLLATE NOCASE, created_at', [kind])
      : await this.db.select<CertRow>('SELECT * FROM certificates ORDER BY kind, common_name COLLATE NOCASE, created_at');
    return rows.map(toCert);
  }
  async get(fingerprint: string, kind: CertificateKind): Promise<StoredCertificate | null> {
    const rows = await this.db.select<CertRow>('SELECT * FROM certificates WHERE fingerprint = ? AND kind = ?', [fingerprint, kind]);
    return rows[0] ? toCert(rows[0]) : null;
  }
  /** Adds the certificate, or refreshes the row when the same fingerprint is imported again. */
  async upsert(c: Omit<StoredCertificate, 'createdAt'>): Promise<StoredCertificate> {
    await this.db.execute(
      `INSERT INTO certificates (fingerprint, kind, common_name, subject, issuer, serial, not_before, not_after, key_algorithm, key_usage_json, self_signed, is_ca, der, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint, kind) DO UPDATE SET common_name = excluded.common_name, subject = excluded.subject, issuer = excluded.issuer, serial = excluded.serial, not_before = excluded.not_before, not_after = excluded.not_after, key_algorithm = excluded.key_algorithm, key_usage_json = excluded.key_usage_json, self_signed = excluded.self_signed, is_ca = excluded.is_ca, der = excluded.der`,
      [c.fingerprint, c.kind, c.commonName, c.subject, c.issuer, c.serial, c.notBefore, c.notAfter, c.keyAlgorithm, JSON.stringify(c.keyUsage), c.selfSigned ? 1 : 0, c.isCa ? 1 : 0, enc(c.der), iso(this.clock)],
    );
    return (await this.get(c.fingerprint, c.kind))!;
  }
  async remove(fingerprint: string, kind: CertificateKind): Promise<void> {
    await this.db.execute('DELETE FROM certificates WHERE fingerprint = ? AND kind = ?', [fingerprint, kind]);
  }
}
