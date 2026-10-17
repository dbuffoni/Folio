// Wires the UI-less application layer to Svelte. Models stay plain classes; any `changed` event bumps
// one reactive counter, and components read it through `track()` to re-evaluate.
import {
  AiSettingsModel, AppModel, CertificatesModel, CompressModel, DigitalSignModel, SignaturePanelModel, ExportImagesModel, FindModel, FormAuthoringModel, FormModel, ImagesWizard, MergeWizard, OcrModel, OrganiseModel, TablesModel, OutlineModel, ProfilesModel, Services, SignModel, SmartFillModel, SplitWizard, ToolController, UiState, createRegistry,
  type CommandContext, type DocumentSession, type Prompts,
} from '@folio/app';
import type { Emitter, Msg } from '@folio/core';
import type { FileRef } from '@folio/ports';
import type { HandwritingFont } from '@folio/services';
import { createWorkerEngine, loadHandwritingFont } from './engine/index.ts';
import { setLocale } from './i18n/index.ts';
import { bridge, bump, bumpPage, live, raw, track, trackPage } from './live.svelte.ts';
import { createBrowserOcr, loadBundledLanguage } from './ocr/index.ts';
import { createPlatform, isTauri } from './platform/index.ts';
import { installPerf, installPerfPanel, perfRequested, registerPerfShortcut } from './perf.ts';

export const VERSION = '0.1.0';

const state = $state({ ready: false, error: '' as string });
export { track, trackPage, raw };
export const boot = state;
/** `dep(track(), value)`: explicit form of the dependency every read of a live model registers. */
export const dep = <T>(_version: number, value: T): T => value;
const watch = (e: Emitter<void>): void => void e.on(bump);

// ---- prompts: the dialogs the application layer can ask for --------------------------------------

export type PromptRequest =
  | { kind: 'password'; fileName: string; wrong: boolean; resolve: (v: string | null) => void }
  | { kind: 'close'; fileName: string; resolve: (v: 'save' | 'discard' | 'cancel') => void }
  | { kind: 'confirm'; message: Msg; danger: boolean; confirmLabel?: Msg; resolve: (v: boolean) => void }
  | { kind: 'signed'; fileName: string; resolve: (v: 'incremental' | 'rewrite' | 'cancel') => void }
  | { kind: 'recovery'; items: Array<{ sessionId: string; name: string; savedAt: string }>; resolve: (v: string[]) => void }
  | { kind: 'link'; host: string; uri: string; resolve: (v: boolean) => void };
class UiPrompts implements Prompts {
  // Raw state: entries are compared by identity when they are answered.
  queue = $state.raw<PromptRequest[]>([]);
  private ask<R>(req: Record<string, unknown>): Promise<R> {
    return new Promise<R>((resolve) => {
      const entry = {
        ...req,
        resolve: (v: R) => {
          this.queue = this.queue.filter((q) => q !== (entry as unknown as PromptRequest));
          resolve(v);
        },
      } as unknown as PromptRequest;
      this.queue = [...this.queue, entry];
    });
  }
  askPassword = (fileName: string, wrong: boolean) => this.ask<string | null>({ kind: 'password', fileName, wrong });
  confirmClose = (fileName: string) => this.ask<'save' | 'discard' | 'cancel'>({ kind: 'close', fileName });
  confirm = (message: Msg, opts: { danger?: boolean; confirmLabel?: Msg } = {}) => this.ask<boolean>({ kind: 'confirm', message, danger: !!opts.danger, confirmLabel: opts.confirmLabel });
  confirmSignedSave = (fileName: string) => this.ask<'incremental' | 'rewrite' | 'cancel'>({ kind: 'signed', fileName });
  offerRecovery = (items: Array<{ sessionId: string; name: string; savedAt: string }>) => this.ask<string[]>({ kind: 'recovery', items });
  confirmOpenLink = (host: string, uri: string) => this.ask<boolean>({ kind: 'link', host, uri });
}
export const prompts = new UiPrompts();

// ---- application objects (assigned once by `start`) -----------------------------------------------

export let app: AppModel;
export let services: Services;
export const ui = live(new UiState());
export let sign: SignModel;
export const registry = createRegistry();
export const desktop = isTauri();
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

interface PerSession {
  tools: ToolController;
  organise: OrganiseModel;
  form: FormModel;
  author: FormAuthoringModel;
  outline: OutlineModel;
  ocr: OcrModel;
  tables: TablesModel;
  find: FindModel;
  smart: SmartFillModel;
}
const perSession = new Map<string, PerSession>();
/** View-models of one document, created on first use and dropped with the tab. */
export function models(view: DocumentSession): PerSession {
  const session = raw(view);
  let m = perSession.get(session.id);
  if (!m) {
    const tools = new ToolController(session, raw(services), { error: (e) => app.reportError(e), info: (msg) => void app.toast('info', msg) });
    m = {
      tools,
      organise: new OrganiseModel(raw(app), session),
      form: new FormModel(raw(app), session),
      author: new FormAuthoringModel(raw(app), session),
      outline: new OutlineModel(raw(app), session),
      ocr: new OcrModel(raw(app), session),
      tables: new TablesModel(raw(app), session, tools),
      find: new FindModel(session),
      smart: new SmartFillModel(raw(app), session),
    };
    for (const model of Object.values(m)) watch(model.changed);
    void session.pageChanged.on(bumpPage);
    void m.form.load();
    void m.outline.load();
    perSession.set(session.id, m);
  }
  return live(m);
}
export function commandContext(): CommandContext {
  // Commands work on the models themselves, never on their reactive views.
  const session = raw(app).active;
  const m = session ? raw(models(session)) : null;
  return { app: raw(app), ui: raw(ui), sign: raw(sign), session, tools: m?.tools ?? null, find: m?.find ?? null, organise: m?.organise ?? null };
}
/** Runs a registry command by id against the active tab. */
export const run = (id: string): Promise<boolean> => registry.run(id, commandContext());

// Wizards are created when their dialog opens.
export const wizards = {
  merge: (): MergeWizard => observe(new MergeWizard(raw(app))),
  split: (s: DocumentSession): SplitWizard => observe(new SplitWizard(raw(app), raw(s))),
  images: (): ImagesWizard => observe(new ImagesWizard(raw(app))),
  ocr: (s: DocumentSession): OcrModel => observe(new OcrModel(raw(app), raw(s))),
  compress: (s: DocumentSession): CompressModel => observe(new CompressModel(raw(app), raw(s))),
  digitalSign: (s: DocumentSession): DigitalSignModel => observe(new DigitalSignModel(raw(app), raw(s))),
  signatures: (s: DocumentSession): SignaturePanelModel => observe(new SignaturePanelModel(raw(app), raw(s))),
  certificates: (): CertificatesModel => observe(new CertificatesModel(raw(app))),
  exportImages: (s: DocumentSession): ExportImagesModel => observe(new ExportImagesModel(raw(app), raw(s))),
  profiles: (): ProfilesModel => observe(new ProfilesModel(raw(app))),
  /** Settings ▸ Smart Fill. On desktop a new AI host is approved in a native dialog first. */
  aiSettings: (): AiSettingsModel => {
    const http = raw(services).platform.http as unknown as { allowOrigin?(u: string): Promise<boolean> };
    return observe(new AiSettingsModel(raw(app), http.allowOrigin ? (u) => http.allowOrigin!(u) : undefined));
  },
};
function observe<T extends { changed: Emitter<void> }>(model: T): T {
  watch(model.changed);
  return live(model);
}

export async function start(): Promise<void> {
  try {
    const platform = await createPlatform(VERSION);
    setLocale('en'); // English only in Release 1; dates and numbers still follow the platform locale
    const engine = createWorkerEngine();
    // Recognition reads language data through the services (bundled or downloaded and verified).
    let languageData: (code: string) => Promise<Uint8Array> = loadBundledLanguage;
    const ocr = createBrowserOcr(platform.images, (code) => languageData(code));
    const rawServices = new Services({ platform, engine, ocr, loadOcrLanguage: loadBundledLanguage, loadFont: (name: HandwritingFont) => loadHandwritingFont(name) });
    languageData = (code) => rawServices.ocrLanguages.data(code);
    const rawApp = new AppModel(rawServices, prompts, { every: (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    } });
    // Periodic recovery snapshots wait for a pause in scrolling, typing and pointer input.
    for (const type of ['scroll', 'wheel', 'keydown', 'pointerdown'] as const)
      window.addEventListener(type, () => rawApp.noteActivity(), { capture: true, passive: true });
    const rawSign = new SignModel(rawApp);
    watch(rawApp.changed);
    watch(raw(ui).changed);
    watch(rawSign.changed);
    rawApp.changed.on(() => {
      // Forget the view-models of closed tabs.
      for (const id of perSession.keys()) if (!rawApp.sessions.some((s) => s.id === id)) perSession.delete(id);
    });
    services = bridge(rawServices);
    app = live(rawApp);
    sign = live(rawSign);
    await app.start();
    await sign.load();
    ui.sidebarOpen = app.settings.sidebar.open && window.innerWidth >= 820;
    ui.inspectorOpen = app.settings.inspector.open && window.innerWidth >= 1100;
    // Narrow windows: panels that would cover the page close when the window shrinks past their breakpoint.
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      // Smart Fill lives in the inspector: keep it open while a run is in progress instead of hiding its dialog.
      const active = rawApp.active;
      const smartBusy = !!active && (perSession.get(active.id)?.smart.stage ?? 'idle') !== 'idle';
      // Through the model's methods: they notify, a plain assignment would leave the screen stale.
      if (lastWidth >= 1100 && w < 1100 && !smartBusy && ui.inspectorOpen) ui.toggleInspector();
      if (lastWidth >= 820 && w < 820 && ui.sidebarOpen) ui.toggleSidebar();
      lastWidth = w;
    });
    registerPerfShortcut();
    if (perfRequested()) {
      installPerfPanel();
      installPerf({
        open: async (url) => {
          const files = rawServices.platform.files as unknown as { adoptBytes?(name: string, bytes: Uint8Array): FileRef };
          const res = await fetch(url);
          if (!res.ok || !files.adoptBytes) throw new Error(`perf: cannot open ${url}`);
          await rawApp.openRef(files.adoptBytes(url.split('/').pop() ?? 'perf.pdf', new Uint8Array(await res.arrayBuffer())));
        },
      });
    }
    ui.startCoach(app.settings.onboardingDone);
    state.ready = true;
    bump();
    // After `ready`: the prompt needs the shell's dialogs, and waiting for it earlier would never end.
    void app.offerRecovery().catch((e) => console.error(e));
    if (desktop) {
      // Read by the AppImage smoke test over WebDriver (SPEC §16.8).
      const report = (): void => {
        (window as { __folioSmoke?: unknown }).__folioSmoke = { ready: true, opened: rawApp.sessions.map((s) => s.name), pages: rawApp.active?.pageCount };
      };
      rawApp.changed.on(report);
      report();
    }
  } catch (e) {
    state.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (desktop) (window as { __folioSmoke?: unknown }).__folioSmoke = { ready: false, error: state.error };
    console.error(e);
  }
}
