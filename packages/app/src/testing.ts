// Headless application harness for tests and folio-cli scenarios (not exported from the package index).
import { readFile } from 'node:fs/promises';
import type { Msg } from '@folio/core';
import type { AiProvider, Platform } from '@folio/ports';
import {
  FakeClipboard, FakeClock, FakeFileService, FakeHttpClient, FakePrinting, FakeSecretStore, FakeShell, FakeWindow, InMemoryDatabase, ManualTicker, MemoryLogger, MemoryStorage,
  NodeCrypto, NodeImageCodec, fixture, sharedEngine,
} from '@folio/testkit';
import { AppModel } from './app.ts';
import { CompressModel, ExportImagesModel, FormAuthoringModel, FormModel, ImagesWizard, MergeWizard, OrganiseModel, OutlineModel, SignModel, SmartFillModel, SplitWizard } from './features.ts';
import type { Prompts } from './prompts.ts';
import { createRegistry, type CommandContext } from './registry.ts';
import { Services } from './services.ts';
import type { DocumentSession } from './session.ts';
import { ToolController } from './tools.ts';
import { FindModel, UiState } from './ui.ts';

/** Scripted answers to every question the app can ask; records what was asked. */
export class ScriptedPrompts implements Prompts {
  readonly asked: string[] = [];
  passwords: Array<string | null> = [];
  closeAnswers: Array<'save' | 'discard' | 'cancel'> = [];
  confirmAnswers: boolean[] = [];
  signedAnswers: Array<'incremental' | 'rewrite' | 'cancel'> = [];
  recover: 'all' | 'none' = 'all';
  linkAnswers: boolean[] = [];
  async askPassword(fileName: string, wrong: boolean): Promise<string | null> {
    this.asked.push(`password:${fileName}:${wrong}`);
    return this.passwords.shift() ?? null;
  }
  async confirmClose(fileName: string): Promise<'save' | 'discard' | 'cancel'> {
    this.asked.push(`close:${fileName}`);
    return this.closeAnswers.shift() ?? 'cancel';
  }
  async confirm(message: Msg): Promise<boolean> {
    this.asked.push(`confirm:${message.key}`);
    return this.confirmAnswers.shift() ?? true;
  }
  async confirmSignedSave(fileName: string): Promise<'incremental' | 'rewrite' | 'cancel'> {
    this.asked.push(`signed:${fileName}`);
    return this.signedAnswers.shift() ?? 'incremental';
  }
  async offerRecovery(items: Array<{ sessionId: string; name: string }>): Promise<string[]> {
    this.asked.push(`recovery:${items.map((i) => i.name).join(',')}`);
    return this.recover === 'all' ? items.map((i) => i.sessionId) : [];
  }
  async confirmOpenLink(host: string): Promise<boolean> {
    this.asked.push(`link:${host}`);
    return this.linkAnswers.shift() ?? false;
  }
}

export interface TestApp {
  app: AppModel;
  services: Services;
  prompts: ScriptedPrompts;
  files: FakeFileService;
  storage: MemoryStorage;
  db: InMemoryDatabase;
  secrets: FakeSecretStore;
  http: FakeHttpClient;
  shell: FakeShell;
  clipboard: FakeClipboard;
  window: FakeWindow;
  printing: FakePrinting;
  clock: FakeClock;
  ticker: ManualTicker;
  ui: UiState;
  sign: SignModel;
  registry: ReturnType<typeof createRegistry>;
  /** Puts a fixture on the virtual disk and returns its path. */
  put(path: string, fixtureName: string): Promise<string>;
  /** Opens a fixture as a saved file in a new tab. */
  open(fixtureName: string, path?: string): Promise<DocumentSession>;
  /** Per-session models, created on demand like the shell does. */
  tools(session: DocumentSession): ToolController;
  organise(session: DocumentSession): OrganiseModel;
  form(session: DocumentSession): FormModel;
  author(session: DocumentSession): FormAuthoringModel;
  outline(session: DocumentSession): OutlineModel;
  find(session: DocumentSession): FindModel;
  smartFill(session: DocumentSession): SmartFillModel;
  split(session: DocumentSession): SplitWizard;
  exportImages(session: DocumentSession): ExportImagesModel;
  compress(session: DocumentSession): CompressModel;
  merge(): MergeWizard;
  images(): ImagesWizard;
  /** Context for running registry commands against the active tab. */
  ctx(): CommandContext;
  toastKeys(): string[];
}

export interface TestAppOptions {
  /** Reuse storage/database/files from a previous instance to simulate a restart. */
  from?: Pick<TestApp, 'storage' | 'db' | 'files' | 'secrets' | 'clock'>;
  ai?: AiProvider;
  userName?: string;
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const engine = await sharedEngine();
  const files = opts.from?.files ?? new FakeFileService();
  const storage = opts.from?.storage ?? new MemoryStorage();
  const db = opts.from?.db ?? new InMemoryDatabase();
  const secrets = opts.from?.secrets ?? new FakeSecretStore();
  const clock = opts.from?.clock ?? new FakeClock();
  const http = new FakeHttpClient(secrets);
  const shell = new FakeShell();
  const clipboard = new FakeClipboard();
  const window = new FakeWindow();
  const printing = new FakePrinting();
  const ticker = new ManualTicker();
  const platform: Platform = {
    files, storage, db, secrets, http, shell, clipboard, window, printing, clock,
    app: { version: '0.1.0-test', os: 'linux', locale: 'en', userName: opts.userName ?? 'marta' },
    log: new MemoryLogger(),
    crypto: new NodeCrypto(),
    images: new NodeImageCodec(),
  };
  let seq = 0;
  const services = new Services({ platform, engine, ai: opts.ai, newId: () => `id-${++seq}`, loadFont: (name) => readFile(new URL(`../../../assets/fonts/handwriting/${name}.ttf`, import.meta.url)) });
  const prompts = new ScriptedPrompts();
  const app = new AppModel(services, prompts, ticker);
  await app.start();
  await app.offerRecovery();
  const ui = new UiState();
  const sign = new SignModel(app);
  const registry = createRegistry();
  const cache = new Map<string, { tools?: ToolController; organise?: OrganiseModel; form?: FormModel; author?: FormAuthoringModel; outline?: OutlineModel; find?: FindModel }>();
  const slot = (s: DocumentSession) => {
    let c = cache.get(s.id);
    if (!c) cache.set(s.id, (c = {}));
    return c;
  };
  const t: TestApp = {
    app, services, prompts, files, storage, db, secrets, http, shell, clipboard, window, printing, clock, ticker, ui, sign, registry,
    async put(path, fixtureName) {
      files.put(path, await fixture(fixtureName));
      return path;
    },
    async open(fixtureName, path = `/docs/${fixtureName}.pdf`) {
      await t.put(path, fixtureName);
      const s = await app.openRef(files.ref(path));
      if (!s) throw new Error(`could not open ${fixtureName}`);
      return s;
    },
    tools: (s) => (slot(s).tools ??= new ToolController(s, services, { error: (e) => app.reportError(e), info: (m) => void app.toast('info', m) })),
    organise: (s) => (slot(s).organise ??= new OrganiseModel(app, s)),
    form: (s) => (slot(s).form ??= new FormModel(app, s)),
    author: (s) => (slot(s).author ??= new FormAuthoringModel(app, s)),
    outline: (s) => (slot(s).outline ??= new OutlineModel(app, s)),
    find: (s) => (slot(s).find ??= new FindModel(s)),
    smartFill: (s) => new SmartFillModel(app, s),
    split: (s) => new SplitWizard(app, s),
    exportImages: (s) => new ExportImagesModel(app, s),
    compress: (s) => new CompressModel(app, s),
    merge: () => new MergeWizard(app),
    images: () => new ImagesWizard(app),
    ctx() {
      const session = app.active;
      return { app, ui, sign, session, tools: session ? t.tools(session) : null, find: session ? t.find(session) : null, organise: session ? t.organise(session) : null };
    },
    toastKeys: () => app.toasts.map((x) => x.message.key),
  };
  return t;
}

/** "Page N of M" number of every page (0 for pages without one). */
export async function markers(s: DocumentSession): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < s.pageCount; i++) out.push(Number(/Page (\d+) of/.exec((await s.doc.getTextLayer(i)).text)?.[1] ?? 0));
  return out;
}
/** Waits until `condition` holds (polling), for work a command starts without awaiting it. */
export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** Lets queued microtasks and async invalidations settle. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 15));
