// Tauri adapters (SPEC §11). The only module that talks to the Rust side; features never call invoke.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { FolioError, IoError, NetworkError, type ErrorCode } from '@folio/core';
import type { AppStorage, Database, FileKind, FileRef, FileService, HttpClient, HttpRequest, HttpResponse, Platform, SecretStore, Shell, Unsubscribe, WindowService } from '@folio/ports';
import { BrowserClipboard, CanvasImageCodec, IframePrinting, RingLogger, SystemClock, WebCryptoService } from './common.ts';

/** Rust errors arrive as `{ code, message }`; turn them into the typed errors the app understands. */
async function call<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  try {
    return await invoke<T>(cmd, args as never, headers ? { headers } : undefined);
  } catch (e) {
    const err = e as { code?: ErrorCode; message?: string };
    if (err && typeof err === 'object' && err.code === 'network') throw new NetworkError(err.message);
    if (err && typeof err === 'object' && err.code) throw err.code === 'io' ? new IoError(err.message) : new FolioError(err.code, err.message ?? 'Operation failed', { detail: err.message });
    throw new IoError(String(e));
  }
}
const enc = (s: string): string => encodeURIComponent(s);
const bytesOf = (v: ArrayBuffer | Uint8Array | number[]): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

class TauriFileService implements FileService {
  readonly capabilities = { nativePaths: true, watch: false, writeInPlace: true, reveal: true };
  private listeners = new Set<(refs: FileRef[]) => void>();
  constructor() {
    const emit = (refs: FileRef[]): void => {
      for (const l of this.listeners) l(refs);
    };
    // Second-instance launches and drops are granted in Rust, then announced here.
    void listen<FileRef[]>('folio://open', (e) => emit(e.payload));
    void listen<FileRef[]>('folio://drop', (e) => emit(e.payload));
  }
  pickOpen(opts: { multiple?: boolean; accept: FileKind[] }): Promise<FileRef[]> {
    return call('pick_open', { multiple: !!opts.multiple, accept: opts.accept });
  }
  pickSave(opts: { suggestedName: string; kind: FileKind }): Promise<FileRef | null> {
    return call('pick_save', { suggestedName: opts.suggestedName, kind: opts.kind, directory: null });
  }
  pickFolder(): Promise<FileRef | null> {
    return call('pick_folder');
  }
  async read(ref: FileRef): Promise<Uint8Array> {
    return bytesOf(await call<ArrayBuffer>('read_file', { path: ref.path }));
  }
  async write(ref: FileRef, data: Uint8Array, opts: { atomic?: boolean; backup?: boolean } = {}): Promise<void> {
    await call('write_file_atomic', data, { 'x-folio-path': enc(ref.path!), 'x-folio-backup': opts.backup ? '1' : '0' });
  }
  writeInFolder(folder: FileRef, name: string, data: Uint8Array): Promise<FileRef> {
    return call('write_in_folder', data, { 'x-folio-dir': enc(folder.path!), 'x-folio-name': enc(name) });
  }
  exists(folder: FileRef, name: string): Promise<boolean> {
    return call('file_exists', { dir: folder.path, name });
  }
  parentOf(ref: FileRef): Promise<FileRef | null> {
    return call('parent_of', { path: ref.path });
  }
  async reveal(ref: FileRef): Promise<void> {
    await call('reveal_in_folder', { path: ref.path });
  }
  onExternalOpen(cb: (refs: FileRef[]) => void): Unsubscribe {
    this.listeners.add(cb);
    // Files given on the command line or by "Open with" before the UI was ready.
    void call<FileRef[]>('take_pending_open_paths').then((refs) => refs.length && cb(refs));
    return () => this.listeners.delete(cb);
  }
  /** Recent files: true when a path granted in an earlier session still exists. */
  pathExists(path: string): Promise<boolean> {
    return call('path_exists', { path });
  }
}

class TauriStorage implements AppStorage {
  async write(key: string, data: Uint8Array): Promise<void> {
    await call('storage_write', data, { 'x-folio-key': key });
  }
  async read(key: string): Promise<Uint8Array | null> {
    const bytes = bytesOf(await call<ArrayBuffer>('storage_read', { key }));
    return bytes.length ? bytes : null;
  }
  async remove(key: string): Promise<void> {
    await call('storage_remove', { key });
  }
  list(prefix: string): Promise<string[]> {
    return call('storage_list', { prefix });
  }
}

class TauriDatabase implements Database {
  private depth = 0;
  private static bind(params: unknown[] = []): unknown[] {
    return params.map((p) => (p === undefined ? null : p));
  }
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastId?: number }> {
    return call('db_execute', { sql, params: TauriDatabase.bind(params) });
  }
  select<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return call('db_select', { sql, params: TauriDatabase.bind(params) });
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const name = `sp_${this.depth++}`;
    await this.execute(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      await this.execute(`RELEASE ${name}`);
      return result;
    } catch (e) {
      await this.execute(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
}

class TauriSecretStore implements SecretStore {
  constructor(readonly kind: SecretStore['kind']) {}
  get(key: string): Promise<string | null> {
    return call('secret_get', { key });
  }
  async set(key: string, value: string): Promise<void> {
    await call('secret_set', { key, value });
  }
  async remove(key: string): Promise<void> {
    await call('secret_remove', { key });
  }
}

/** Requests go through Rust: no CORS, and the API key is injected there, never in this process. */
class TauriHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal?.aborted) throw new NetworkError('aborted');
    const { signal: _signal, ...plain } = req;
    return call('http_request', { req: plain });
  }
  /** Asks the user (native dialog) to approve a new AI endpoint. */
  allowOrigin(url: string): Promise<boolean> {
    return call('set_ai_origin', { url });
  }
}

class TauriShell implements Shell {
  async openExternal(url: string): Promise<void> {
    if (!/^(https?:|mailto:)/i.test(url)) throw new FolioError('invalidArgument', 'Only web and mail links can be opened');
    await invoke('plugin:opener|open_url', { url });
  }
}

class TauriWindow implements WindowService {
  private handlers = new Set<() => Promise<boolean>>();
  private win = getCurrentWindow();
  constructor() {
    void this.win.onCloseRequested(async (event) => {
      for (const h of this.handlers) {
        if (!(await h())) {
          event.preventDefault();
          return;
        }
      }
    });
  }
  setTitle(t: string): void {
    document.title = t;
    void this.win.setTitle(t);
  }
  setDirty(): void {
    // No native "document edited" indicator on Linux; the tab dot shows it.
  }
  onCloseRequested(cb: () => Promise<boolean>): Unsubscribe {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }
  async setFullscreen(b: boolean): Promise<void> {
    await this.win.setFullscreen(b);
  }
}

export async function createTauriPlatform(): Promise<Platform> {
  const info = await call<{ version: string; os: 'linux' | 'windows' | 'macos'; locale: string; userName?: string }>('app_info');
  const backend = await call<'os-keychain' | 'memory-only'>('secret_backend');
  const files = new TauriFileService();
  const storage = new TauriStorage();
  return {
    files,
    storage,
    db: new TauriDatabase(),
    secrets: new TauriSecretStore(backend),
    http: new TauriHttpClient(),
    shell: new TauriShell(),
    clipboard: new BrowserClipboard(),
    window: new TauriWindow(),
    // WebKitGTK cannot always print from an iframe: fall back to the system viewer with a temp copy.
    printing: new IframePrinting(async (pdf) => {
      await storage.write('print/last.pdf', pdf);
      throw new IoError('Printing from the app is not available on this system. Use "Export a copy" and print from your PDF viewer.');
    }),
    app: info,
    clock: new SystemClock(),
    log: new RingLogger(),
    crypto: new WebCryptoService(),
    images: new CanvasImageCodec(),
  };
}
