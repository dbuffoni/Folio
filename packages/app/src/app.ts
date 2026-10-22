import {
  Emitter,
  FolioError,
  isFolioError,
  msg,
  splitExt,
  type Msg,
  type Settings,
  type SettingsKey,
} from '@folio/core';
import type { RecentFile } from '@folio/db';
import type { FileRef, HiddenDataOptions, HiddenDataReport, PageIndex, PdfDocument } from '@folio/ports';
import { RecoveryScheduler, defaultOcrLanguages, isImageName, type Ticker } from '@folio/services';
import type { Prompts, Toast, ToastKind } from './prompts.ts';
import type { Services } from './services.ts';
import { DocumentSession, type SignatureImpact } from './session.ts';

export type Tile = 'merge' | 'split' | 'organise' | 'fill' | 'sign' | 'images';
/** Task tiles of the home screen, in order (FR-APP-03). */
export const HOME_TILES: Tile[] = ['merge', 'split', 'organise', 'fill', 'sign', 'images'];

export interface RecentCard extends RecentFile {
  /** The file no longer exists at its path (dimmed, "File not found"). */
  missing: boolean;
  folder: string;
}

/** Message key for an error, plus the technical detail for the "Details" disclosure (SPEC §7.5, §8.12). */
export function describeError(e: unknown): { message: Msg; detail: string } {
  if (isFolioError(e)) {
    const sub = e.params.reason ?? e.params.kind ?? e.params.feature;
    return {
      message: msg(`error.${e.code}${sub ? `.${sub}` : ''}`, e.params),
      detail: `${e.name}: ${e.message}${e.detail ? ` — ${e.detail}` : ''}`,
    };
  }
  return {
    message: msg('error.unexpected'),
    detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  };
}

/**
 * The application without a UI (SPEC §16.1.6): tabs, opening and saving, close guards, recent files,
 * recovery, toasts. Screens bind to this and to the per-document `DocumentSession`.
 */
/** Background snapshots wait until the user has been idle this long. */
const ACTIVITY_PAUSE_MS = 1500;

export class AppModel {
  readonly changed = new Emitter<void>();
  sessions: DocumentSession[] = [];
  /** Null = the home screen is showing. */
  activeId: string | null = null;
  toasts: Toast[] = [];
  /** A tile or flow asked for a tool to be started once a document is open. */
  pendingIntent: Tile | null = null;
  private toastSeq = 0;
  private lastActivity = 0;
  private scheduler: RecoveryScheduler;
  private offExternal?: () => void;
  private offClose?: () => void;

  constructor(
    readonly services: Services,
    readonly prompts: Prompts,
    ticker: Ticker,
  ) {
    this.scheduler = new RecoveryScheduler(
      services.recovery,
      ticker,
      () =>
        this.sessions.map((s) => ({
          doc: s.doc,
          dirty: s.dirty,
          state: {
            sessionId: s.id,
            name: s.name,
            path: s.ref?.path,
            revision: s.history.revision,
            view: { page: s.view.page, zoom: s.view.zoom },
          },
        })),
      (e) => services.platform.log.warn('recovery snapshot failed', describeError(e).detail),
      () => Date.now() - this.lastActivity < ACTIVITY_PAUSE_MS,
    );
  }

  /** The shell calls this on scrolling, typing and pointer input so background work can wait for a pause. */
  noteActivity(): void {
    this.lastActivity = Date.now();
  }

  get active(): DocumentSession | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }
  get settings(): Settings {
    return this.services.settings;
  }
  private emit(): void {
    this.changed.emit();
  }

  /** Start-up: settings, external-open and close hooks, recovery timer. Leftover snapshots: `offerRecovery`. */
  async start(): Promise<void> {
    await this.services.init();
    const { files, window } = this.services.platform;
    this.offExternal = files.onExternalOpen((refs) => void this.openRefs(refs));
    this.offClose = window.onCloseRequested(() => this.confirmQuit());
    this.scheduler.start(this.settings.recoveryIntervalSec);
    this.emit();
  }
  async stop(): Promise<void> {
    this.scheduler.stop();
    this.offExternal?.();
    this.offClose?.();
    for (const s of this.sessions) await s.dispose();
    this.sessions = [];
    this.activeId = null;
  }

  // ---- toasts --------------------------------------------------------------------------------

  toast(
    kind: ToastKind,
    message: Msg,
    extra: Partial<Pick<Toast, 'action' | 'detail' | 'progress' | 'cancel'>> = {},
  ): number {
    // The same notice twice in a row (a batch of bad files, a repeated click) is shown once.
    const same = JSON.stringify([kind, message]);
    const dup = this.toasts.find(
      (t) => !t.action && !t.cancel && t.progress === undefined && JSON.stringify([t.kind, t.message]) === same,
    );
    if (dup && !extra.action && !extra.cancel && extra.progress === undefined) return dup.id;
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, kind, message, ...extra }];
    this.emit();
    return id;
  }
  updateToast(id: number, patch: Partial<Toast>): void {
    this.toasts = this.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.emit();
  }
  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }
  /** "Dismiss all": everything except work in progress. */
  dismissAllToasts(): void {
    this.toasts = this.toasts.filter((t) => t.progress !== undefined);
    this.emit();
  }
  /** Shows what happened, why, and what to do — never raw exception text (SPEC §7.5). */
  reportError(e: unknown): void {
    if (isFolioError(e) && e.code === 'cancelled') return;
    const { message, detail } = describeError(e);
    this.services.platform.log.error(message.key, detail);
    this.toast('error', message, { detail });
  }
  /** Success toast with Undo for the active document (e.g. "3 pages deleted — Undo"). */
  toastUndo(message: Msg): void {
    const session = this.active;
    this.toast(
      'success',
      message,
      session ? { action: { label: msg('action.undo'), run: () => void session.undo() } } : {},
    );
  }
  /** Runs a task, turning failures into error toasts. Returns undefined when it failed. */
  async guard<T>(task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await task();
    } catch (e) {
      this.reportError(e);
      return undefined;
    }
  }

  // ---- tabs (FR-APP-02) ----------------------------------------------------------------------

  activate(id: string | null): void {
    if (id !== null && !this.sessions.some((s) => s.id === id)) return;
    this.activeId = id;
    this.syncWindow();
    this.emit();
  }
  showHome(): void {
    this.activate(null);
  }
  /** Drag a tab to a new position. */
  moveTab(id: string, toIndex: number): void {
    const from = this.sessions.findIndex((s) => s.id === id);
    if (from < 0) return;
    const next = [...this.sessions];
    const [tab] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, tab!);
    this.sessions = next;
    this.emit();
  }
  cycleTab(direction: 1 | -1): void {
    if (this.sessions.length === 0) return;
    const at = this.sessions.findIndex((s) => s.id === this.activeId);
    this.activate(this.sessions[(at + direction + this.sessions.length) % this.sessions.length]!.id);
  }
  private syncWindow(): void {
    const s = this.active;
    this.services.platform.window.setTitle(s ? `${s.name} — Folio` : 'Folio');
    this.services.platform.window.setDirty(this.sessions.some((x) => x.dirty));
  }

  private async addSession(init: ConstructorParameters<typeof DocumentSession>[0]): Promise<DocumentSession> {
    const session = new DocumentSession(init, this.services);
    session.beforeSignedChange = (impact) => this.confirmSignedChange(session, impact);
    await session.refreshPages();
    session.changed.on(() => {
      this.syncWindow();
      this.emit();
    });
    this.sessions = [...this.sessions, session];
    this.activeId = session.id;
    this.syncWindow();
    this.emit();
    return session;
  }

  /**
   * OCR languages for reading scanned pages on this device: the ones the user chose in the OCR dialog, else the
   * interface language, kept to those installed (English and Italian ship with the app).
   */
  async scanLanguages(): Promise<string[]> {
    const installed = new Set((await this.services.ocrLanguages.list()).filter((p) => p.installed).map((p) => p.code));
    const wanted = defaultOcrLanguages(this.settings.language, this.settings.ocr.languages).filter((c) => installed.has(c));
    return wanted.length ? wanted : installed.has('eng') ? ['eng'] : [];
  }

  // ---- signed documents (FR-SEC-13) ----------------------------------------------------------

  private signedQuestion = new Map<string, Promise<boolean>>();
  /**
   * The gate of the command bus for a signed document. Filling in form fields keeps the signatures valid
   * when the file is saved with "Append changes": one note per session, no question. Any other change
   * asks once per session whether to go on, and the answer holds until the file is closed.
   */
  private confirmSignedChange(session: DocumentSession, impact: SignatureImpact): Promise<boolean> {
    if (impact === 'keeps') {
      if (!session.signedHintShown) {
        session.signedHintShown = true;
        this.toast('info', msg('signed.keepsHint'));
      }
      return Promise.resolve(true);
    }
    if (session.signedEditAccepted) return Promise.resolve(true);
    let pending = this.signedQuestion.get(session.id);
    if (!pending) {
      pending = this.prompts
        .confirm(msg('signed.editConfirm', { name: session.name }), { danger: true, confirmLabel: msg('signed.editAnyway') })
        .then((ok) => {
          if (ok) session.signedEditAccepted = true;
          return ok;
        })
        .finally(() => this.signedQuestion.delete(session.id));
      this.signedQuestion.set(session.id, pending);
    }
    return pending;
  }
  /**
   * Deletes every signature of the open document (one undo step; the next save rewrites the file) so it can be
   * edited and saved freely. Asks first: the signatures cannot be recovered once the file is saved.
   */
  async removeSignatures(session = this.active): Promise<boolean> {
    if (!session?.meta.hasSignatures) return false;
    if (!(await this.prompts.confirm(msg('signed.removeConfirm', { name: session.name }), { danger: true, confirmLabel: msg('signed.removeAction') }))) return false;
    await session.settled();
    session.signedEditAccepted = true;
    const ok = await this.guard(async () => {
      await session.run(this.services.documents.removeSignatures());
      session.fullRewrite = true;
      return true;
    });
    if (ok) this.toast('success', msg('signed.removed'));
    return !!ok;
  }

  /** Adds an in-memory document (merge result, extracted pages, images) as a new unsaved tab. */
  async adopt(doc: PdfDocument, name: string): Promise<DocumentSession> {
    return this.addSession({
      id: this.services.newId(),
      doc,
      name,
      fingerprint: `mem-${this.services.newId()}`,
      meta: await doc.getMeta(),
      startsDirty: true,
    });
  }

  // ---- open (FR-APP-01, FR-APP-12, FR-APP-13) ------------------------------------------------

  /** File ▸ Open: native picker, then open every chosen file. */
  async openDialog(): Promise<DocumentSession[]> {
    const refs = await this.services.platform.files.pickOpen({ multiple: true, accept: ['pdf'] });
    return this.openRefs(refs);
  }

  /** Dialog results, drops, CLI arguments and "Open with" all end here. Images open as a new PDF. */
  async openRefs(refs: FileRef[]): Promise<DocumentSession[]> {
    const opened: DocumentSession[] = [];
    const images = refs.filter((r) => isImageName(r.name));
    for (const ref of refs.filter((r) => !isImageName(r.name))) {
      const s = await this.openRef(ref);
      if (s) opened.push(s);
    }
    if (images.length) {
      const s = await this.guard(async () => {
        const inputs = [];
        for (const r of images)
          inputs.push({ name: r.name, bytes: await this.services.platform.files.read(r) });
        return this.adopt(
          await this.services.imagesToPdf.create(inputs),
          `${splitExt(images[0]!.name)[0]}.pdf`,
        );
      });
      if (s) opened.push(s);
    }
    return opened;
  }

  /** Opens one file; an already open file is just activated. Asks for the password as often as needed. */
  async openRef(ref: FileRef): Promise<DocumentSession | null> {
    const already = this.sessions.find((s) => (ref.path ? s.ref?.path === ref.path : s.ref?.id === ref.id));
    if (already) {
      this.activate(already.id);
      return already;
    }
    let password: string | undefined;
    for (;;) {
      try {
        const opened = await this.services.documents.open(ref, { password });
        const recent = await this.services.recents.touch({
          displayName: ref.name,
          path: ref.path ?? null,
          fingerprint: opened.fingerprint,
          pageCount: opened.doc.pageCount,
        });
        const session = await this.addSession({
          id: this.services.newId(),
          doc: opened.doc,
          name: ref.name,
          ref,
          fingerprint: opened.fingerprint,
          byteSize: opened.byteSize,
          meta: opened.meta,
          recentId: recent.id,
        });
        // Back to where the user was (FR-VIEW-08).
        if (recent.lastPage > 0) session.goToPage(recent.lastPage);
        if (recent.lastZoom) session.setZoom('custom', recent.lastZoom);
        void this.saveThumbnail(session);
        if (opened.meta.wasRepaired) this.toast('warning', msg('banner.repaired', { name: ref.name }));
        return session;
      } catch (e) {
        if (isFolioError(e) && (e.code === 'passwordRequired' || e.code === 'wrongPassword')) {
          const answer = await this.prompts.askPassword(ref.name, e.code === 'wrongPassword');
          if (answer === null) return null;
          password = answer;
          continue;
        }
        this.reportError(e);
        return null;
      }
    }
  }

  private async saveThumbnail(session: DocumentSession): Promise<void> {
    if (!session.recentId || session.pageCount === 0) return;
    try {
      const img = await session.renderer.thumbnail(0, 160);
      const png = await this.services.platform.images.encode(img, 'png');
      await this.services.recents.touch({
        displayName: session.name,
        path: session.ref?.path ?? null,
        fingerprint: session.fingerprint,
        pageCount: session.pageCount,
        thumbnail: png,
      });
      this.emit();
    } catch {
      // A missing cover image is not worth a message.
    }
  }

  // ---- save (FR-APP-04, FR-APP-11) -----------------------------------------------------------

  /** Ctrl+S. Unsaved-new documents go through Save As. Returns false when cancelled or failed. */
  async save(session = this.active): Promise<boolean> {
    if (!session) return false;
    await session.settled();
    if (!session.ref) return this.saveAs(session);
    let incremental = false;
    if (session.meta.hasSignatures && !session.fullRewrite) {
      const choice = await this.prompts.confirmSignedSave(session.name);
      if (choice === 'cancel') return false;
      incremental = choice === 'incremental';
    }
    return this.write(session, session.ref, { incremental, backup: this.settings.keepBackup });
  }
  /**
   * FR-SEC-07: reopens a restricted file with its owner password, which lifts the restrictions for the session.
   * The restrictions come back the next time the file is opened normally.
   */
  async unlockRestrictions(session = this.active): Promise<boolean> {
    if (!session?.ref || !session.meta.permissions) return false;
    if (session.dirty) {
      this.toast('warning', msg('perm.saveFirst'));
      return false;
    }
    let wrong = false;
    for (;;) {
      const password = await this.prompts.askPassword(session.name, wrong);
      if (password === null || password === '') return false;
      let opened;
      try {
        opened = await this.services.documents.open(session.ref, { password });
      } catch (e) {
        if (isFolioError(e) && e.code === 'wrongPassword') {
          wrong = true;
          continue;
        }
        this.reportError(e);
        return false;
      }
      if (!opened.meta.ownerUnlocked) {
        opened.doc.dispose();
        this.toast('warning', msg('perm.notOwner'));
        wrong = true;
        continue;
      }
      const old = session;
      await this.addSession({
        id: this.services.newId(),
        doc: opened.doc,
        name: old.name,
        ref: old.ref,
        fingerprint: opened.fingerprint,
        byteSize: opened.byteSize,
        meta: opened.meta,
        recentId: old.recentId,
      });
      await this.closeTab(old.id);
      this.toast('success', msg('perm.liftedToast'));
      return true;
    }
  }

  /**
   * FR-SEC-12. Removes the selected hidden data in place (one undo step) and returns what was verified as gone.
   * The next save rewrites the whole file. Signed files lose their signatures: the caller warns first.
   */
  async removeHiddenData(session: DocumentSession, opts: HiddenDataOptions): Promise<HiddenDataReport | undefined> {
    await session.settled();
    const report = await this.guard(() => session.run(this.services.documents.removeHiddenData(opts)));
    if (report) session.fullRewrite = true;
    return report ?? undefined;
  }
  /** FR-SEC-12 for signed files: writes a cleaned copy and leaves the open document and its signatures alone. */
  async saveCleanedCopy(session: DocumentSession, opts: HiddenDataOptions): Promise<HiddenDataReport | undefined> {
    await session.settled();
    const [stem] = splitExt(session.name);
    const ref = await this.services.platform.files.pickSave({ suggestedName: `${stem} (clean).pdf`, kind: 'pdf' });
    if (!ref) return undefined;
    const res = await this.guard(async () => {
      const copy = await this.services.engine.open(await session.doc.save());
      try {
        const report = await copy.removeHiddenData(opts);
        await this.services.documents.save(copy, ref, { incremental: false, backup: false });
        return report;
      } finally {
        copy.dispose();
      }
    });
    if (res) this.toast('success', msg('toast.exported', { name: ref.name }));
    return res ?? undefined;
  }
  async saveAs(session = this.active): Promise<boolean> {
    if (!session) return false;
    const ref = await this.services.platform.files.pickSave({ suggestedName: session.name, kind: 'pdf' });
    if (!ref) return false;
    return this.write(session, ref, { incremental: false, backup: false });
  }
  /** Export a copy: the document keeps its own file and its dirty state. */
  async exportCopy(session = this.active): Promise<boolean> {
    if (!session) return false;
    const [stem] = splitExt(session.name);
    const ref = await this.services.platform.files.pickSave({
      suggestedName: `${stem} copy.pdf`,
      kind: 'pdf',
    });
    if (!ref) return false;
    const ok = await this.guard(() => this.services.documents.exportCopy(session.doc, ref));
    if (ok) this.toast('success', msg('toast.exported', { name: ref.name }));
    return !!ok;
  }
  private async write(
    session: DocumentSession,
    ref: FileRef,
    opts: { incremental: boolean; backup: boolean },
  ): Promise<boolean> {
    const res = await this.guard(async () => {
      if (this.settings.flattenStampsOnSave) await session.doc.flattenAnnotations(undefined, ['stamp']);
      return this.services.documents.save(session.doc, ref, opts);
    });
    if (!res) return false;
    session.markSaved(ref, res.byteSize);
    await this.services.recovery.discard(session.id);
    const recent = await this.services.recents.touch({
      displayName: ref.name,
      path: ref.path ?? null,
      fingerprint: session.fingerprint,
      pageCount: session.pageCount,
    });
    session.recentId = recent.id;
    this.toast('success', msg('toast.saved', { name: ref.name }));
    this.syncWindow();
    return true;
  }

  // ---- close guard (FR-APP-07) ---------------------------------------------------------------

  /** Close a tab (button, middle-click, Ctrl+W). Dirty documents ask Save / Don't save / Cancel. */
  async closeTab(id: string): Promise<boolean> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return true;
    await session.settled();
    if (session.dirty) {
      const answer = await this.prompts.confirmClose(session.name);
      if (answer === 'cancel') return false;
      if (answer === 'save' && !(await this.save(session))) return false;
    }
    if (session.recentId)
      await this.services.recents.saveView(
        session.recentId,
        session.view.page,
        session.view.zoomMode === 'custom' ? session.view.zoom : null,
      );
    await this.services.recovery.discard(session.id);
    const at = this.sessions.indexOf(session);
    this.sessions = this.sessions.filter((s) => s !== session);
    if (this.activeId === id) this.activeId = (this.sessions[at] ?? this.sessions[at - 1])?.id ?? null;
    await session.dispose();
    this.syncWindow();
    this.emit();
    return true;
  }
  /** Window close: every dirty tab is asked in turn; the first Cancel keeps the window open. */
  async confirmQuit(): Promise<boolean> {
    for (const s of [...this.sessions]) {
      if (!s.dirty) continue;
      this.activate(s.id);
      if (!(await this.closeTab(s.id))) return false;
    }
    for (const s of [...this.sessions]) await this.closeTab(s.id);
    return true;
  }

  // ---- recovery (FR-APP-06) ------------------------------------------------------------------

  /**
   * Offers the snapshots a previous run left behind. Called by the shell once its dialogs can be shown:
   * `start` must not wait for an answer, because the prompt cannot appear before the shell is ready.
   */
  async offerRecovery(): Promise<void> {
    const pending = await this.services.recovery.pending();
    if (pending.length === 0) return;
    const chosen = new Set(
      await this.prompts.offerRecovery(
        pending.map((p) => ({ sessionId: p.sessionId, name: p.name, savedAt: p.savedAt })),
      ),
    );
    for (const p of pending) {
      if (chosen.has(p.sessionId)) {
        const bytes = await this.services.recovery.load(p.sessionId);
        const opened = bytes ? await this.guard(() => this.services.documents.openBytes(bytes)) : undefined;
        if (opened) {
          // Restored work is unsaved; it keeps pointing at the original file so Save overwrites it knowingly.
          const ref = p.path ? { id: p.path, name: p.name, path: p.path } : undefined;
          const session = await this.addSession({
            id: this.services.newId(),
            doc: opened.doc,
            name: p.name,
            ref,
            fingerprint: opened.fingerprint,
            meta: opened.meta,
            startsDirty: true,
          });
          if (p.view) session.goToPage(p.view.page);
        }
      }
      await this.services.recovery.discard(p.sessionId);
    }
  }
  /** Forces a recovery pass now (also called before risky operations). */
  snapshotNow(): Promise<number> {
    return this.scheduler.tick();
  }

  // ---- home screen (FR-APP-03) ---------------------------------------------------------------

  /** Recent files with missing-file detection; `search` filters by name or folder. */
  async recentFiles(search = '', exists?: (path: string) => Promise<boolean>): Promise<RecentCard[]> {
    const list = await this.services.recents.list(search);
    const out: RecentCard[] = [];
    for (const r of list) {
      const folder = r.path ? r.path.slice(0, Math.max(0, r.path.lastIndexOf('/'))) : '';
      out.push({ ...r, folder, missing: r.path && exists ? !(await exists(r.path)) : false });
    }
    return out;
  }
  async openRecent(card: RecentCard): Promise<DocumentSession | null> {
    if (!card.path || card.missing) {
      this.toast('warning', msg('home.fileNotFound', { name: card.displayName }));
      return null;
    }
    return this.openRef({ id: card.path, name: card.displayName, path: card.path });
  }
  async removeRecent(id: string): Promise<void> {
    await this.services.recents.remove(id);
    this.emit();
  }
  async revealRecent(card: RecentCard): Promise<void> {
    if (card.path)
      await this.services.platform.files.reveal?.({ id: card.path, name: card.displayName, path: card.path });
  }
  /** Time-of-day greeting key. */
  greeting(): string {
    const h = this.services.platform.clock.now().getHours();
    return h < 12 ? 'home.goodMorning' : h < 18 ? 'home.goodAfternoon' : 'home.goodEvening';
  }
  /** Tiles that need an open document ask for one first, then start the matching mode. */
  async startTile(tile: Tile): Promise<'wizard' | 'opened' | 'cancelled'> {
    if (tile === 'merge' || tile === 'images') return 'wizard';
    if (tile === 'split') {
      // Split works on the active document, or asks for one.
      if (!this.active && (await this.openDialog()).length === 0) return 'cancelled';
      return 'wizard';
    }
    if (!this.active && (await this.openDialog()).length === 0) return 'cancelled';
    const session = this.active!;
    session.setMode(tile === 'organise' ? 'organise' : 'fill');
    this.pendingIntent = tile === 'sign' ? 'sign' : null;
    this.emit();
    return 'opened';
  }

  // ---- settings (FR-APP-10) ------------------------------------------------------------------

  async setSetting<K extends SettingsKey>(key: K, value: Settings[K]): Promise<void> {
    this.services.settings = await this.services.settingsRepo.set(key, value);
    if (key === 'recoveryIntervalSec') this.scheduler.start(this.settings.recoveryIntervalSec);
    if (key === 'encryptSignatures')
      await this.services.signaturesRepo.setEncryption(this.settings.encryptSignatures);
    this.emit();
  }
  async resetSettings(): Promise<void> {
    this.services.settings = await this.services.settingsRepo.reset();
    this.scheduler.start(this.settings.recoveryIntervalSec);
    this.emit();
  }

  // ---- print (FR-VIEW-09) --------------------------------------------------------------------

  /** Sends the chosen pages to the OS print dialog. */
  async print(
    opts: { pages?: PageIndex[]; copies?: number; scale?: 'fit' | 'actual' } = {},
    session = this.active,
  ): Promise<boolean> {
    if (!session) return false;
    const pages = opts.pages ?? Array.from({ length: session.pageCount }, (_, i) => i);
    if (pages.length === 0 || pages.some((p) => p < 0 || p >= session.pageCount)) {
      this.reportError(
        new FolioError('invalidArgument', 'Invalid print range', { params: { reason: 'printRange' } }),
      );
      return false;
    }
    const ok = await this.guard(async () => {
      const copies = Math.min(99, Math.max(1, Math.round(opts.copies ?? 1)));
      const whole = pages.length === session.pageCount && pages.every((p, i) => p === i);
      // The print frame cannot set a number of copies, so the chosen pages are repeated in the document.
      const part =
        whole && copies === 1
          ? null
          : await this.services.engine.merge(
              Array.from({ length: copies }, () => ({ doc: session.doc, pages })),
            );
      try {
        const bytes = await (part ?? session.doc).save();
        await this.services.platform.printing.print(bytes, { copies: 1, scale: opts.scale ?? 'fit' });
      } finally {
        part?.dispose();
      }
      return true;
    });
    return !!ok;
  }

  /** FR-VIEW-05: links never open by themselves. */
  async followLink(
    target: Parameters<DocumentSession['nav']['resolve']>[0],
    session = this.active,
  ): Promise<void> {
    if (!session) return;
    const action = session.nav.resolve(target);
    if (action.kind === 'goto') session.goToPage(action.page);
    else if (action.kind === 'confirmExternal') {
      if (await this.prompts.confirmOpenLink(action.host, action.uri))
        await this.services.platform.shell.openExternal(action.uri);
    } else this.toast('info', msg('link.blocked', { reason: action.reason }));
  }
}
