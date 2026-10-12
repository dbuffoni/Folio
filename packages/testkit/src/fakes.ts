// In-memory fakes of the platform ports (SPEC §16.4).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { IoError, NetworkError } from '@folio/core';
import type {
  AppStorage,
  Clipboard,
  Database,
  FileKind,
  FileRef,
  FileService,
  HttpClient,
  HttpRequest,
  HttpResponse,
  Printing,
  SecretStore,
  Shell,
  Unsubscribe,
  WindowService,
} from '@folio/ports';

/** Virtual file system. Paths are plain strings ("/docs/a.pdf"); folders are implicit. */
export class FakeFileService implements FileService {
  readonly capabilities = { nativePaths: true, watch: false, writeInPlace: true, reveal: true };
  readonly files = new Map<string, Uint8Array>();
  /** Queue of answers for the next picker calls. */
  nextOpen: string[][] = [];
  nextSave: (string | null)[] = [];
  nextFolder: (string | null)[] = [];
  readonly revealed: string[] = [];
  readonly writes: Array<{ path: string; atomic: boolean; backup: boolean }> = [];
  failWrites = false;
  private external = new Set<(refs: FileRef[]) => void>();

  ref(path: string): FileRef {
    return { id: path, name: path.split('/').pop() ?? path, path };
  }
  put(path: string, data: Uint8Array): FileRef {
    this.files.set(path, data.slice());
    return this.ref(path);
  }
  get(path: string): Uint8Array | undefined {
    return this.files.get(path);
  }
  list(folder: string): string[] {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  async pickOpen(_opts: { multiple?: boolean; accept: FileKind[] }): Promise<FileRef[]> {
    return (this.nextOpen.shift() ?? []).map((p) => this.ref(p));
  }
  async pickSave(_opts: { suggestedName: string; kind: FileKind }): Promise<FileRef | null> {
    const p = this.nextSave.shift() ?? null;
    return p ? this.ref(p) : null;
  }
  async pickFolder(): Promise<FileRef | null> {
    const p = this.nextFolder.shift() ?? null;
    return p ? this.ref(p) : null;
  }
  async read(ref: FileRef): Promise<Uint8Array> {
    const data = this.files.get(ref.path ?? ref.id);
    if (!data) throw new IoError(`No such file: ${ref.path ?? ref.id}`);
    return data.slice();
  }
  async write(ref: FileRef, data: Uint8Array, opts: { atomic?: boolean; backup?: boolean } = {}): Promise<void> {
    if (this.failWrites) throw new IoError('Disk full (simulated)');
    const path = ref.path ?? ref.id;
    const previous = this.files.get(path);
    if (opts.backup && previous) this.files.set(`${path}.bak`, previous);
    this.files.set(path, data.slice());
    this.writes.push({ path, atomic: !!opts.atomic, backup: !!opts.backup });
  }
  async writeInFolder(folder: FileRef, name: string, data: Uint8Array): Promise<FileRef> {
    const ref = this.ref(`${folder.path ?? folder.id}/${name}`);
    await this.write(ref, data, { atomic: true });
    return ref;
  }
  async exists(folder: FileRef, name: string): Promise<boolean> {
    return this.files.has(`${folder.path ?? folder.id}/${name}`);
  }
  async parentOf(ref: FileRef): Promise<FileRef | null> {
    const path = ref.path ?? ref.id;
    const i = path.lastIndexOf('/');
    return i > 0 ? this.ref(path.slice(0, i)) : null;
  }
  async reveal(ref: FileRef): Promise<void> {
    this.revealed.push(ref.path ?? ref.id);
  }
  onExternalOpen(cb: (refs: FileRef[]) => void): Unsubscribe {
    this.external.add(cb);
    return () => this.external.delete(cb);
  }
  /** Simulates "Open with", a CLI argument or a file drop. */
  emitExternalOpen(paths: string[]): void {
    for (const cb of this.external) cb(paths.map((p) => this.ref(p)));
  }
}

export class MemoryStorage implements AppStorage {
  readonly items = new Map<string, Uint8Array>();
  async write(key: string, data: Uint8Array): Promise<void> {
    this.items.set(key, data.slice());
  }
  async read(key: string): Promise<Uint8Array | null> {
    return this.items.get(key)?.slice() ?? null;
  }
  async remove(key: string): Promise<void> {
    this.items.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.items.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** Real SQLite (Node's built-in driver) in memory: the same SQL the desktop app runs. */
export class InMemoryDatabase implements Database {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys=ON');
  }
  private static bind(params: unknown[] = []): SQLInputValue[] {
    return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as SQLInputValue)));
  }
  async execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastId?: number }> {
    if (!params?.length && /;\s*\S/.test(sql)) {
      this.db.exec(sql);
      return { changes: 0 };
    }
    const r = this.db.prepare(sql).run(...InMemoryDatabase.bind(params));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }
  async select<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...InMemoryDatabase.bind(params)) as T[];
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const name = `sp_${this.depth++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
  close(): void {
    this.db.close();
  }
}

export class FakeSecretStore implements SecretStore {
  readonly kind = 'memory-only' as const;
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export type HttpHandler = (req: HttpRequest & { resolvedHeaders: Record<string, string> }) => HttpResponse | Promise<HttpResponse> | Error;
/** Scripted HTTP client. Records every request; resolves secret headers like the real adapters do. */
export class FakeHttpClient implements HttpClient {
  readonly requests: Array<HttpRequest & { resolvedHeaders: Record<string, string> }> = [];
  private queue: HttpHandler[] = [];
  fallback: HttpHandler = () => new NetworkError('No scripted response');
  constructor(private readonly secrets?: SecretStore) {}
  /** Queues responses for the next requests, in order. */
  enqueue(...handlers: Array<HttpHandler | HttpResponse>): this {
    for (const h of handlers) this.queue.push(typeof h === 'function' ? h : () => h);
    return this;
  }
  static json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }
  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal?.aborted) throw new NetworkError('aborted');
    const resolvedHeaders: Record<string, string> = { ...(req.headers ?? {}) };
    for (const [name, ref] of Object.entries(req.secretHeaders ?? {})) {
      const secret = (await this.secrets?.get(ref.secret)) ?? '';
      resolvedHeaders[name] = (ref.format ?? '{secret}').replace('{secret}', secret);
    }
    const full = { ...req, resolvedHeaders };
    this.requests.push(full);
    const result = await (this.queue.shift() ?? this.fallback)(full);
    if (result instanceof Error) throw result;
    return result;
  }
}

export class FakeShell implements Shell {
  readonly opened: string[] = [];
  async openExternal(url: string): Promise<void> {
    this.opened.push(url);
  }
}
export class FakeClipboard implements Clipboard {
  image: Uint8Array | null = null;
  text = '';
  async readImage(): Promise<Uint8Array | null> {
    return this.image;
  }
  async writeImage(png: Uint8Array): Promise<void> {
    this.image = png;
  }
  async writeText(t: string): Promise<void> {
    this.text = t;
  }
}
export class FakeWindow implements WindowService {
  title = '';
  dirty = false;
  fullscreen = false;
  private closeHandlers = new Set<() => Promise<boolean>>();
  setTitle(t: string): void {
    this.title = t;
  }
  setDirty(d: boolean): void {
    this.dirty = d;
  }
  onCloseRequested(cb: () => Promise<boolean>): Unsubscribe {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }
  async setFullscreen(b: boolean): Promise<void> {
    this.fullscreen = b;
  }
  /** Simulates the user closing the window; true when every handler allows it. */
  async requestClose(): Promise<boolean> {
    for (const h of this.closeHandlers) if (!(await h())) return false;
    return true;
  }
}
export class FakePrinting implements Printing {
  readonly jobs: Array<{ bytes: number; pdf: Uint8Array; opts?: unknown }> = [];
  async print(pdf: Uint8Array, opts?: unknown): Promise<void> {
    this.jobs.push({ bytes: pdf.length, pdf, opts });
  }
}

/** Manual ticker for schedulers: `tick()` fires every registered callback once. */
export class ManualTicker {
  private fns = new Map<number, { ms: number; fn: () => void }>();
  private seq = 0;
  every(ms: number, fn: () => void): () => void {
    const id = ++this.seq;
    this.fns.set(id, { ms, fn });
    return () => this.fns.delete(id);
  }
  tick(): void {
    for (const { fn } of [...this.fns.values()]) fn();
  }
  get intervals(): number[] {
    return [...this.fns.values()].map((f) => f.ms);
  }
}
