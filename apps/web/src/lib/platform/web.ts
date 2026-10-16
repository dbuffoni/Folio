// Browser adapters (SPEC §8.10): File System Access API where available, plain inputs and downloads
// otherwise; SQLite WASM on OPFS; secrets in memory or passphrase-encrypted.
import { InvalidArgumentError, IoError, NetworkError, fromBase64, toBase64, utf8 } from '@folio/core';
import { Oo1Database, type Oo1Db } from '@folio/db';
import { OCR_DOWNLOAD_HOSTS } from '@folio/services';
import type { AppStorage, CryptoService, Database, Downloader, FileKind, FileRef, FileService, HttpClient, HttpRequest, HttpResponse, Platform, SecretStore, Shell, Unsubscribe, WindowService } from '@folio/ports';
import { BrowserClipboard, CanvasImageCodec, IframePrinting, RingLogger, SystemClock, WebCryptoService } from './common.ts';

const TYPES: Record<FileKind, { description: string; accept: Record<string, string[]> } | null> = {
  pdf: { description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } },
  image: { description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'] } },
  json: { description: 'JSON files', accept: { 'application/json': ['.json'] } },
  csv: { description: 'CSV files', accept: { 'text/csv': ['.csv'] } },
  zip: { description: 'ZIP archives', accept: { 'application/zip': ['.zip'] } },
  any: null,
};
const EXT: Record<FileKind, string> = { pdf: '.pdf', image: 'image/*', json: '.json', zip: '.zip', csv: '.csv', any: '' };

interface Entry {
  file?: File;
  handle?: FileSystemFileHandle;
  dir?: FileSystemDirectoryHandle;
  /** Bytes to hand out for files that only exist in memory (sample document). */
  bytes?: Uint8Array;
}
type FsWindow = Window & {
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle>;
};

export class WebFileService implements FileService {
  readonly capabilities: FileService['capabilities'];
  private entries = new Map<string, Entry>();
  private seq = 0;
  private listeners = new Set<(refs: FileRef[]) => void>();
  private w = window as FsWindow;

  constructor() {
    const fsa = typeof this.w.showOpenFilePicker === 'function';
    this.capabilities = { nativePaths: false, watch: false, writeInPlace: fsa, reveal: false };
  }
  private add(name: string, entry: Entry): FileRef {
    const id = `web-${++this.seq}`;
    this.entries.set(id, entry);
    return { id, name };
  }
  /** Files from a drop, a paste or an <input>: registers them and returns references. */
  adopt(files: Iterable<File>, handles: Array<FileSystemFileHandle | undefined> = []): FileRef[] {
    return [...files].map((file, i) => this.add(file.name, { file, handle: handles[i] }));
  }
  /** A document bundled with the app (the "Try it" sample). */
  adoptBytes(name: string, bytes: Uint8Array): FileRef {
    return this.add(name, { bytes });
  }
  /** Drop handler entry point: announces the files like an OS "open with" would. */
  emitOpen(refs: FileRef[]): void {
    for (const l of this.listeners) l(refs);
  }

  private input(opts: { multiple?: boolean; accept: string; directory?: boolean }): Promise<File[]> {
    return new Promise((resolve) => {
      const el = document.createElement('input');
      el.type = 'file';
      el.multiple = !!opts.multiple;
      el.accept = opts.accept;
      el.style.display = 'none';
      el.onchange = () => {
        resolve([...(el.files ?? [])]);
        el.remove();
      };
      el.oncancel = () => {
        resolve([]);
        el.remove();
      };
      document.body.appendChild(el);
      el.click();
    });
  }

  async pickOpen(opts: { multiple?: boolean; accept: FileKind[] }): Promise<FileRef[]> {
    if (this.w.showOpenFilePicker) {
      try {
        const types = opts.accept.map((k) => TYPES[k]).filter(Boolean);
        const handles = await this.w.showOpenFilePicker({ multiple: !!opts.multiple, types: types.length ? types : undefined });
        const files = await Promise.all(handles.map((h) => h.getFile()));
        return this.adopt(files, handles);
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return [];
        // Fall through to the input element (e.g. picker blocked in this context).
      }
    }
    return this.adopt(await this.input({ multiple: opts.multiple, accept: opts.accept.map((k) => EXT[k]).filter(Boolean).join(',') }));
  }
  async pickSave(opts: { suggestedName: string; kind: FileKind }): Promise<FileRef | null> {
    if (this.w.showSaveFilePicker) {
      try {
        const type = TYPES[opts.kind];
        const handle = await this.w.showSaveFilePicker({ suggestedName: opts.suggestedName, types: type ? [type] : undefined });
        return this.add(handle.name, { handle });
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return null;
      }
    }
    // Without the API a "save" is a download under the suggested name.
    return this.add(opts.suggestedName, {});
  }
  async pickFolder(): Promise<FileRef | null> {
    if (this.w.showDirectoryPicker) {
      try {
        const dir = await this.w.showDirectoryPicker({ mode: 'readwrite' });
        return this.add(dir.name, { dir });
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return null;
      }
    }
    // Downloads folder: each file is offered as a download.
    return this.add('Downloads', {});
  }
  async read(ref: FileRef): Promise<Uint8Array> {
    const e = this.entries.get(ref.id);
    if (!e) throw new IoError(`${ref.name} is no longer available`);
    if (e.bytes) return e.bytes.slice();
    try {
      const file = e.handle ? await e.handle.getFile() : e.file;
      if (!file) throw new Error('nothing to read');
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      throw new IoError(`Could not read ${ref.name}`, err);
    }
  }
  private download(name: string, data: Uint8Array): void {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  async write(ref: FileRef, data: Uint8Array): Promise<void> {
    const e = this.entries.get(ref.id);
    try {
      if (e?.handle) {
        // createWritable writes to a temporary file and swaps it in on close: atomic by design.
        const w = await e.handle.createWritable();
        await w.write(data as unknown as FileSystemWriteChunkType);
        await w.close();
        return;
      }
    } catch (err) {
      throw new IoError(`Could not write ${ref.name}`, err);
    }
    this.download(ref.name, data);
  }
  async writeInFolder(folder: FileRef, name: string, data: Uint8Array): Promise<FileRef> {
    const dir = this.entries.get(folder.id)?.dir;
    if (!dir) {
      this.download(name, data);
      return this.add(name, {});
    }
    try {
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(data as unknown as FileSystemWriteChunkType);
      await w.close();
      return this.add(name, { handle });
    } catch (err) {
      throw new IoError(`Could not write ${name}`, err);
    }
  }
  async exists(folder: FileRef, name: string): Promise<boolean> {
    const dir = this.entries.get(folder.id)?.dir;
    if (!dir) return false;
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
  async parentOf(): Promise<FileRef | null> {
    return null; // the browser never reveals where a file lives
  }
  onExternalOpen(cb: (refs: FileRef[]) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

interface Backend {
  write(key: string, data: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Origin-private file system: one flat directory, "/" in keys written as "__". */
class OpfsBackend implements Backend {
  constructor(private readonly root: FileSystemDirectoryHandle) {}
  private name = (key: string): string => key.replace(/\//g, '__');
  async write(key: string, data: Uint8Array): Promise<void> {
    const w = await (await this.root.getFileHandle(this.name(key), { create: true })).createWritable();
    await w.write(data as unknown as FileSystemWriteChunkType);
    await w.close();
  }
  async read(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await (await (await this.root.getFileHandle(this.name(key))).getFile()).arrayBuffer());
    } catch {
      return null;
    }
  }
  async remove(key: string): Promise<void> {
    await this.root.removeEntry(this.name(key)).catch(() => undefined);
  }
  async keys(): Promise<string[]> {
    const out: string[] = [];
    for await (const name of (this.root as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(name.replace(/__/g, '/'));
    return out;
  }
}

/** IndexedDB, for browsers whose OPFS cannot be written from the page (WebKit). */
class IdbBackend implements Backend {
  constructor(private readonly db: IDBDatabase) {}
  static open(): Promise<IdbBackend> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('folio-storage', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(new IdbBackend(req.result));
      req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'));
    });
  }
  private run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = fn(this.db.transaction('files', mode).objectStore('files'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  }
  write = (key: string, data: Uint8Array): Promise<void> => this.run('readwrite', (s) => s.put(data.slice(), key)).then(() => undefined);
  read = async (key: string): Promise<Uint8Array | null> => ((await this.run('readonly', (s) => s.get(key))) as Uint8Array | undefined) ?? null;
  remove = (key: string): Promise<void> => this.run('readwrite', (s) => s.delete(key)).then(() => undefined);
  keys = async (): Promise<string[]> => (await this.run('readonly', (s) => s.getAllKeys())).map(String);
}

class MemoryBackend implements Backend {
  private map = new Map<string, Uint8Array>();
  write = async (key: string, data: Uint8Array): Promise<void> => void this.map.set(key, data.slice());
  read = async (key: string): Promise<Uint8Array | null> => this.map.get(key)?.slice() ?? null;
  remove = async (key: string): Promise<void> => void this.map.delete(key);
  keys = async (): Promise<string[]> => [...this.map.keys()];
}

/** Private app storage: OPFS where the page can write to it, else IndexedDB, else memory for this session. */
export class WebStorage implements AppStorage {
  private backend: Promise<Backend>;
  constructor() {
    this.backend = (async (): Promise<Backend> => {
      try {
        if (typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype)
          return new OpfsBackend(await (await navigator.storage.getDirectory()).getDirectoryHandle('folio-storage', { create: true }));
      } catch {
        // fall through to IndexedDB
      }
      try {
        return await IdbBackend.open();
      } catch {
        return new MemoryBackend();
      }
    })();
  }
  write = async (key: string, data: Uint8Array): Promise<void> => (await this.backend).write(key, data);
  read = async (key: string): Promise<Uint8Array | null> => (await this.backend).read(key);
  remove = async (key: string): Promise<void> => (await this.backend).remove(key);
  async list(prefix: string): Promise<string[]> {
    return (await (await this.backend).keys()).filter((k) => k.startsWith(prefix)).sort();
  }
}

/**
 * SQLite WASM. The database lives in memory and is persisted to OPFS as a whole file after writes
 * (debounced): this needs neither a worker nor cross-origin isolation, and app data is tiny.
 */
export async function openWebDatabase(storage: AppStorage): Promise<Database> {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const saved = await storage.read('db/folio.sqlite3');
  if (saved?.length) {
    const p = sqlite3.wasm.allocFromTypedArray(saved);
    const rc = sqlite3.capi.sqlite3_deserialize(db.pointer!, 'main', p, saved.length, saved.length, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc !== 0) console.warn('Folio: stored database could not be loaded; starting fresh');
  }
  const inner = new Oo1Database(db as unknown as Oo1Db);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void storage.write('db/folio.sqlite3', sqlite3.capi.sqlite3_js_db_export(db.pointer!)), 60);
  };
  const wrap = (d: Database): Database => ({
    execute: async (sql, params) => {
      const r = await d.execute(sql, params);
      persist();
      return r;
    },
    select: (sql, params) => d.select(sql, params),
    transaction: (fn) => d.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

const STORE_KEY = 'folio.secrets.v1';
/**
 * Secrets on the web (SPEC §12.4): memory-only by default. After `unlock(passphrase)` they are also
 * kept in localStorage, AES-GCM encrypted with a PBKDF2 key — protection against casual access only.
 */
export class WebSecretStore implements SecretStore {
  private values = new Map<string, string>();
  private key: Uint8Array | null = null;
  private salt: Uint8Array | null = null;
  constructor(private readonly crypto: CryptoService, private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage) {}
  get kind(): SecretStore['kind'] {
    return this.key ? 'passphrase-encrypted' : 'memory-only';
  }
  /** True when an encrypted store exists and needs the passphrase. */
  get locked(): boolean {
    return !this.key && this.storage.getItem(STORE_KEY) !== null;
  }
  /** Unlocks (or creates) the encrypted store. Returns false for a wrong passphrase. */
  async unlock(passphrase: string): Promise<boolean> {
    const raw = this.storage.getItem(STORE_KEY);
    if (raw) {
      const { salt, data } = JSON.parse(raw) as { salt: string; data: string };
      const key = await this.crypto.deriveKey(passphrase, fromBase64(salt));
      try {
        const stored = JSON.parse(utf8.decode(await this.crypto.decrypt(key, fromBase64(data)))) as Record<string, string>;
        for (const [k, v] of Object.entries(stored)) if (!this.values.has(k)) this.values.set(k, v);
        this.key = key;
        this.salt = fromBase64(salt);
      } catch {
        return false;
      }
    } else {
      this.salt = this.crypto.randomBytes(16);
      this.key = await this.crypto.deriveKey(passphrase, this.salt);
    }
    await this.persist();
    return true;
  }
  /** Stops persisting and forgets the stored copy. */
  forgetDevice(): void {
    this.key = null;
    this.salt = null;
    this.storage.removeItem(STORE_KEY);
  }
  private async persist(): Promise<void> {
    if (!this.key || !this.salt) return;
    const data = await this.crypto.encrypt(this.key, utf8.encode(JSON.stringify(Object.fromEntries(this.values))));
    this.storage.setItem(STORE_KEY, JSON.stringify({ salt: toBase64(this.salt), data: toBase64(data) }));
  }
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    await this.persist();
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
    await this.persist();
  }
}

/** fetch-based client. In the browser the key necessarily passes through JavaScript (noted in the UI). */
export class WebHttpClient implements HttpClient {
  constructor(private readonly secrets: SecretStore) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    for (const [name, ref] of Object.entries(req.secretHeaders ?? {})) {
      const secret = await this.secrets.get(ref.secret);
      if (secret) headers[name] = (ref.format ?? '{secret}').replace('{secret}', secret);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? 60_000);
    req.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const res = await fetch(req.url, { method: req.method, headers, body: req.body, signal: ac.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => (out[k] = v));
      return { status: res.status, headers: out, body: await res.text() };
    } catch (e) {
      // CORS failures surface as TypeError: the UI explains that a CORS-capable endpoint or proxy is needed.
      throw new NetworkError(String((e as Error).message ?? e), e);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Language data downloads (FR-OCR-02): fixed host, checksum checked, never without a user action. */
export class WebDownloader implements Downloader {
  constructor(private readonly crypto: CryptoService) {}
  async download(req: Parameters<Downloader['download']>[0]): Promise<Uint8Array> {
    const url = new URL(req.url);
    if (url.protocol !== 'https:' || !OCR_DOWNLOAD_HOSTS.includes(url.host) || url.username || url.password) throw new InvalidArgumentError('Downloads are only allowed from the OCR language host', { reason: 'ocrHost' });
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: req.signal });
    } catch (e) {
      throw new NetworkError(String((e as Error).message ?? e), e);
    }
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    if (total > req.maxBytes) throw new NetworkError('The file is larger than expected');
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new NetworkError('No data');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > req.maxBytes) throw new NetworkError('The file is larger than expected');
      chunks.push(value);
      req.onProgress?.(received, total || received);
    }
    const out = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    const hex = Array.from(await this.crypto.sha256(out), (b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== req.sha256) throw new IoError('checksum');
    return out;
  }
}

class WebShell implements Shell {
  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
class WebWindow implements WindowService {
  private dirty = false;
  constructor() {
    // Browsers only allow a generic "leave site?" prompt; the close guard per tab is handled in-app.
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) e.preventDefault();
    });
  }
  setTitle(t: string): void {
    document.title = t;
  }
  setDirty(d: boolean): void {
    this.dirty = d;
  }
  onCloseRequested(): Unsubscribe {
    return () => undefined;
  }
  async setFullscreen(b: boolean): Promise<void> {
    if (b) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  }
}

export async function createWebPlatform(version: string): Promise<Platform> {
  const crypto = new WebCryptoService();
  const storage = new WebStorage();
  const secrets = new WebSecretStore(crypto);
  return {
    files: new WebFileService(),
    storage,
    db: await openWebDatabase(storage),
    secrets,
    http: new WebHttpClient(secrets),
    downloader: new WebDownloader(crypto),
    shell: new WebShell(),
    clipboard: new BrowserClipboard(),
    window: new WebWindow(),
    printing: new IframePrinting(),
    app: { version, os: 'web', locale: navigator.language || 'en' },
    clock: new SystemClock(),
    log: new RingLogger(),
    crypto,
    images: new CanvasImageCodec(),
  };
}
