import { Emitter, History, type Command, type HistoryState, type Invalidation } from '@folio/core';
import type { Annotation, AnnotId, DocMeta, FileRef, FormField, ObjId, PageIndex, PageInfo, PdfDocument, Size } from '@folio/ports';
import { NavigationService, RenderService, TextService, type TextRange } from '@folio/services';
import type { Services } from './services.ts';
import { fitZoom, type Layout, type PageTheme, type ViewState, type ZoomMode } from './viewer.ts';

export type Mode = 'view' | 'organise' | 'annotate' | 'fill' | 'edit';
export const MODES: Mode[] = ['view', 'organise', 'annotate', 'fill', 'edit'];
export type SidebarTab = 'thumbnails' | 'outline' | 'annotations' | 'attachments' | 'search';

export type Selection =
  | { kind: 'none' }
  | { kind: 'pages'; pages: PageIndex[]; anchor: PageIndex }
  | { kind: 'annotations'; page: PageIndex; ids: AnnotId[] }
  | { kind: 'object'; page: PageIndex; id: ObjId }
  | { kind: 'text'; range: TextRange };

export interface SessionInit {
  id: string;
  doc: PdfDocument;
  name: string;
  ref?: FileRef;
  fingerprint: string;
  byteSize?: number;
  meta: DocMeta;
  /** Recent-files row, for remembering the last page and zoom. */
  recentId?: string;
  /** Opened from recovery or created in memory: has changes although history is empty. */
  startsDirty?: boolean;
}

/** One open document (one tab): the PDF, its undo history, selection and view state (SPEC §8.6). */
export class DocumentSession {
  readonly id: string;
  readonly doc: PdfDocument;
  readonly history: History;
  readonly text: TextService;
  readonly renderer: RenderService;
  readonly nav: NavigationService;
  /** Fires after any state change the UI may show. */
  readonly changed = new Emitter<void>();
  /** Fires when the current page changes, including while scrolling (which does not fire `changed`). */
  readonly pageChanged = new Emitter<void>();
  /** Fires when page content must be redrawn. */
  readonly invalidated = new Emitter<Invalidation>();

  name: string;
  ref?: FileRef;
  fingerprint: string;
  byteSize?: number;
  meta: DocMeta;
  recentId?: string;
  mode: Mode = 'view';
  selection: Selection = { kind: 'none' };
  view: ViewState;
  sidebarTab: SidebarTab = 'thumbnails';
  pageInfos: PageInfo[] = [];
  /** Bumped on structure changes so lists keyed by page index can refresh. */
  structureVersion = 0;
  private startsDirty: boolean;
  private annotationCache = new Map<PageIndex, Annotation[]>();
  private fieldCache: FormField[] | null = null;
  private off: Array<() => void> = [];

  constructor(init: SessionInit, private readonly services: Services) {
    this.id = init.id;
    this.doc = init.doc;
    this.name = init.name;
    this.ref = init.ref;
    this.fingerprint = init.fingerprint;
    this.byteSize = init.byteSize;
    this.meta = init.meta;
    this.recentId = init.recentId;
    this.startsDirty = !!init.startsDirty;
    this.history = new History({ doc: init.doc, engine: services.engine, sessionId: init.id, storage: services.platform.storage });
    this.text = new TextService(init.doc);
    this.renderer = new RenderService(init.doc);
    this.nav = new NavigationService(init.doc);
    const s = services.settings;
    const mode: ZoomMode = typeof s.defaultZoom === 'number' ? 'custom' : s.defaultZoom;
    this.view = { page: 0, zoomMode: mode, zoom: typeof s.defaultZoom === 'number' ? s.defaultZoom / 100 : 1, layout: s.defaultLayout, rotation: 0, theme: s.pageTheme };
    this.off.push(
      this.history.events.on((e) => {
        if (e.type === 'invalidated') this.onInvalidated(e.invalidation);
        else this.changed.emit();
      }),
    );
  }

  /** Loads page geometry. Call once after construction and it refreshes itself on structure changes. */
  async refreshPages(): Promise<void> {
    const infos: PageInfo[] = [];
    for (let i = 0; i < this.doc.pageCount; i++) infos.push(await this.doc.getPageInfo(i));
    this.pageInfos = infos;
    this.view.page = Math.min(this.view.page, Math.max(0, infos.length - 1));
    this.structureVersion++;
    this.changed.emit();
  }

  private onInvalidated(inv: Invalidation): void {
    const pages = 'pages' in inv ? inv.pages : undefined;
    if (inv.kind === 'structure' || inv.kind === 'all') {
      this.annotationCache.clear();
      this.fieldCache = null;
      this.text.invalidate();
      this.renderer.invalidate();
      this.selection = { kind: 'none' };
      void this.refreshPages();
    } else if (inv.kind === 'pages') {
      this.text.invalidate(pages);
      this.renderer.invalidate(pages);
      for (const p of pages ?? []) this.annotationCache.delete(p);
    } else if (inv.kind === 'annotations') {
      this.renderer.invalidate(pages);
      for (const p of pages ?? []) this.annotationCache.delete(p);
    } else if (inv.kind === 'form') {
      this.fieldCache = null;
      this.renderer.invalidate();
    } else if (inv.kind === 'outline') {
      // The bookmarks panel reloads when this counter changes.
      this.structureVersion++;
    } else if (inv.kind === 'meta') {
      void this.doc.getMeta().then((m) => {
        this.meta = m;
        this.changed.emit();
      });
    }
    this.invalidated.emit(inv);
    this.changed.emit();
  }

  get pageCount(): number {
    return this.doc.pageCount;
  }
  get dirty(): boolean {
    return this.startsDirty || this.history.dirty;
  }
  get historyState(): HistoryState {
    return this.history.state;
  }
  /** Tab title; the unsaved dot is separate (FR-APP-02). */
  get title(): string {
    return this.name;
  }

  /** Runs a command through the history. The only way view-models change the document. */
  async run<R>(command: Command<R>): Promise<R> {
    return this.history.execute(command);
  }
  /** Waits for running commands, so that a save or a close guard sees their result. */
  settled(): Promise<void> {
    return this.history.idle();
  }
  undo(): Promise<boolean> {
    return this.history.undo();
  }
  redo(): Promise<boolean> {
    return this.history.redo();
  }
  markSaved(ref?: FileRef, byteSize?: number): void {
    if (ref) {
      this.ref = ref;
      this.name = ref.name;
    }
    if (byteSize !== undefined) this.byteSize = byteSize;
    this.startsDirty = false;
    this.history.markSaved();
    this.changed.emit();
  }

  async annotations(page: PageIndex): Promise<Annotation[]> {
    let list = this.annotationCache.get(page);
    if (!list) this.annotationCache.set(page, (list = await this.doc.listAnnotations(page)));
    return list;
  }
  async fields(): Promise<FormField[]> {
    return (this.fieldCache ??= await this.doc.listFormFields());
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.selection = { kind: 'none' };
    this.changed.emit();
  }
  select(selection: Selection): void {
    this.selection = selection;
    this.changed.emit();
  }
  setSidebarTab(tab: SidebarTab): void {
    this.sidebarTab = tab;
    this.changed.emit();
  }

  // ---- view state (FR-VIEW-01/06/07/08) ------------------------------------------------------

  goToPage(page: PageIndex): void {
    const next = Math.min(Math.max(0, page), Math.max(0, this.pageCount - 1));
    if (next === this.view.page) return;
    this.view = { ...this.view, page: next };
    this.pageChanged.emit();
    this.changed.emit();
  }
  /**
   * The page now under the viewport, reported by scrolling. Only the page indicator needs to know, so
   * the full `changed` refresh is skipped, except in fit-page where the zoom follows the page.
   */
  reportPage(page: PageIndex): void {
    const next = Math.min(Math.max(0, page), Math.max(0, this.pageCount - 1));
    if (next === this.view.page) return;
    this.view = { ...this.view, page: next };
    this.pageChanged.emit();
    if (this.view.zoomMode === 'fit-page') this.changed.emit();
  }
  /** Recomputes the effective zoom of fit modes for the current page and viewport. */
  fit(viewport: { width: number; height: number }): void {
    const info = this.pageInfos[this.view.page];
    if (!info) return;
    const shownSize = (p: PageInfo): Size => {
      const rot = (p.rotation + this.view.rotation) % 360;
      return rot === 90 || rot === 270 ? { width: p.size.height, height: p.size.width } : p.size;
    };
    // Fit width uses the widest page: every page fits and the zoom does not change while scrolling.
    const shown =
      this.view.zoomMode === 'fit-width'
        ? { ...shownSize(info), width: Math.max(...this.pageInfos.map((p) => shownSize(p).width)) }
        : shownSize(info);
    const zoom = fitZoom(shown, viewport, this.view.zoomMode, this.view.layout, this.view.zoom);
    if (Math.abs(zoom - this.view.zoom) > 0.0005) {
      this.view = { ...this.view, zoom };
      this.changed.emit();
    }
  }
  setZoom(mode: ZoomMode, zoom?: number): void {
    this.view = { ...this.view, zoomMode: mode, zoom: zoom ?? this.view.zoom };
    this.changed.emit();
  }
  setLayout(layout: Layout): void {
    this.view = { ...this.view, layout };
    this.changed.emit();
  }
  setTheme(theme: PageTheme): void {
    this.view = { ...this.view, theme };
    this.changed.emit();
  }
  /** Rotate the view only; the file is untouched until `applyViewRotation`. */
  rotateView(deg: 90 | 270): void {
    this.view = { ...this.view, rotation: (((this.view.rotation + deg) % 360) as ViewState['rotation']) };
    this.changed.emit();
  }
  /** "Apply rotation to file": commits the view rotation to every page as one undo step. */
  async applyViewRotation(): Promise<boolean> {
    const deg = this.view.rotation;
    if (deg === 0) return false;
    await this.run(this.services.pages.rotate(this.doc, Array.from({ length: this.pageCount }, (_, i) => i), deg));
    this.view = { ...this.view, rotation: 0 };
    this.changed.emit();
    return true;
  }

  async dispose(): Promise<void> {
    for (const off of this.off) off();
    await this.history.dispose();
    this.doc.dispose();
  }
}
