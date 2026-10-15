import {
  Emitter,
  InvalidArgumentError,
  endpointHost,
  isLoopbackUrl,
  formatPageRanges,
  isFolioError,
  isValidPageRanges,
  msg,
  parsePageRanges,
  splitExt,
  type Msg,
} from '@folio/core';
import type { StoredSignature } from '@folio/db';
import type { Color, FieldValue, FileRef, FormField, ImageFormat, OutlineNode, PageIndex, Point } from '@folio/ports';
import {
  BUILTIN_STAMPS,
  COMPRESS_PRESETS,
  normalizeSettings,
  type CompressAnalysis,
  type CompressPreset,
  type CompressResult,
  type CompressSettings,
  DEFAULT_IMAGE_PAGE,
  DEFAULT_MERGE,
  DEFAULT_TEMPLATE,
  HANDWRITING_FONTS,
  INK_COLORS,
  currentValue,
  cutsForEveryN,
  formatFieldValue,
  isFillable,
  isImageName,
  nextStop,
  planFiles,
  planSplit,
  selectParity,
  selectRange,
  sortSources,
  tabOrder,
  toggle,
  type AnalysisResult,
  type MoveIntent,
  type OutlinePath,
  type ConflictPolicy,
  type HandwritingFont,
  type ImagePageOptions,
  type MergeItemInfo,
  type MergeOptions,
  type MergeSource,
  type PlannedFile,
  type Preflight,
  type SignatureDraft,
  type SignatureKind,
  type SmartProfile,
  type SplitMode,
  type StampDef,
  type Suggestion,
  type TextStampStyle,
} from '@folio/services';
import { aiGates } from './ai-settings.ts';
import type { AppModel } from './app.ts';
import type { DocumentSession } from './session.ts';
import type { ToolController } from './tools.ts';

abstract class ViewModel {
  readonly changed = new Emitter<void>();
  protected emit(): void {
    this.changed.emit();
  }
}

// ---- Organise (FR-ORG-01…10) -------------------------------------------------------------------

export class OrganiseModel extends ViewModel {
  /** Thumbnail size slider, in pixels of width (FR-ORG-01). */
  thumbSize = 158;
  /** Insertion marker while dragging: the page index the block would be inserted before. */
  dropBefore: number | null = null;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }
  get selected(): PageIndex[] {
    return this.session.selection.kind === 'pages' ? this.session.selection.pages : [];
  }
  private setSelection(pages: PageIndex[], anchor?: PageIndex): void {
    const prevAnchor =
      this.session.selection.kind === 'pages' ? this.session.selection.anchor : (pages[0] ?? 0);
    this.session.select(
      pages.length
        ? { kind: 'pages', pages: [...new Set(pages)].sort((a, b) => a - b), anchor: anchor ?? prevAnchor }
        : { kind: 'none' },
    );
    this.emit();
  }
  setThumbSize(px: number): void {
    this.thumbSize = Math.min(320, Math.max(90, Math.round(px)));
    this.emit();
  }

  /** Click, Ctrl/Cmd+click, Shift+click (FR-ORG-02). */
  click(page: PageIndex, mods: { shift?: boolean; mod?: boolean } = {}): void {
    const sel = this.session.selection;
    if (mods.shift && sel.kind === 'pages') this.setSelection(selectRange(sel.anchor, page), sel.anchor);
    else if (mods.mod) this.setSelection(toggle(this.selected, page), page);
    else this.setSelection([page], page);
  }
  /** Rubber-band: every page whose card intersects the band. */
  selectBand(pages: PageIndex[]): void {
    this.setSelection(pages, pages[0]);
  }
  selectAll(): void {
    this.setSelection(
      Array.from({ length: this.session.pageCount }, (_, i) => i),
      0,
    );
  }
  selectOdd(): void {
    this.setSelection(selectParity(this.session.pageCount, 'odd'));
  }
  selectEven(): void {
    this.setSelection(selectParity(this.session.pageCount, 'even'));
  }
  selectNone(): void {
    this.setSelection([]);
  }

  private get pages() {
    return this.app.services.pages;
  }
  /** Pages to act on: the selection, or the given page (hover mini action bar). */
  private target(page?: PageIndex): PageIndex[] {
    return page !== undefined && !this.selected.includes(page) ? [page] : this.selected;
  }

  dragOver(before: number | null): void {
    if (this.dropBefore === before) return;
    this.dropBefore = before;
    this.emit();
  }
  /** Drop: move the dragged pages before `before`. The moved pages stay selected. */
  async drop(dragged: PageIndex, before: number): Promise<void> {
    const pages = this.target(dragged);
    this.dropBefore = null;
    // A contiguous block dropped on or right after itself keeps the order: nothing to do (and nothing to undo).
    const sorted = [...pages].sort((a, b) => a - b);
    const contiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1]! + 1);
    if (contiguous && before >= sorted[0]! && before <= sorted[sorted.length - 1]! + 1) return this.emit();
    const moved = await this.app.guard(() =>
      this.session.run(this.pages.reorder(this.session.doc, pages, before)),
    );
    if (moved) this.setSelection(moved, moved[0]);
    else this.emit();
  }
  /** Alt+Arrow keyboard reorder. */
  async nudge(direction: -1 | 1): Promise<void> {
    if (this.selected.length === 0) return;
    const cmd = this.pages.nudge(this.session.doc, this.selected, direction);
    if (!cmd) return;
    const moved = await this.app.guard(() => this.session.run(cmd));
    if (moved) this.setSelection(moved, moved[0]);
  }
  async rotate(deg: 90 | 180 | 270, page?: PageIndex): Promise<void> {
    const pages = this.target(page);
    if (pages.length === 0) return;
    const keep = this.selected;
    await this.app.guard(() => this.session.run(this.pages.rotate(this.session.doc, pages, deg)));
    this.setSelection(keep);
  }
  async delete(page?: PageIndex): Promise<void> {
    const pages = this.target(page);
    if (pages.length === 0) return;
    const keep = this.selected;
    const ok = await this.app.guard(async () => {
      await this.session.run(this.pages.delete(this.session.doc, pages));
      return true;
    });
    if (ok) {
      // Deleted pages leave the selection and the others follow their pages, so pressing Delete again
      // does not remove whatever moved into the old positions.
      const gone = new Set(pages);
      const left = keep.filter((p) => !gone.has(p)).map((p) => p - pages.filter((d) => d < p).length);
      if (left.length) this.setSelection(left, left[0]);
      else this.selectNone();
      this.app.toastUndo(msg('toast.pagesDeleted', { count: pages.length }));
    }
  }
  async duplicate(page?: PageIndex): Promise<void> {
    const pages = this.target(page);
    if (pages.length === 0) return;
    const copies = await this.app.guard(() =>
      this.session.run(this.pages.duplicate(this.session.doc, pages)),
    );
    if (copies) this.setSelection(copies, copies[0]);
  }
  /** Insert a blank page before or after the selection (or at the end when nothing is selected). */
  async insertBlank(
    where: 'before' | 'after',
    size: Parameters<AppModel['services']['pages']['blankSize']>[2] = { kind: 'neighbour' },
  ): Promise<void> {
    const sel = this.selected;
    const at =
      sel.length === 0 ? this.session.pageCount : where === 'before' ? sel[0]! : sel[sel.length - 1]! + 1;
    const resolved = await this.pages.blankSize(this.session.doc, where === 'before' ? at + 1 : at, size);
    const added = await this.app.guard(() =>
      this.session.run(this.pages.insertBlank(this.session.doc, at, resolved)),
    );
    if (added !== undefined) this.setSelection([added], added);
  }
  /** Insert pages from another file (dialog) at the given position; `range` uses "1-3,7" syntax. */
  async insertFromFile(at: number, range = ''): Promise<void> {
    const [ref] = await this.app.services.platform.files.pickOpen({ multiple: false, accept: ['pdf'] });
    if (!ref) return;
    await this.insertFromRef(ref, at, range);
  }
  async insertFromRef(ref: FileRef, at: number, range = ''): Promise<void> {
    await this.app.guard(async () => {
      const opened = await this.app.services.documents.open(ref);
      try {
        const pages = parsePageRanges(range, opened.doc.pageCount);
        const added = await this.session.run(this.pages.insertFrom(this.session.doc, opened.doc, pages, at));
        this.setSelection(added, added[0]);
      } finally {
        opened.doc.dispose();
      }
    });
  }
  /** Drag pages from another open tab (split view). */
  async insertFromSession(source: DocumentSession, pages: PageIndex[], at: number): Promise<void> {
    const added = await this.app.guard(() =>
      this.session.run(this.pages.insertFrom(this.session.doc, source.doc, pages, at)),
    );
    if (added) this.setSelection(added, added[0]);
  }
  /** Extract the selection to a new tab; optionally remove it from this document (FR-ORG-09). */
  async extract(removeFromSource = false): Promise<DocumentSession | null> {
    const pages = this.selected;
    if (pages.length === 0) return null;
    const created = await this.app.guard(async () => {
      const doc = await this.pages.extract(this.session.doc, pages);
      if (removeFromSource) await this.session.run(this.pages.delete(this.session.doc, pages));
      return this.app.adopt(doc, `${splitExt(this.session.name)[0]} (pages ${formatPageRanges(pages)}).pdf`);
    });
    return created ?? null;
  }
  /** Replace the selected pages with pages from another file (FR-ORG-10). */
  async replaceFromFile(range = ''): Promise<void> {
    const target = this.selected;
    if (target.length === 0) return;
    const [ref] = await this.app.services.platform.files.pickOpen({ multiple: false, accept: ['pdf'] });
    if (!ref) return;
    await this.app.guard(async () => {
      const opened = await this.app.services.documents.open(ref);
      try {
        const added = await this.session.run(
          this.pages.replace(
            this.session.doc,
            target,
            opened.doc,
            parsePageRanges(range, opened.doc.pageCount),
          ),
        );
        this.setSelection(added, added[0]);
      } finally {
        opened.doc.dispose();
      }
    });
  }
}

// ---- Merge wizard (FR-MRG-01…03, epic E1) ------------------------------------------------------

export interface MergeItem extends MergeSource {
  id: string;
  info: MergeItemInfo;
}
export class MergeWizard extends ViewModel {
  items: MergeItem[] = [];
  options: MergeOptions = { ...DEFAULT_MERGE };
  busy = false;
  progress = 0;
  private abort?: AbortController;

  constructor(private readonly app: AppModel) {
    super();
  }
  get totalPages(): number {
    return this.items.reduce((n, i) => n + (i.info.problem ? 0 : i.info.pageCount), 0);
  }
  get usable(): MergeItem[] {
    return this.items.filter((i) => !i.info.problem);
  }
  get canMerge(): boolean {
    return (
      !this.busy &&
      !this.items.some((i) => i.info.problem === 'badRange') &&
      this.usable.length >= 1 &&
      this.totalPages > 0 &&
      (this.usable.length >= 2 || this.totalPages > 0)
    );
  }

  /** Starts with the open tabs' saved files when called from an editor. */
  async addFiles(refs?: FileRef[]): Promise<void> {
    const picked =
      refs ?? (await this.app.services.platform.files.pickOpen({ multiple: true, accept: ['pdf', 'image'] }));
    for (const ref of picked) {
      const bytes = await this.app.guard(() => this.app.services.platform.files.read(ref));
      if (!bytes) continue;
      await this.addSource({ name: ref.name, bytes });
    }
  }
  /** Adds every open tab with its current content, so unsaved edits and unsaved tabs are merged too. */
  async addOpenDocuments(): Promise<void> {
    for (const s of this.app.sessions) {
      const bytes = await this.app.guard(() => s.doc.save());
      if (bytes) await this.addSource({ name: s.name, bytes });
    }
  }
  async addSource(source: MergeSource): Promise<void> {
    const info = await this.app.services.merge.inspect(source);
    this.items = [...this.items, { ...source, id: this.app.services.newId(), info }];
    this.emit();
  }
  private async refresh(id: string, patch: Partial<MergeSource>): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    const next = { ...item, ...patch };
    next.info = await this.app.services.merge.inspect(next);
    this.items = this.items.map((i) => (i.id === id ? next : i));
    this.emit();
  }
  /** Per-file page range ("1-3,7,10-"). Invalid ranges show a warning chip and exclude the file. */
  setRange(id: string, range: string): Promise<void> {
    return this.refresh(id, { range });
  }
  /** "Enter password" on an encrypted item. */
  setPassword(id: string, password: string): Promise<void> {
    return this.refresh(id, { password });
  }
  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }
  /** Drag to reorder. */
  move(id: string, toIndex: number): void {
    const from = this.items.findIndex((i) => i.id === id);
    if (from < 0) return;
    const next = [...this.items];
    const [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, item!);
    this.items = next;
    this.emit();
  }
  sort(by: 'name' | 'date'): void {
    this.items = sortSources(this.items, by);
    this.emit();
  }
  setOptions(patch: Partial<MergeOptions>): void {
    this.options = { ...this.options, ...patch };
    this.emit();
  }
  cancel(): void {
    this.abort?.abort();
  }

  private async build(): Promise<DocumentSession | null> {
    if (!this.canMerge) return null;
    this.busy = true;
    this.progress = 0;
    this.abort = new AbortController();
    this.emit();
    try {
      const doc = await this.app.services.merge.merge(
        this.usable,
        this.options,
        this.abort.signal,
        (done, total) => {
          this.progress = done / total;
          this.emit();
        },
      );
      const first = splitExt(this.usable[0]!.name)[0];
      return await this.app.adopt(doc, `${first} (merged).pdf`);
    } catch (e) {
      this.app.reportError(e);
      return null;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  /** Primary button: "Merge & open" — a new unsaved tab. */
  mergeAndOpen(): Promise<DocumentSession | null> {
    return this.build();
  }
  /** Secondary button: "Merge & save as…". */
  async mergeAndSave(): Promise<boolean> {
    const session = await this.build();
    return session ? this.app.saveAs(session) : false;
  }
}

// ---- Split wizard (FR-MRG-04…06, epic E7) ------------------------------------------------------

export class SplitWizard extends ViewModel {
  mode: SplitMode['kind'] = 'everyN';
  ranges: string[] = [''];
  everyN = 10;
  cuts: PageIndex[] = [];
  template = DEFAULT_TEMPLATE;
  policy: ConflictPolicy = 'autoNumber';
  folder: FileRef | null = null;
  plan: PlannedFile[] = [];
  /** Why there is no plan (invalid range, bad template…). */
  problem: Msg | null = null;
  busy = false;
  progress = 0;
  private abort?: AbortController;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }
  /** Output defaults to the source file's folder (SPEC §7.4). */
  async init(): Promise<void> {
    if (this.session.ref) this.folder = await this.app.services.platform.files.parentOf(this.session.ref);
    await this.recompute();
  }
  private splitMode(): SplitMode {
    switch (this.mode) {
      case 'ranges':
        return { kind: 'ranges', ranges: this.ranges };
      case 'everyN':
        return { kind: 'everyN', n: this.everyN };
      case 'single':
        return { kind: 'single' };
      case 'cuts':
        return { kind: 'cuts', after: this.cuts };
    }
  }
  /** Live preview of the resulting files (FR-MRG-06). */
  async recompute(): Promise<void> {
    try {
      const parts = planSplit(this.session.pageCount, this.splitMode());
      const folder = this.folder;
      this.plan = await planFiles(parts, {
        template: this.template,
        sourceName: this.session.name,
        policy: this.policy,
        exists: async (name) => (folder ? this.app.services.platform.files.exists(folder, name) : false),
      });
      this.problem = null;
    } catch (e) {
      this.plan = [];
      this.problem = isFolioError(e)
        ? msg(`split.problem.${e.params.reason ?? 'range'}`, e.params)
        : msg('error.unexpected');
    }
    this.emit();
  }
  async setMode(mode: SplitMode['kind']): Promise<void> {
    // Switching to the thumbnail strip keeps the cuts equivalent to the current every-N value.
    if (mode === 'cuts' && this.mode === 'everyN')
      this.cuts = cutsForEveryN(this.session.pageCount, this.everyN);
    this.mode = mode;
    await this.recompute();
  }
  async setEveryN(n: number): Promise<void> {
    this.everyN = n;
    await this.recompute();
  }
  async setRange(index: number, value: string): Promise<void> {
    this.ranges = this.ranges.map((r, i) => (i === index ? value : r));
    await this.recompute();
  }
  rangeValid(index: number): boolean {
    const r = this.ranges[index] ?? '';
    return r.trim() === '' || isValidPageRanges(r, this.session.pageCount);
  }
  async addRange(): Promise<void> {
    this.ranges = [...this.ranges, ''];
    await this.recompute();
  }
  async removeRange(index: number): Promise<void> {
    this.ranges = this.ranges.filter((_, i) => i !== index);
    if (this.ranges.length === 0) this.ranges = [''];
    await this.recompute();
  }
  /** Scissors between pages in the thumbnail strip. */
  async toggleCut(after: PageIndex): Promise<void> {
    this.mode = 'cuts';
    this.cuts = toggle(this.cuts, after);
    await this.recompute();
  }
  async setTemplate(template: string): Promise<void> {
    this.template = template;
    await this.recompute();
  }
  async setPolicy(policy: ConflictPolicy): Promise<void> {
    this.policy = policy;
    await this.recompute();
  }
  async pickFolder(): Promise<void> {
    const folder = await this.app.services.platform.files.pickFolder();
    if (folder) {
      this.folder = folder;
      await this.recompute();
    }
  }
  get canRun(): boolean {
    return !this.busy && this.plan.length > 0 && this.folder !== null;
  }
  cancel(): void {
    this.abort?.abort();
  }
  /** Writes the files. With policy "ask", each conflicting file is confirmed. */
  async run(): Promise<{ written: string[]; skipped: string[] } | null> {
    if (!this.canRun) return null;
    const folder = this.folder!;
    this.busy = true;
    this.progress = 0;
    this.abort = new AbortController();
    this.emit();
    try {
      const files = this.app.services.platform.files;
      const result = await this.app.services.split.execute(
        this.session.doc,
        this.plan,
        async (name, bytes) => void (await files.writeInFolder(folder, name, bytes)),
        {
          signal: this.abort.signal,
          overwrite: (name) =>
            this.policy === 'overwrite'
              ? true
              : this.app.prompts.confirm(msg('split.confirmOverwrite', { name }), { danger: true, confirmLabel: msg('split.overwrite') }),
          onProgress: (done, total) => {
            this.progress = done / total;
            this.emit();
          },
        },
      );
      this.app.toast('success', msg('toast.splitDone', { count: result.written.length }));
      return result;
    } catch (e) {
      this.app.reportError(e);
      return null;
    } finally {
      this.busy = false;
      await this.recompute();
    }
  }
}

// ---- Images to PDF (FR-OPT-03, epic E6) --------------------------------------------------------

export class ImagesWizard extends ViewModel {
  items: Array<{ id: string; name: string; bytes: Uint8Array }> = [];
  options: ImagePageOptions = { ...DEFAULT_IMAGE_PAGE };
  busy = false;
  progress = 0;
  private abort?: AbortController;
  constructor(private readonly app: AppModel) {
    super();
  }
  cancel(): void {
    this.abort?.abort();
  }
  async addFiles(refs?: FileRef[]): Promise<void> {
    const picked =
      refs ?? (await this.app.services.platform.files.pickOpen({ multiple: true, accept: ['image'] }));
    for (const ref of picked) {
      if (!isImageName(ref.name)) {
        this.app.toast('warning', msg('images.notAnImage', { name: ref.name }));
        continue;
      }
      const bytes = await this.app.guard(() => this.app.services.platform.files.read(ref));
      if (!bytes) continue;
      const readable = await this.app.services.platform.images.decode(bytes).then(
        () => true,
        () => false,
      );
      if (!readable) {
        this.app.toast('warning', msg('images.notAnImage', { name: ref.name }));
        continue;
      }
      this.items = [...this.items, { id: this.app.services.newId(), name: ref.name, bytes }];
    }
    this.emit();
  }
  move(id: string, toIndex: number): void {
    const from = this.items.findIndex((i) => i.id === id);
    if (from < 0) return;
    const next = [...this.items];
    const [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, item!);
    this.items = next;
    this.emit();
  }
  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }
  setOptions(patch: Partial<ImagePageOptions>): void {
    this.options = { ...this.options, ...patch };
    this.emit();
  }
  /** Creates the PDF as a new unsaved tab. */
  async create(): Promise<DocumentSession | null> {
    if (this.items.length === 0 || this.busy) return null;
    this.busy = true;
    this.progress = 0;
    this.abort = new AbortController();
    this.emit();
    try {
      const doc = await this.app.services.imagesToPdf.create(
        this.items,
        this.options,
        this.abort.signal,
        (done, total) => {
          this.progress = done / total;
          this.emit();
        },
      );
      return await this.app.adopt(doc, `${splitExt(this.items[0]!.name)[0]}.pdf`);
    } catch (e) {
      this.app.reportError(e);
      return null;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
}

// ---- Export pages as images (FR-OPT-02) --------------------------------------------------------

export class ExportImagesModel extends ViewModel {
  format: ImageFormat = 'png';
  dpi = 150;
  quality = 0.9;
  range = '';
  asZip = false;
  busy = false;
  progress = 0;
  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }
  get formats(): ImageFormat[] {
    return (['png', 'jpeg', 'webp'] as ImageFormat[]).filter((f) =>
      this.app.services.platform.images.supports(f),
    );
  }
  get rangeValid(): boolean {
    return isValidPageRanges(this.range, this.session.pageCount);
  }
  set(patch: Partial<Pick<ExportImagesModel, 'format' | 'dpi' | 'quality' | 'range' | 'asZip'>>): void {
    Object.assign(this, patch);
    this.emit();
  }
  /** Writes one image per page into a chosen folder, or a single ZIP file. */
  async run(): Promise<number> {
    if (!this.rangeValid || this.busy) return 0;
    const files = this.app.services.platform.files;
    const pages = parsePageRanges(this.range, this.session.pageCount);
    const stem = splitExt(this.session.name)[0];
    const target = this.asZip
      ? await files.pickSave({ suggestedName: `${stem}.zip`, kind: 'zip' })
      : await files.pickFolder();
    if (!target) return 0;
    this.busy = true;
    this.emit();
    try {
      const images = await this.app.services.exporter.exportPages(
        this.session.doc,
        pages,
        { format: this.format, dpi: this.dpi, quality: this.format === 'png' ? undefined : this.quality },
        this.session.name,
        undefined,
        (done, total) => {
          this.progress = done / total;
          this.emit();
        },
      );
      if (this.asZip) await files.write(target, this.app.services.exporter.zip(images), { atomic: true });
      else for (const img of images) await files.writeInFolder(target, img.name, img.bytes);
      this.app.toast('success', msg('toast.exportedImages', { count: images.length }));
      return images.length;
    } catch (e) {
      this.app.reportError(e);
      return 0;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
}

// ---- Sign and stamps (FR-STM-01…03, 05…09, 12; epic E2) ----------------------------------------

export class SignModel extends ViewModel {
  signatures: StoredSignature[] = [];
  customStamps: StampDef[] = [];
  /** The creation dialog is open (first use opens it automatically, FR-STM-09). */
  creating: SignatureKind | null = null;
  /** One-time note that this is not a certificate-based signature (FR-STM-12). */
  showNote = false;

  constructor(private readonly app: AppModel) {
    super();
  }
  readonly fonts = HANDWRITING_FONTS;
  readonly inkColors = INK_COLORS;
  readonly builtinStamps = BUILTIN_STAMPS;

  async load(): Promise<void> {
    this.signatures = await this.app.services.signaturesRepo.list();
    const stored = await this.app.services.stampsRepo.list();
    this.customStamps = [];
    for (const s of stored) {
      if (s.kind === 'text')
        this.customStamps.push(
          this.app.services.stamps.customText(s.id, s.name, s.payload as unknown as TextStampStyle),
        );
      else if (s.png)
        this.customStamps.push(
          this.app.services.stamps.customImage(
            s.id,
            s.name,
            await this.app.services.platform.images.decode(s.png),
            s.kind === 'selection' ? 'selection' : 'image',
          ),
        );
    }
    this.emit();
  }
  of(kind: SignatureKind): StoredSignature[] {
    return this.signatures.filter((s) => s.kind === kind);
  }

  /** The Sign button / G shortcut: place the default signature, or open the creation dialog first. */
  async sign(tools: ToolController, kind: SignatureKind = 'signature'): Promise<'placing' | 'creating'> {
    await this.load();
    const def = this.of(kind).find((s) => s.isDefault) ?? this.of(kind)[0];
    if (!def) {
      this.creating = kind;
      this.emit();
      return 'creating';
    }
    await this.place(tools, def);
    return 'placing';
  }
  openCreate(kind: SignatureKind): void {
    this.creating = kind;
    this.emit();
  }
  closeCreate(): void {
    this.creating = null;
    this.emit();
  }

  /** Drafts for the three tabs of the creation dialog. */
  draftFromStrokes(strokes: Point[][], color: Color): SignatureDraft {
    return this.app.services.signatures.fromStrokes(strokes, this.creating ?? 'signature', color);
  }
  draftFromText(text: string, font: HandwritingFont, color: Color): Promise<SignatureDraft> {
    return this.app.services.signatures.fromText(text, font, this.creating ?? 'signature', color);
  }
  draftFromImage(
    bytes: Uint8Array,
    threshold: number,
    crop?: { x: number; y: number; width: number; height: number },
  ): Promise<SignatureDraft> {
    return this.app.services.signatures.fromImage(bytes, this.creating ?? 'signature', { threshold, crop });
  }

  /** Saves a draft to the library; with `tools`, goes straight to placing it (zero-friction first use). */
  async save(draft: SignatureDraft, name: string, tools?: ToolController): Promise<StoredSignature | null> {
    const stored = await this.app.guard(async () => {
      const png = await this.app.services.platform.images.encode(draft.raster, 'png');
      return this.app.services.signaturesRepo.add(
        {
          name,
          kind: draft.kind,
          source: draft.source,
          svg: draft.svg,
          png,
          width: draft.width,
          height: draft.height,
        },
        { encrypt: this.app.settings.encryptSignatures },
      );
    });
    if (!stored) return null;
    this.creating = null;
    await this.load();
    if (tools) await this.place(tools, stored);
    return stored;
  }
  async rename(id: string, name: string): Promise<void> {
    await this.app.guard(() => this.app.services.signaturesRepo.rename(id, name));
    await this.load();
  }
  async setDefault(id: string): Promise<void> {
    await this.app.services.signaturesRepo.setDefault(id);
    await this.load();
  }
  async remove(id: string): Promise<void> {
    await this.app.services.signaturesRepo.remove(id);
    await this.load();
  }

  /** Ghost follows the pointer; click drops it (FR-STM-03). Shows the one-time note on first use. */
  async place(tools: ToolController, sig: StoredSignature): Promise<void> {
    const raster = await this.app.services.platform.images.decode(sig.png);
    const data = { kind: sig.kind, svg: sig.svg, raster, width: sig.width, height: sig.height };
    tools.beginPlacement({
      kind: 'signature',
      size: { width: sig.width, height: sig.height },
      preview: sig.png,
      make: (rect) => ({
        annotation: this.app.services.stamps.signatureAnnotation(
          this.app.services.signatures,
          data,
          { x: 0, y: 0 },
          { width: 0, height: 0 },
          rect,
        ),
      }),
    });
    if (!this.app.settings.signatureNoteShown) {
      this.showNote = true;
      await this.app.setSetting('signatureNoteShown', true);
    }
    this.emit();
  }
  dismissNote(): void {
    this.showNote = false;
    this.emit();
  }

  /** Stamp ▾ menu: built-in, custom or date stamp. */
  placeStamp(tools: ToolController, def: StampDef): void {
    const stamps = this.app.services.stamps;
    const sample = stamps.annotation(def, { x: 0, y: 0 }, { width: 100000, height: 100000 });
    tools.beginPlacement({
      kind: 'stamp',
      size: { width: sample.rect.width, height: sample.rect.height },
      make: (rect) => ({ annotation: stamps.annotation(def, { x: 0, y: 0 }, { width: 0, height: 0 }, rect) }),
    });
  }
  /** Insert date (Ctrl+Shift+D): today's date in the format from settings. */
  placeDate(tools: ToolController): void {
    this.placeStamp(tools, this.app.services.stamps.dateStamp(this.app.settings.dateFormat));
  }

  async addTextStamp(name: string, style: TextStampStyle): Promise<void> {
    await this.app.guard(() =>
      this.app.services.stampsRepo.add({ name, kind: 'text', payload: { ...style } }),
    );
    await this.load();
  }
  async addImageStamp(name: string, bytes: Uint8Array, kind: 'image' | 'selection' = 'image'): Promise<void> {
    await this.app.guard(async () => {
      const decoded = await this.app.services.platform.images.decode(bytes);
      const png = await this.app.services.platform.images.encode(decoded, 'png');
      return this.app.services.stampsRepo.add({ name, kind, payload: {}, png });
    });
    await this.load();
  }
  /** "Save selection as stamp": a snapshot of a page area becomes a reusable stamp. */
  async addSelectionStamp(
    session: DocumentSession,
    page: PageIndex,
    area: { x: number; y: number; width: number; height: number },
    name: string,
  ): Promise<void> {
    const png = await this.app.guard(() =>
      this.app.services.exporter.snapshotPng(session.doc, page, area, 216),
    );
    if (png) await this.addImageStamp(name, png, 'selection');
  }
  async renameStamp(id: string, name: string): Promise<void> {
    await this.app.guard(() => this.app.services.stampsRepo.rename(id, name));
    await this.load();
  }
  async removeStamp(id: string): Promise<void> {
    await this.app.services.stampsRepo.remove(id);
    await this.load();
  }
  async reorderStamps(ids: string[]): Promise<void> {
    await this.app.services.stampsRepo.reorder(ids);
    await this.load();
  }
}

// ---- Reduce file size (FR-OPT-01) --------------------------------------------------------------

export type CompressStage = 'idle' | 'analysing' | 'ready' | 'running' | 'done';
export class CompressModel extends ViewModel {
  stage: CompressStage = 'idle';
  preset: CompressPreset = 'balanced';
  custom: CompressSettings = { ...COMPRESS_PRESETS.balanced };
  /** Estimated size per preset, once measured. */
  estimates: Partial<Record<CompressPreset, number>> = {};
  /** 'copy' writes `name-compressed.pdf`; 'replace' overwrites the open file (never for signed files). */
  target: 'copy' | 'replace' = 'copy';
  result: CompressResult | null = null;
  progress = 0;
  analysis: CompressAnalysis | null = null;
  private abort?: AbortController;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }
  get size(): number {
    return this.session.byteSize ?? 0;
  }
  get signed(): boolean {
    return this.session.meta.hasSignatures;
  }
  get encrypted(): boolean {
    return this.session.meta.isEncrypted;
  }
  get canReplace(): boolean {
    return !this.signed && !!this.session.ref;
  }
  get settings(): CompressSettings {
    return this.preset === 'custom' ? normalizeSettings(this.custom) : COMPRESS_PRESETS[this.preset];
  }
  /** Measures the document and the estimated size of every preset. */
  async start(): Promise<void> {
    this.stage = 'analysing';
    this.result = null;
    this.estimates = {};
    this.target = this.canReplace ? this.target : 'copy';
    this.abort = new AbortController();
    this.emit();
    const ok = await this.app.guard(async () => {
      await this.session.settled();
      const bytes = this.size || (await this.session.doc.save()).length;
      this.analysis = await this.app.services.compress.analyze(this.session.doc, bytes, this.abort!.signal);
      for (const p of ['light', 'balanced', 'strong'] as const) {
        this.estimates[p] = await this.app.services.compress.estimate(this.session.doc, this.analysis, COMPRESS_PRESETS[p], this.abort!.signal);
        this.emit();
      }
      return true;
    });
    this.stage = ok ? 'ready' : 'idle';
    this.emit();
  }
  async setPreset(preset: CompressPreset): Promise<void> {
    this.preset = preset;
    this.emit();
    if (preset === 'custom') await this.estimateCustom();
  }
  async setCustom(patch: Partial<CompressSettings>): Promise<void> {
    this.custom = { ...this.custom, ...patch };
    this.preset = 'custom';
    this.emit();
    await this.estimateCustom();
  }
  private async estimateCustom(): Promise<void> {
    if (!this.analysis) return;
    const size = await this.app.guard(() => this.app.services.compress.estimate(this.session.doc, this.analysis!, this.custom, this.abort?.signal));
    if (size !== undefined) this.estimates.custom = size;
    this.emit();
  }
  setTarget(target: 'copy' | 'replace'): void {
    this.target = target === 'replace' && !this.canReplace ? 'copy' : target;
    this.emit();
  }
  cancel(): void {
    this.abort?.abort();
  }

  /**
   * Compresses a copy; nothing is written when the result is not smaller. Returns the written file name,
   * or null (cancelled, no gain, failure).
   */
  async run(): Promise<string | null> {
    const files = this.app.services.platform.files;
    const svc = this.app.services.compress;
    this.stage = 'running';
    this.progress = 0;
    this.abort = new AbortController();
    this.emit();
    const res = await this.app.guard(async () => {
      await this.session.settled();
      return svc.run(this.session.doc, this.settings, {
        originalBytes: this.size || (await this.session.doc.save()).length,
        signal: this.abort!.signal,
        progress: (done, total) => {
          this.progress = total ? done / total : 1;
          this.emit();
        },
      });
    });
    this.stage = res ? 'done' : 'ready';
    this.result = res ?? null;
    this.emit();
    if (!res) return null;
    if (!res.bytes) {
      this.app.toast('info', msg('compress.noGain'));
      return null;
    }
    const replace = this.target === 'replace' && this.canReplace;
    let ref: FileRef | null | undefined;
    if (replace) ref = this.session.ref!;
    else ref = await files.pickSave({ suggestedName: svc.copyName(this.session.name), kind: 'pdf' });
    if (!ref) return null;
    const written = await this.app.guard(async () => {
      await files.write(ref!, res.bytes!, { atomic: true, backup: replace ? this.app.settings.keepBackup : false });
      return true;
    });
    if (!written) return null;
    this.app.toast('success', msg('compress.done', { name: ref.name, before: res.before, after: res.after, percent: Math.round(res.saved * 100) }));
    if (replace) {
      // The file now holds the compressed document: reopen it so the tab shows what is on disk.
      this.session.markSaved(ref, res.after);
      const tab = this.session;
      await this.app.closeTab(tab.id);
      await this.app.openRef(ref);
    }
    return ref.name;
  }
}

// ---- Bookmarks (FR-EDT-11, FR-EDT-27) ----------------------------------------------------------

export class OutlineModel extends ViewModel {
  tree: OutlineNode[] = [];
  editing = false;
  /** Path of the selected entry, or null. */
  selected: OutlinePath | null = null;
  /** Entry being renamed in place. */
  renaming: OutlinePath | null = null;
  collapsed = new Set<string>();

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
    session.invalidated.on((inv) => {
      if (['outline', 'structure', 'all'].includes(inv.kind)) void this.load();
    });
  }
  private get service() {
    return this.app.services.outline;
  }
  async load(): Promise<void> {
    this.tree = await this.session.nav.outline();
    if (this.selected && !this.service.node(this.tree, this.selected)) this.selected = null;
    this.emit();
  }
  /** Entries whose page was deleted, keyed by joined path (shown as "Target removed"). */
  get removed(): Set<string> {
    return new Set(this.service.issues(this.tree).map((i) => i.path.join('.')));
  }
  get signed(): boolean {
    return this.session.meta.hasSignatures;
  }
  setEditing(on: boolean): void {
    this.editing = on;
    this.renaming = null;
    this.emit();
  }
  select(path: OutlinePath | null): void {
    this.selected = path;
    this.emit();
  }
  toggleCollapsed(path: OutlinePath): void {
    const key = path.join('.');
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.collapsed = new Set(this.collapsed);
    this.emit();
  }
  startRename(path = this.selected): void {
    if (!path || !this.service.node(this.tree, path)) return;
    this.renaming = path;
    this.emit();
  }

  /** The signed-document warning applies to every edit; false when the user backs out. */
  private async allowed(): Promise<boolean> {
    if (!this.signed) return true;
    return this.app.prompts.confirm(msg('bookmarks.confirmSigned'), { confirmLabel: msg('action.continue') });
  }
  private async run(cmd: () => ReturnType<typeof this.service.add>, after?: () => void): Promise<boolean> {
    if (!(await this.allowed())) return false;
    const ok = await this.app.guard(async () => {
      await this.session.run(cmd());
      await this.load();
      return true;
    });
    if (ok) after?.();
    this.emit();
    return !!ok;
  }

  /** Adds an entry at the current page: after the selection (sibling) or as its first child. */
  async add(title: string, asChild = false): Promise<boolean> {
    const sel = this.selected;
    const parent = sel ? (asChild ? sel : sel.slice(0, -1)) : [];
    const siblings = parent.length ? this.service.node(this.tree, parent)!.children.length : this.tree.length;
    const index = sel && !asChild ? sel[sel.length - 1]! + 1 : siblings;
    const target = this.service.viewTarget(this.session.view.page);
    return this.run(
      () => this.service.add(parent, index, title, target),
      () => (this.selected = [...parent, index]),
    );
  }
  async rename(path: OutlinePath, title: string): Promise<boolean> {
    const ok = await this.run(() => this.service.rename(path, title));
    if (ok) this.renaming = null;
    this.emit();
    return ok;
  }
  /** Del: asks first when the entry has children. */
  async remove(path = this.selected): Promise<boolean> {
    if (!path) return false;
    const size = this.service.subtreeSize(this.tree, path);
    if (size === 0) return false;
    if (size > 1 && !(await this.app.prompts.confirm(msg('bookmarks.confirmDelete', { count: size }), { danger: true, confirmLabel: msg('action.delete') })))
      return false;
    return this.run(
      () => this.service.remove(path),
      () => (this.selected = null),
    );
  }
  async move(intent: MoveIntent, path = this.selected): Promise<boolean> {
    if (!path) return false;
    const to = this.service.planMove(this.tree, path, intent);
    if (!to) return false;
    return this.run(
      () => this.service.move(path, to),
      () => (this.selected = this.service.pathAfterMove(path, to)),
    );
  }
  /** Drag and drop: `before` is the entry the dragged one is dropped on, null for the end of the list. */
  async drop(from: OutlinePath, before: OutlinePath | null): Promise<boolean> {
    const to = this.service.dropPosition(from, before, this.tree);
    if (!to) return false;
    return this.run(
      () => this.service.move(from, to),
      () => (this.selected = this.service.pathAfterMove(from, to)),
    );
  }
  /** "Set target to current view", also the fix for a removed target. */
  async setTargetHere(path = this.selected): Promise<boolean> {
    if (!path) return false;
    return this.run(() => this.service.setTarget(path, this.service.viewTarget(this.session.view.page)));
  }
}

// ---- Forms (FR-FRM-01…03, 05, 09; epic E4) -----------------------------------------------------

export class FormModel extends ViewModel {
  fields: FormField[] = [];
  /** Index into `stops` of the focused widget, -1 when none. */
  focus = -1;
  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
    session.invalidated.on((inv) => {
      if (inv.kind === 'form' || inv.kind === 'all' || inv.kind === 'structure') void this.load();
    });
  }
  async load(): Promise<void> {
    this.fields = await this.session.fields();
    this.emit();
  }
  get stops(): ReturnType<typeof tabOrder> {
    return tabOrder(this.fields);
  }
  get fillableCount(): number {
    return this.fields.filter(isFillable).length;
  }
  /** Banner text parts: "This form has 14 fields" or the XFA notice (FR-FRM-09). */
  get banner(): { kind: 'form' | 'xfa' | 'none'; count: number } {
    if (this.session.meta.hasXfa && this.fillableCount === 0) return { kind: 'xfa', count: 0 };
    if (this.fillableCount > 0)
      return { kind: this.session.meta.hasXfa ? 'xfa' : 'form', count: this.fillableCount };
    return { kind: 'none', count: 0 };
  }
  get highlight(): boolean {
    return this.app.settings.highlightFields;
  }
  toggleHighlight(): Promise<void> {
    return this.app.setSetting('highlightFields', !this.highlight);
  }
  /** Tab / Shift+Tab: the next widget in reading order; the first Tab focuses the first field. */
  tab(direction: 1 | -1): { field: FormField; widget: number } | null {
    this.focus = nextStop(this.stops.length, this.focus, direction);
    this.emit();
    const stop = this.stops[this.focus];
    if (stop) this.session.goToPage(stop.field.widgets[stop.widget]!.page);
    return stop ?? null;
  }
  focusField(id: string, widget = 0): void {
    this.focus = this.stops.findIndex((s) => s.field.id === id && s.widget === widget);
    this.emit();
  }
  display(field: FormField): string {
    return formatFieldValue(field, this.app.services.platform.app.locale);
  }
  value(field: FormField): FieldValue {
    return currentValue(field);
  }
  /** Commit a value typed into the overlaid input (Enter, blur, or click on a choice). */
  async set(field: FormField, value: FieldValue): Promise<void> {
    await this.app.guard(() => this.session.run(this.app.services.forms.fill(field, value)));
  }
  async clear(field: FormField): Promise<void> {
    await this.app.guard(() => this.session.run(this.app.services.forms.clear(field)));
  }
  async reset(): Promise<void> {
    const cmd = this.app.services.forms.reset(this.fields);
    if (cmd && (await this.app.prompts.confirm(msg('form.confirmReset'), { danger: true, confirmLabel: msg('form.reset') })))
      await this.app.guard(() => this.session.run(cmd));
  }
  async flatten(): Promise<void> {
    if (await this.app.prompts.confirm(msg('form.confirmFlatten'), { danger: true, confirmLabel: msg('cmd.flatten.form') }))
      await this.app.guard(() => this.session.run(this.app.services.forms.flatten()));
  }
  async exportJson(): Promise<boolean> {
    const files = this.app.services.platform.files;
    const ref = await files.pickSave({
      suggestedName: `${splitExt(this.session.name)[0]}.form.json`,
      kind: 'json',
    });
    if (!ref) return false;
    await files.write(
      ref,
      new TextEncoder().encode(JSON.stringify(this.app.services.forms.exportData(this.fields), null, 2)),
      { atomic: true },
    );
    return true;
  }
  async importJson(): Promise<string[] | null> {
    const files = this.app.services.platform.files;
    const [ref] = await files.pickOpen({ accept: ['json'] });
    if (!ref) return null;
    const res = await this.app.guard(async () => {
      const data: unknown = JSON.parse(new TextDecoder().decode(await files.read(ref)));
      const { command, skipped } = this.app.services.forms.importData(this.fields, data);
      if (command) await this.session.run(command);
      return skipped;
    });
    if (res?.length) this.app.toast('warning', msg('form.importSkipped', { count: res.length }));
    return res ?? null;
  }
  /** Autocomplete suggestions from the active profile for a text field being typed in. */
  async suggestions(field: FormField, typed: string): Promise<string[]> {
    if (field.type !== 'text') return [];
    const profile = await this.app.services.profiles.getDefault();
    if (!profile) return [];
    const needle = typed.trim().toLowerCase();
    const mapped = this.app.services.smartFill.heuristic(
      [
        {
          ref: field.id,
          page: 0,
          rect: field.widgets[0]!.rect,
          kind: 'acroform',
          fieldType: 'text',
          name: field.name,
          label: field.label,
        },
      ],
      profile,
    )[0];
    const values = profile.fields
      .filter((f) => f.value && !f.sensitive)
      .map((f) => ({ key: f.key, value: f.value }));
    const ranked = values
      .filter((v) => needle === '' || v.value.toLowerCase().startsWith(needle))
      .sort((a, b) => Number(b.key === mapped?.profileKey) - Number(a.key === mapped?.profileKey));
    return [...new Set(ranked.map((v) => v.value))].slice(0, 5);
  }
}

// ---- Smart Fill (FR-AIF-03…10, epic E5) --------------------------------------------------------

export type SmartFillStage = 'idle' | 'preflight' | 'analysing' | 'review' | 'empty';
export class SmartFillModel extends ViewModel {
  stage: SmartFillStage = 'idle';
  profile: SmartProfile | null = null;
  profiles: SmartProfile[] = [];
  scope: 'current' | 'all' = 'current';
  preflight: Preflight | null = null;
  result: AnalysisResult | null = null;
  suggestions: Suggestion[] = [];
  /** Suggestion whose box is highlighted on the page ("Locate"). */
  located: string | null = null;
  private abort?: AbortController;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }
  /**
   * The AI path is offered only when it is switched on, configured (FR-AIF-02) and the model can
   * return JSON (FR-AIF-13).
   */
  async aiAvailable(): Promise<boolean> {
    return this.app.settings.ai.enabled && aiGates(this.app.settings.ai).json && (await this.app.services.ai.isConfigured());
  }
  /** Page images are sent only to a model that can see them (FR-AIF-13). */
  private get includeImage(): boolean {
    return this.app.settings.ai.includeImage && aiGates(this.app.settings.ai).vision;
  }
  private pages(): PageIndex[] {
    return this.scope === 'all'
      ? Array.from({ length: this.session.pageCount }, (_, i) => i)
      : [this.session.view.page];
  }
  async loadProfiles(): Promise<void> {
    this.profiles = await this.app.services.profiles.list();
    this.profile =
      this.profiles.find((p) => p.id === this.profile?.id) ??
      this.profiles.find((p) => (p as { isDefault?: boolean }).isDefault) ??
      this.profiles[0] ??
      null;
    this.emit();
  }
  setProfile(id: string): void {
    this.profile = this.profiles.find((p) => p.id === id) ?? this.profile;
    this.emit();
  }
  setScope(scope: 'current' | 'all'): void {
    this.scope = scope;
    this.emit();
  }

  /** "Auto-fill with my data": shows the pre-flight dialog when the mode has not been acknowledged. */
  async start(): Promise<void> {
    await this.loadProfiles();
    if (!this.profile) {
      this.app.toast('info', msg('smartfill.needProfile'));
      return;
    }
    const ai = await this.aiAvailable();
    const settings = this.app.settings.ai;
    if (ai && !settings.preflightAcknowledged.includes(settings.mode)) {
      const sf = this.app.services.smartFill;
      const pages = this.pages();
      const { candidates, layers } = await sf.collect(this.session.doc, pages);
      const sizes = new Map(
        pages.map((p) => [p, this.session.pageInfos[p]?.size ?? { width: 612, height: 792 }] as const),
      );
      const req = sf.buildRequest(
        candidates,
        layers,
        sizes,
        this.profile,
        settings.mode,
        settings.maxPagesPerRun,
      );
      this.preflight = {
        ...sf.preflight(req, this.profile),
        includesImage: this.includeImage,
        destination: { host: endpointHost(settings.baseUrl), local: isLoopbackUrl(settings.baseUrl) },
      };
      this.stage = 'preflight';
      this.emit();
      return;
    }
    await this.analyse(false);
  }
  /** Pre-flight "Send" (optionally "Don't ask again for this mode"). */
  async confirmPreflight(dontAskAgain: boolean): Promise<void> {
    const settings = this.app.settings.ai;
    if (dontAskAgain)
      await this.app.setSetting('ai', {
        ...settings,
        preflightAcknowledged: [...new Set([...settings.preflightAcknowledged, settings.mode])],
      });
    await this.analyse(false);
  }
  cancel(): void {
    this.abort?.abort();
    this.stage = 'idle';
    this.preflight = null;
    this.suggestions = [];
    this.result = null;
    this.located = null;
    this.emit();
  }
  async analyse(reanalyze: boolean): Promise<void> {
    if (!this.profile) return;
    this.stage = 'analysing';
    this.preflight = null;
    this.abort = new AbortController();
    this.emit();
    const settings = this.app.settings.ai;
    const result = await this.app.guard(async () =>
      this.app.services.smartFill.analyze(this.session.doc, this.pages(), this.profile!, {
        useAi: await this.aiAvailable(),
        mode: settings.mode,
        includeImage: this.includeImage,
        maxPages: settings.maxPagesPerRun,
        reanalyze,
        signal: this.abort!.signal,
      }),
    );
    if (!result) {
      this.stage = 'idle';
      return this.emit();
    }
    this.result = result;
    this.suggestions = result.suggestions;
    this.stage = result.suggestions.length ? 'review' : 'empty';
    if (result.fallbackReason && result.fallbackReason !== 'notConfigured')
      this.app.toast('warning', msg(`smartfill.fallback.${result.fallbackReason}`));
    this.emit();
  }
  /** Review panel edits. */
  toggle(ref: string, accepted: boolean): void {
    this.patch(ref, { accepted });
  }
  setValue(ref: string, value: string): void {
    this.patch(ref, { value });
  }
  setKey(ref: string, profileKey: string | null): void {
    this.patch(ref, { profileKey });
  }
  private patch(ref: string, change: Parameters<AppModel['services']['smartFill']['edit']>[1]): void {
    if (!this.profile) return;
    this.suggestions = this.suggestions.map((s) =>
      s.ref === ref ? this.app.services.smartFill.edit(s, change, this.profile!) : s,
    );
    this.emit();
  }
  locate(ref: string | null): void {
    this.located = ref;
    const s = this.suggestions.find((x) => x.ref === ref);
    if (s) this.session.goToPage(s.page);
    this.emit();
  }
  get acceptedCount(): number {
    return this.suggestions.filter((s) => s.accepted && s.value !== '').length;
  }
  /** FR-AIF-10: create a profile entry for an unmatched field and map the field to it. */
  async addToProfile(ref: string, key: string, labelText: string, value: string): Promise<void> {
    if (!this.profile) return;
    await this.app.guard(() =>
      this.app.services.profiles.setField(this.profile!.id, { key, label: labelText, type: 'text', value }),
    );
    await this.loadProfiles();
    const created = this.profile?.fields.find((f) => f.label === labelText);
    if (created) this.setKey(ref, created.key);
  }
  /** "Apply selected" / "Apply all high-confidence": one undo step, and the mapping is remembered. */
  async apply(onlyHigh = false): Promise<number> {
    if (!this.result || !this.profile) return 0;
    const list = onlyHigh ? this.app.services.smartFill.acceptHigh(this.suggestions) : this.suggestions;
    const sizes = new Map(this.session.pageInfos.map((p, i) => [i, p.size] as const));
    const cmd = this.app.services.smartFill.apply(list, sizes);
    if (!cmd) return 0;
    const count = list.filter((s) => s.accepted && s.value !== '').length;
    const ok = await this.app.guard(async () => {
      await this.session.run(cmd);
      await this.app.services.smartFill.remember(this.result!, list, this.profile!);
      return true;
    });
    if (!ok) return 0;
    this.app.toastUndo(msg('toast.smartFillApplied', { count }));
    this.cancel();
    return count;
  }
}

export { InvalidArgumentError };
