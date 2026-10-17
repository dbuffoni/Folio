export type Unsubscribe = () => void;
export type FileKind = 'pdf' | 'image' | 'json' | 'zip' | 'csv' | 'pkcs12' | 'certificate' | 'any';

export interface FileRef {
  id: string;
  name: string;
  /** Absolute path; desktop only. */
  path?: string;
}

export interface FileService {
  readonly capabilities: { nativePaths: boolean; watch: boolean; writeInPlace: boolean; reveal: boolean };
  pickOpen(opts: { multiple?: boolean; accept: FileKind[] }): Promise<FileRef[]>;
  pickSave(opts: { suggestedName: string; kind: FileKind }): Promise<FileRef | null>;
  pickFolder(): Promise<FileRef | null>;
  read(ref: FileRef): Promise<Uint8Array>;
  write(ref: FileRef, data: Uint8Array, opts?: { atomic?: boolean; backup?: boolean }): Promise<void>;
  writeInFolder(folder: FileRef, name: string, data: Uint8Array): Promise<FileRef>;
  exists(folder: FileRef, name: string): Promise<boolean>;
  /** Folder containing the file, when the platform can know it. */
  parentOf(ref: FileRef): Promise<FileRef | null>;
  reveal?(ref: FileRef): Promise<void>;
  onExternalOpen(cb: (refs: FileRef[]) => void): Unsubscribe; // CLI args, file association, drag and drop
  watch?(ref: FileRef, cb: () => void): Unsubscribe;
}

/** Private per-app storage for recovery snapshots and history spill files. */
export interface AppStorage {
  write(key: string, data: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface Database {
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastId?: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  readonly kind: 'os-keychain' | 'passphrase-encrypted' | 'memory-only';
}

/** Reference to a secret that the HTTP adapter resolves itself, so the value never reaches feature code. */
export interface SecretRef {
  secret: string;
  /** Template for the header value; `{secret}` is replaced. Default `{secret}`. */
  format?: string;
}
export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  secretHeaders?: Record<string, SecretRef>;
  signal?: AbortSignal;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * Binary HTTP for the optional network steps of digital signatures (timestamps, revocation checks).
 * Absent where the shell cannot do it. Desktop asks the user to approve each new host first.
 */
export interface BinaryTransport {
  request(req: { url: string; method: 'GET' | 'POST'; body?: Uint8Array; contentType?: string; signal?: AbortSignal }): Promise<Uint8Array>;
}

export interface Shell {
  openExternal(url: string): Promise<void>;
}
export interface Clipboard {
  readImage(): Promise<Uint8Array | null>;
  /** The image may still be rendering: browsers only accept a clipboard write inside the user gesture. */
  writeImage(png: Uint8Array | Promise<Uint8Array>): Promise<void>;
  writeText(t: string): Promise<void>;
}
export interface WindowService {
  setTitle(t: string): void;
  setDirty(d: boolean): void;
  onCloseRequested(cb: () => Promise<boolean>): Unsubscribe;
  setFullscreen(b: boolean): Promise<void>;
}
export interface PrintOptions {
  pages?: number[];
  copies?: number;
  scale?: 'fit' | 'actual';
}
export interface Printing {
  print(pdf: Uint8Array, opts?: PrintOptions): Promise<void>;
}
export interface AppInfo {
  version: string;
  os: 'linux' | 'windows' | 'macos' | 'web';
  locale: string;
  userName?: string;
}
export interface Clock {
  now(): Date;
}
export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** Recent log lines for "Copy diagnostics". */
  dump(): string;
}

/** Symmetric crypto (WebCrypto in both shells); behind a port so core stays free of globals. */
export interface CryptoService {
  randomBytes(n: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  /** AES-256-GCM; returns iv || ciphertext || tag. */
  encrypt(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array>;
  decrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  /** PBKDF2-SHA256 → 32-byte key. */
  deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array>;
}

/** Raster codec (canvas in the browser, pure JS in Node). */
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export interface ImageCodec {
  decode(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray; format: ImageFormat | 'tiff' }>;
  encode(
    image: { width: number; height: number; data: Uint8ClampedArray },
    format: ImageFormat,
    opts?: { quality?: number },
  ): Promise<Uint8Array>;
  supports(format: ImageFormat): boolean;
}

export interface Platform {
  /** Verified downloads of OCR language data (FR-OCR-02); absent in builds that cannot download. */
  downloader?: import('./ocr.ts').Downloader;
  files: FileService;
  storage: AppStorage;
  db: Database;
  secrets: SecretStore;
  http: HttpClient;
  /** Timestamp and revocation traffic of digital signatures; absent when the shell has no network access for it. */
  network?: BinaryTransport;
  shell: Shell;
  clipboard: Clipboard;
  window: WindowService;
  printing: Printing;
  app: AppInfo;
  clock: Clock;
  log: Logger;
  crypto: CryptoService;
  images: ImageCodec;
}
