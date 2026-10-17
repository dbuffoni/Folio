import {
  DATE_FORMATS,
  Emitter,
  InvalidArgumentError,
  grid,
  endpointHost,
  isLoopbackUrl,
  formatPageRanges,
  isFolioError,
  isValidPageRanges,
  msg,
  parsePageRanges,
  splitExt,
  type DateFormat,
  type Msg,
} from '@folio/core';
import { uniqueKey, validateProfileValue, type FieldDefinition, type FieldTemplate, type Profile, type ProfileFieldType, type StoredSignature } from '@folio/db';
import type { Color, FieldPatch, FieldValue, FileRef, FormField, ImageFormat, OutlineNode, PageIndex, Point, Rect } from '@folio/ports';
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
  MAX_OCR_LANGUAGES,
  defaultOcrLanguages,
  type OcrLanguagePack,
  type OcrRun,
  type FieldProposal,
  type FieldTool,
  FIELD_TOOLS,
  labelNear,
  type DetectionNotice,
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

export abstract class ViewModel {
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
  /** Insert date (Ctrl+Shift+D): today's date in the chosen format, by default the one from settings (FR-STM-05). */
  placeDate(tools: ToolController, format: DateFormat = this.app.settings.dateFormat): void {
    this.placeStamp(tools, this.app.services.stamps.dateStamp(format));
  }
  /** Choices for the Stamp ▾ menu: every format with today's date written in it. */
  dateChoices(): Array<{ format: DateFormat; text: string; isDefault: boolean }> {
    return DATE_FORMATS.map((format) => ({
      format,
      text: this.app.services.stamps.dateText(format),
      isDefault: format === this.app.settings.dateFormat,
    }));
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

// ---- OCR (FR-OCR-01…03, 06, 09) ----------------------------------------------------------------

export type OcrStage = 'idle' | 'ready' | 'running' | 'done';
export class OcrModel extends ViewModel {
  stage: OcrStage = 'idle';
  languages: string[] = ['eng'];
  engine: 'local' | 'ai' = 'local';
  scope: 'current' | 'selected' | 'all' = 'current';
  redo = false;
  progress = 0;
  run: OcrRun | null = null;
  /** Pages the local engine was unsure about. */
  retry: PageIndex[] = [];
  packs: Array<OcrLanguagePack & { installed: boolean }> = [];
  /** A language being downloaded, for the progress line. */
  downloading: { code: string; received: number; total: number } | null = null;
  /** Current page is a scan with no text and no layer of ours: the banner offers "Recognise text". */
  scannedHere = false;
  private abort?: AbortController;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
  }
  private get s() {
    return this.app.services;
  }
  get available(): boolean {
    return this.s.ocr.localAvailable;
  }
  /** "AI (vision)" needs AI switched on, configured, and a model that can read images (FR-AIF-13). */
  async aiAvailable(): Promise<boolean> {
    const ai = this.app.settings.ai;
    return ai.enabled && aiGates(ai).vision && (await this.s.ai.isConfigured());
  }
  async loadPacks(): Promise<void> {
    this.packs = await this.s.ocrLanguages.list();
    this.emit();
  }
  /** Opens the dialog state: remembered languages first, else the UI language. */
  async start(): Promise<void> {
    await this.loadPacks();
    const ocr = this.app.settings.ocr.languages;
    this.languages = defaultOcrLanguages(this.app.settings.language, ocr).filter((c) => this.packs.some((p) => p.code === c));
    if (this.languages.length === 0) this.languages = ['eng'];
    this.stage = 'ready';
    this.run = null;
    this.retry = [];
    this.progress = 0;
    this.emit();
  }
  toggleLanguage(code: string): boolean {
    const at = this.languages.indexOf(code);
    if (at >= 0) {
      if (this.languages.length > 1) this.languages = this.languages.filter((c) => c !== code);
    } else if (this.languages.length < MAX_OCR_LANGUAGES) this.languages = [...this.languages, code];
    else return false;
    this.emit();
    return true;
  }
  /** Order matters: the first language is the primary one. */
  moveLanguage(code: string, direction: -1 | 1): void {
    const i = this.languages.indexOf(code);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= this.languages.length) return;
    const next = [...this.languages];
    [next[i], next[j]] = [next[j]!, next[i]!];
    this.languages = next;
    this.emit();
  }
  get pages(): PageIndex[] {
    const sel = this.session.selection;
    if (this.scope === 'all') return Array.from({ length: this.session.pageCount }, (_, i) => i);
    if (this.scope === 'selected' && sel.kind === 'pages') return [...sel.pages].sort((a, b) => a - b);
    return [this.session.view.page];
  }

  /** Downloads a language only after the user confirmed its name and size (FR-OCR-02). */
  async install(code: string): Promise<boolean> {
    const pack = this.s.ocrLanguages.pack(code);
    if (!pack || pack.bundled) return false;
    if (!(await this.app.prompts.confirm(msg('ocr.confirmDownload', { name: pack.name, size: pack.size, host: new URL(pack.url!).host }), { confirmLabel: msg('ocr.download') }))) return false;
    this.downloading = { code, received: 0, total: pack.size };
    this.emit();
    const ok = await this.app.guard(async () => {
      await this.s.ocrLanguages.install(code, {
        onProgress: (received, total) => {
          this.downloading = { code, received, total };
          this.emit();
        },
      });
      return true;
    });
    this.downloading = null;
    await this.loadPacks();
    return !!ok;
  }
  async remove(code: string): Promise<void> {
    await this.app.guard(() => this.s.ocrLanguages.remove(code));
    this.languages = this.languages.filter((c) => c !== code);
    if (this.languages.length === 0) this.languages = ['eng'];
    await this.loadPacks();
  }

  /** The current page, for the banner: scanned, no text, no layer of Folio's. */
  async refreshBanner(): Promise<void> {
    const page = this.session.view.page;
    if (page < 0 || page >= this.session.pageCount) return;
    const layer = await this.session.text.layer(page);
    const scanned = layer.isScanned && !(await this.session.doc.hasOcrLayer(page));
    // Only a change is announced: the shell calls this on every update and would loop otherwise.
    if (scanned !== this.scannedHere) {
      this.scannedHere = scanned;
      this.emit();
    }
  }

  /**
   * Runs recognition as one undoable step. Languages that are not installed are downloaded first (after
   * confirmation); signed documents and AI runs ask before anything changes or is sent.
   */
  async execute(pagesOverride?: PageIndex[], engineOverride?: 'local' | 'ai'): Promise<OcrRun | null> {
    const engine = engineOverride ?? this.engine;
    const pages = pagesOverride ?? this.pages;
    if (engine === 'local') {
      if (!this.available) {
        this.app.toast('warning', msg('ocr.unavailable'));
        return null;
      }
      for (const pack of await this.s.ocrLanguages.missing(this.languages)) if (!(await this.install(pack.code))) return null;
    } else {
      if (!(await this.aiAvailable())) {
        this.app.toast('warning', msg('ai.gate.noVision'));
        return null;
      }
      const host = endpointHost(this.app.settings.ai.baseUrl);
      if (!(await this.app.prompts.confirm(msg('ocr.aiPreflight', { count: pages.length, host }), { confirmLabel: msg('ocr.aiSend') }))) return null;
    }
    if (this.session.meta.hasSignatures && !(await this.app.prompts.confirm(msg('ocr.confirmSigned'), { confirmLabel: msg('action.continue') }))) return null;
    this.stage = 'running';
    this.progress = 0;
    this.abort = new AbortController();
    this.emit();
    let result: OcrRun | null = null;
    const ok = await this.app.guard(async () => {
      await this.session.settled();
      await this.session.run(
        this.s.ocr.command(
          this.session.doc,
          {
            pages,
            languages: this.s.ocrLanguages.validate(this.languages),
            engine,
            redo: this.redo,
            signal: this.abort!.signal,
            progress: (done, total) => {
              this.progress = total ? done / total : 1;
              this.emit();
            },
          },
          (r) => (result = r),
        ),
      );
      return true;
    });
    if (ok && engine === 'local') await this.app.setSetting('ocr', { languages: this.languages });
    this.stage = ok ? 'done' : 'ready';
    this.run = result;
    this.retry = result ? this.s.ocr.lowConfidence(result) : [];
    if (result) {
      const done = (result as OcrRun).outcomes.filter((o) => o.status === 'done').length;
      this.app.toastUndo(msg(done ? 'toast.ocrDone' : 'toast.ocrNothing', { count: done }));
      if ((result as OcrRun).outcomes.some((o) => o.substituted > 0)) this.app.toast('info', msg('ocr.substituted'));
    }
    this.emit();
    void this.refreshBanner();
    return result;
  }
  /** "Retry with AI" for the pages the local run was unsure about; replaces only Folio's own layer. */
  async retryWithAi(): Promise<OcrRun | null> {
    const pages = this.retry;
    if (pages.length === 0) return null;
    const keep = this.redo;
    this.redo = true;
    const out = await this.execute(pages, 'ai');
    this.redo = keep;
    return out;
  }
  cancel(): void {
    this.abort?.abort();
  }
  reset(): void {
    this.stage = 'idle';
    this.run = null;
    this.emit();
  }
}

// ---- Extract tables (FR-OPT-12) -----------------------------------------------------------------

export class TablesModel extends ViewModel {
  open = false;
  page: PageIndex = 0;
  /** The rectangle the user drew, or null for the whole page. */
  area: Rect | null = null;
  rows: string[][] = [];
  source: 'local' | 'ai' = 'local';
  ruled = false;
  skippedRotated = false;
  busy = false;
  /** Nothing was found in the area. */
  empty = false;
  delimiter: ',' | ';' = ',';
  bom = false;
  /** First row is a header (shown in bold; the file is unchanged). */
  header = true;
  private abort?: AbortController;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
    tools?: { areaPicked: { on(cb: (e: { tool: 'table'; page: PageIndex; rect: Rect }) => void): () => void } },
  ) {
    super();
    tools?.areaPicked.on((e) => void this.extract(e.page, e.rect));
  }
  private get s() {
    return this.app.services;
  }
  async aiAvailable(): Promise<boolean> {
    const ai = this.app.settings.ai;
    return ai.enabled && aiGates(ai).vision && (await this.s.ai.isConfigured());
  }
  get columns(): number {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  /** Local detection on a page, for the area or the whole page; the grid opens either way. */
  async extract(page: PageIndex, area: Rect | null): Promise<void> {
    this.page = page;
    this.area = area;
    this.open = true;
    this.busy = true;
    this.empty = false;
    this.emit();
    const out = await this.app.guard(() => this.s.tables.extractLocal(this.session.doc, page, area));
    this.busy = false;
    this.source = 'local';
    this.rows = out?.rows ?? [];
    this.ruled = !!out?.ruled;
    this.skippedRotated = !!out?.skippedRotated;
    this.empty = !out || out.rows.length === 0;
    this.emit();
  }
  /** "Use AI": on a scan or when the local result is poor. The pre-flight says what is sent. */
  async useAi(): Promise<boolean> {
    if (!(await this.aiAvailable())) {
      this.app.toast('warning', msg('ai.gate.noVision'));
      return false;
    }
    const host = endpointHost(this.app.settings.ai.baseUrl);
    if (!(await this.app.prompts.confirm(msg('tables.aiPreflight', { page: this.page + 1, host }), { confirmLabel: msg('tables.aiSend') }))) return false;
    this.abort = new AbortController();
    this.busy = true;
    this.emit();
    const out = await this.app.guard(() => this.s.tables.extractAi(this.session.doc, this.page, this.area, this.abort!.signal));
    this.busy = false;
    if (out) {
      this.rows = out.rows;
      this.source = 'ai';
      this.ruled = false;
      this.empty = out.rows.length === 0;
    }
    this.emit();
    return !!out;
  }
  cancel(): void {
    this.abort?.abort();
  }
  close(): void {
    this.open = false;
    this.rows = [];
    this.emit();
  }

  // ---- grid editing ---------------------------------------------------------------------------
  private set(rows: string[][]): void {
    this.rows = rows;
    this.emit();
  }
  setCell(r: number, c: number, value: string): void {
    this.set(grid.setCell(this.rows, r, c, value));
  }
  mergeColumns(c: number): void {
    this.set(grid.mergeColumns(this.rows, c));
  }
  splitColumn(c: number): void {
    this.set(grid.splitColumn(this.rows, c));
  }
  deleteRow(r: number): void {
    this.set(grid.deleteRow(this.rows, r));
  }
  deleteColumn(c: number): void {
    this.set(grid.deleteColumn(this.rows, c));
  }
  setOptions(patch: Partial<Pick<TablesModel, 'delimiter' | 'bom' | 'header'>>): void {
    Object.assign(this, patch);
    this.emit();
  }

  // ---- output ---------------------------------------------------------------------------------
  /** Save CSV: UTF-8, RFC 4180, the chosen separator and optional byte order mark. */
  async saveCsv(): Promise<boolean> {
    const files = this.s.platform.files;
    const ref = await files.pickSave({ suggestedName: this.s.tables.fileName(this.session.name, this.page), kind: 'csv' });
    if (!ref) return false;
    const ok = await this.app.guard(async () => {
      await files.write(ref, this.s.tables.csv(this.rows, { delimiter: this.delimiter, bom: this.bom }), { atomic: true });
      return true;
    });
    if (ok) this.app.toast('success', msg('toast.tableSaved', { name: ref.name }));
    return !!ok;
  }
  /** Copy as tab-separated text, ready to paste into a spreadsheet. */
  async copy(): Promise<boolean> {
    const ok = await this.app.guard(async () => {
      await this.s.platform.clipboard.writeText(this.s.tables.tsv(this.rows));
      return true;
    });
    if (ok) this.app.toast('success', msg('toast.tableCopied'));
    return !!ok;
  }
}

// ---- Profiles and field templates (FR-FRM-20, FR-AIF-01) --------------------------------------

export class ProfilesModel extends ViewModel {
  profiles: Profile[] = [];
  templates: FieldTemplate[] = [];
  editing: string | null = null;
  /** Keys skipped by the last "add template", for the notice. */
  skipped: string[] = [];
  constructor(private readonly app: AppModel) {
    super();
  }
  private get s() {
    return this.app.services;
  }
  async load(): Promise<void> {
    this.profiles = await this.s.profiles.list();
    this.templates = await this.s.templates.list();
    this.signatures = await this.s.signaturesRepo.list('signature');
    if (this.editing && !this.profiles.some((p) => p.id === this.editing)) this.editing = null;
    this.emit();
  }
  get current(): Profile | null {
    return this.profiles.find((p) => p.id === this.editing) ?? null;
  }
  open(id: string | null): void {
    this.editing = id;
    this.skipped = [];
    this.emit();
  }
  private async run<T>(task: () => Promise<T>): Promise<T | undefined> {
    const out = await this.app.guard(task);
    await this.load();
    return out;
  }

  // ---- profiles ---------------------------------------------------------------------------
  /** New profile: empty, or built from one or more templates (built-in or user-made). */
  async create(name: string, templateIds: string[] = []): Promise<Profile | undefined> {
    return this.run(async () => {
      const p = await this.s.profiles.create(name);
      for (const id of templateIds) {
        const t = this.templates.find((x) => x.id === id);
        if (t) await this.s.profiles.addTemplate(p.id, t.fields);
      }
      this.editing = p.id;
      return (await this.s.profiles.get(p.id))!;
    });
  }
  async duplicate(id: string): Promise<void> {
    await this.run(async () => (this.editing = (await this.s.profiles.duplicate(id)).id));
  }
  async remove(id: string): Promise<boolean> {
    if (!(await this.app.prompts.confirm(msg('confirm.removeProfile'), { danger: true, confirmLabel: msg('action.delete') }))) return false;
    await this.run(() => this.s.profiles.remove(id));
    return true;
  }
  async rename(id: string, name: string): Promise<boolean> {
    return !!(await this.run(async () => (await this.s.profiles.rename(id, name), true)));
  }
  /** Saved signatures a profile can use (kind "signature"; initials are placed by hand). */
  signatures: StoredSignature[] = [];
  async setSignature(profileId: string, signatureId: string | null): Promise<void> {
    await this.run(() => this.s.profiles.setSignature(profileId, signatureId));
  }
  async setDefault(id: string): Promise<void> {
    await this.run(() => this.s.profiles.setDefault(id));
  }

  // ---- entries ----------------------------------------------------------------------------
  /** Adds an empty entry; the key is made from the label and stays as it is when the label changes. */
  async addField(profileId: string, label: string, type: ProfileFieldType = 'text'): Promise<string | undefined> {
    const p = this.profiles.find((x) => x.id === profileId);
    const key = uniqueKey(label, p?.fields.map((f) => f.key) ?? []);
    return this.run(async () => {
      await this.s.profiles.setField(profileId, { key, label: label.trim() || key, type, value: '' });
      return key;
    });
  }
  /** Typed edits: invalid dates, e-mail addresses and numbers are refused with the reason (no write). */
  async updateField(
    profileId: string,
    key: string,
    patch: Partial<{ label: string; value: string; type: ProfileFieldType; sensitive: boolean; aliases: string[]; options: string[] }>,
  ): Promise<boolean> {
    const f = this.profiles.find((p) => p.id === profileId)?.fields.find((x) => x.key === key);
    if (!f) return false;
    const next = { ...f, ...patch };
    const problem = validateProfileValue(next.type, next.value);
    if (problem) {
      this.app.toast('warning', msg(`profiles.invalid.${problem}`));
      this.emit();
      return false;
    }
    return !!(await this.run(async () => {
      await this.s.profiles.setField(profileId, next);
      return true;
    }));
  }
  /** Changing a key forgets the remembered mappings that used it, after confirmation. */
  async changeKey(profileId: string, key: string, newKey: string): Promise<boolean> {
    if (!(await this.app.prompts.confirm(msg('profiles.confirmKey'), { confirmLabel: msg('action.continue') }))) return false;
    return !!(await this.run(async () => {
      await this.s.profiles.renameKey(profileId, key, newKey);
      await this.s.mappings.dropKey(profileId, key);
      return true;
    }));
  }
  async removeField(profileId: string, key: string): Promise<void> {
    await this.run(async () => {
      await this.s.profiles.removeField(profileId, key);
      await this.s.mappings.dropKey(profileId, key);
    });
  }
  async moveField(profileId: string, key: string, direction: -1 | 1): Promise<void> {
    const keys = this.profiles.find((p) => p.id === profileId)?.fields.map((f) => f.key) ?? [];
    const at = keys.indexOf(key);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= keys.length) return;
    [keys[at], keys[to]] = [keys[to]!, keys[at]!];
    await this.run(() => this.s.profiles.reorder(profileId, keys));
  }

  // ---- templates --------------------------------------------------------------------------
  async addTemplate(profileId: string, templateId: string): Promise<void> {
    const t = this.templates.find((x) => x.id === templateId);
    if (!t) return;
    const res = await this.run(() => this.s.profiles.addTemplate(profileId, t.fields));
    this.skipped = res?.skipped ?? [];
    if (this.skipped.length) this.app.toast('info', msg('profiles.skipped', { count: this.skipped.length, keys: this.skipped.join(', ') }));
    this.emit();
  }
  async saveAsTemplate(profileId: string, name: string): Promise<FieldTemplate | undefined> {
    const p = this.profiles.find((x) => x.id === profileId);
    return p ? this.run(() => this.s.templates.fromProfile(p, name)) : undefined;
  }
  async createTemplate(name: string): Promise<FieldTemplate | undefined> {
    return this.run(() => this.s.templates.create(name));
  }
  async updateTemplate(id: string, patch: { name?: string; fields?: FieldDefinition[] }): Promise<boolean> {
    return !!(await this.run(async () => (await this.s.templates.update(id, patch), true)));
  }
  async duplicateTemplate(id: string): Promise<void> {
    await this.run(() => this.s.templates.duplicate(id));
  }
  async removeTemplate(id: string): Promise<boolean> {
    if (!(await this.app.prompts.confirm(msg('profiles.confirmTemplate'), { danger: true, confirmLabel: msg('action.delete') }))) return false;
    await this.run(() => this.s.templates.remove(id));
    return true;
  }
  async exportTemplate(id: string): Promise<boolean> {
    const t = this.templates.find((x) => x.id === id);
    const files = this.s.platform.files;
    if (!t) return false;
    const ref = await files.pickSave({ suggestedName: `${t.name}.template.json`, kind: 'json' });
    if (!ref) return false;
    await files.write(ref, new TextEncoder().encode(JSON.stringify(this.s.templates.exportJson(t), null, 2)), { atomic: true });
    return true;
  }
  async importTemplate(): Promise<FieldTemplate | null> {
    const files = this.s.platform.files;
    const [ref] = await files.pickOpen({ accept: ['json'] });
    if (!ref) return null;
    const out = await this.run(async () => {
      let data: unknown = null;
      try {
        data = JSON.parse(new TextDecoder().decode(await files.read(ref)));
      } catch {
        /* reported as "not a template file" */
      }
      return this.s.templates.importJson(data);
    });
    return out ?? null;
  }
}

// ---- Form authoring: Edit form mode (FR-FRM-08, FR-FRM-11, FR-FRM-16, FR-FRM-17) -----------------

export class FormAuthoringModel extends ViewModel {
  /** "Edit form" is on: highlights always shown, inputs not interactive, drawing and selection enabled. */
  active = false;
  tool: FieldTool | 'select' = 'select';
  selected: { id: string; widget: number } | null = null;
  proposals: FieldProposal[] = [];
  notice: DetectionNotice | null = null;
  detecting = false;
  private warned = false;

  constructor(
    private readonly app: AppModel,
    private readonly session: DocumentSession,
  ) {
    super();
    session.invalidated.on((inv) => {
      if (inv.kind === 'form' || inv.kind === 'all' || inv.kind === 'structure') {
        if (this.selected && !this.fields.some((f) => f.id === this.selected!.id)) this.selected = null;
        this.emit();
      }
    });
  }
  private get service() {
    return this.app.services.authoring;
  }
  /** Last list of fields; kept here so the model has no await in getters. */
  cached: FormField[] = [];
  get fields(): FormField[] {
    return this.cached;
  }
  async refresh(): Promise<void> {
    this.cached = await this.session.fields();
    this.emit();
  }
  get field(): FormField | null {
    return this.selected ? (this.cached.find((f) => f.id === this.selected!.id) ?? null) : null;
  }
  get blocked(): 'xfa' | 'encrypted' | null {
    return this.service.blocked(this.session.meta);
  }
  get compatible() {
    return this.field ? this.service.compatible(this.field) : [];
  }

  /** Edit form / Fill form. XFA and encrypted documents are not authored (FR-FRM-09). */
  async toggle(): Promise<boolean> {
    if (this.active) {
      this.active = false;
      this.tool = 'select';
      this.selected = null;
      this.proposals = [];
      this.emit();
      return true;
    }
    const block = this.blocked;
    if (block) {
      this.app.toast('warning', msg(`form.author.blocked.${block}`));
      return false;
    }
    if (this.session.meta.hasSignatures && !this.warned) {
      if (!(await this.app.prompts.confirm(msg('form.author.confirmSigned'), { confirmLabel: msg('action.continue') }))) return false;
      this.warned = true;
    }
    this.active = true;
    await this.refresh();
    return true;
  }
  setTool(tool: FieldTool | 'select'): void {
    this.tool = FIELD_TOOLS.includes(tool as FieldTool) || tool === 'select' ? tool : 'select';
    this.emit();
  }
  select(sel: { id: string; widget: number } | null): void {
    this.selected = sel;
    this.emit();
  }
  private async run(cmd: ReturnType<typeof this.service.create>): Promise<boolean> {
    const ok = await this.app.guard(async () => {
      await this.session.run(cmd);
      await this.refresh();
      return true;
    });
    return !!ok;
  }
  private taken(): Set<string> {
    return new Set(this.cached.map((f) => f.name));
  }

  /** A click or drag on a page with a tool: creates the field with an automatic name (FR-FRM-08). */
  async createAt(page: PageIndex, a: Point, b: Point | null): Promise<boolean> {
    if (this.tool === 'select') return false;
    const info = this.session.pageInfos[page];
    if (!info) return false;
    const rect = this.service.rectFor(this.tool, a, b, info.cropBox);
    const layer = await this.session.text.layer(page);
    const name = this.service.autoName(this.tool, labelNear(rect, layer), this.taken());
    // A radio button drawn next to an existing group joins it when the user names it the same later; a
    // new one starts its own group with its own name.
    const spec = this.service.spec(this.tool, name, page, rect);
    const ok = await this.run(this.service.create([spec]));
    if (ok) {
      this.selected = { id: name, widget: 0 };
      this.tool = 'select';
    }
    this.emit();
    return ok;
  }
  async update(patch: FieldPatch): Promise<boolean> {
    const f = this.field;
    return f ? this.run(this.service.update(f, patch)) : false;
  }
  async rename(name: string): Promise<boolean> {
    const f = this.field;
    if (!f) return false;
    const ok = await this.app.guard(async () => {
      await this.session.run(this.service.rename(f, name, this.taken()));
      await this.refresh();
      return true;
    });
    if (ok) this.selected = { id: f.name.includes('.') ? `${f.name.slice(0, f.name.lastIndexOf('.') + 1)}${name.trim()}` : name.trim(), widget: this.selected!.widget };
    this.emit();
    return !!ok;
  }
  async setRect(rect: Rect): Promise<boolean> {
    const f = this.field;
    return f && this.selected ? this.run(this.service.move(f, this.selected.widget, rect)) : false;
  }
  /** Arrow keys nudge by 1 pt, with Shift by 10 pt. */
  async nudge(dx: number, dy: number, shift: boolean): Promise<boolean> {
    const f = this.field;
    if (!f || !this.selected) return false;
    const w = f.widgets[this.selected.widget]!;
    const info = this.session.pageInfos[w.page];
    if (!info) return false;
    return this.setRect(this.service.nudge(w.rect, dx, dy, shift, info.cropBox));
  }
  async remove(): Promise<boolean> {
    const f = this.field;
    if (!f || !this.selected) return false;
    const widget = f.type === 'radio' && f.widgets.length > 1 ? this.selected.widget : undefined;
    const ok = await this.run(this.service.remove(f, widget));
    if (ok) this.selected = null;
    this.emit();
    return ok;
  }

  // ---- Detect fields (FR-FRM-15) -------------------------------------------------------------

  /** Proposes fields for pages: local on vector pages, the vision model on scans or when `forceAi`. */
  async detect(pages: PageIndex[], forceAi = false): Promise<number> {
    this.detecting = true;
    this.notice = null;
    this.emit();
    const settings = this.app.settings.ai;
    const gates = aiGates(settings);
    const res = await this.app.guard(async () => {
      await this.refresh();
      return this.app.services.detection.detect(this.session.doc, pages, {
        useAi: settings.enabled && gates.vision && (await this.app.services.ai.isConfigured()),
        forceAi,
      });
    });
    this.detecting = false;
    if (res) {
      this.proposals = res.proposals;
      this.notice = res.notice ?? (res.proposals.length === 0 && forceAi && !gates.vision ? 'visionOff' : null);
    }
    this.emit();
    return res?.proposals.length ?? 0;
  }
  toggleProposal(id: string, accepted: boolean): void {
    this.proposals = this.proposals.map((p) => (p.id === id ? { ...p, accepted } : p));
    this.emit();
  }
  acceptAll(accepted = true): void {
    this.proposals = this.proposals.map((p) => ({ ...p, accepted }));
    this.emit();
  }
  /** Turns the accepted proposals into real fields, named from their labels, in one undoable step. */
  async createProposals(): Promise<number> {
    const taken = this.taken();
    const specs = [];
    for (const p of this.proposals.filter((x) => x.accepted)) {
      const tool: FieldTool = p.type === 'checkbox' ? 'checkbox' : p.multiline ? 'multiline' : 'text';
      const name = this.service.autoName(tool, p.label, taken);
      taken.add(name);
      specs.push(this.service.spec(tool, name, p.page, p.rect, { tooltip: p.label, ...(p.cells ? { comb: true, maxLength: p.cells } : {}) }));
    }
    if (specs.length === 0) return 0;
    const ok = await this.run(this.service.create(specs, 'cmd.createFields'));
    if (!ok) return 0;
    this.proposals = [];
    this.emit();
    return specs.length;
  }
  cancelProposals(): void {
    this.proposals = [];
    this.notice = null;
    this.emit();
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
  private stopsFor: FormField[] | null = null;
  private stopsCache: ReturnType<typeof tabOrder> = [];
  /** Tab order, recomputed only when the field list is replaced (every page reads it on each refresh). */
  get stops(): ReturnType<typeof tabOrder> {
    if (this.stopsFor !== this.fields) {
      this.stopsCache = tabOrder(this.fields);
      this.stopsFor = this.fields;
    }
    return this.stopsCache;
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
  /** Explains an empty result (a scan with no AI, FR-AIF-14). */
  noticeKey: string | null = null;
  /** Empty signature fields of the pages and the profile's signature for them (option "Sign"). */
  signFields = 0;
  signWith: StoredSignature | null = null;
  signIt = true;
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
    if (ai) {
      const sf = this.app.services.smartFill;
      const pages = this.pages();
      const { candidates, layers } = await sf.collect(this.session.doc, pages);
      // No fields at all (a scan): the page image is the only input, so it is sent for this run even if
      // the setting is off, after the pre-flight says so. A model without vision cannot do it.
      const noFields = candidates.length === 0;
      const scanned = noFields && pages.some((p) => layers.get(p)?.isScanned);
      if (noFields && !aiGates(settings).vision) {
        if (scanned) this.app.toast('warning', msg('ai.gate.noVision'));
        return this.analyse(false);
      }
      if (noFields || !settings.preflightAcknowledged.includes(settings.mode)) {
        const sizes = new Map(pages.map((p) => [p, this.session.pageInfos[p]?.size ?? { width: 612, height: 792 }] as const));
        const req = sf.buildRequest(candidates, layers, sizes, this.profile, settings.mode, settings.maxPagesPerRun, pages);
        this.preflight = {
          ...sf.preflight(req, this.profile),
          includesImage: this.includeImage || noFields,
          imageForThisRun: noFields && !this.includeImage,
          destination: { host: endpointHost(settings.baseUrl), local: isLoopbackUrl(settings.baseUrl) },
        };
        this.stage = 'preflight';
        this.emit();
        return;
      }
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
        canSeeImages: aiGates(settings).vision,
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
    await this.findSignatureFields();
    this.stage = result.suggestions.length || this.signFields ? 'review' : 'empty';
    if (result.fallbackReason && result.fallbackReason !== 'notConfigured')
      this.app.toast('warning', msg(`smartfill.fallback.${result.fallbackReason}`));
    this.noticeKey = result.fallbackReason === 'scanNeedsAi' ? 'smartfill.fallback.scanNeedsAi' : null;
    this.emit();
  }
  /** Counts the signature fields the profile's signature would go into. */
  private async findSignatureFields(): Promise<void> {
    this.signFields = 0;
    this.signWith = null;
    const id = this.profile?.signatureId;
    if (!id) return;
    const sig = await this.app.services.signaturesRepo.get(id);
    if (!sig) return;
    this.signWith = sig;
    this.signFields = (await this.signCommand(sig))?.count ?? 0;
  }
  private async signCommand(sig: StoredSignature) {
    const raster = await this.app.services.platform.images.decode(sig.png);
    const data = { kind: sig.kind, svg: sig.svg, raster, width: sig.width, height: sig.height };
    return this.app.services.smartFill.signFields(this.session.doc, this.pages(), data);
  }
  setSignIt(on: boolean): void {
    this.signIt = on;
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
  /** Option "Flatten on save": the filled form is closed, fields and all (remembered). */
  get flatten(): boolean {
    return this.app.settings.smartFillFlatten;
  }
  setFlatten(on: boolean): Promise<void> {
    return this.app.setSetting('smartFillFlatten', on);
  }
  /** "Apply selected" / "Apply all high-confidence": one undo step, and the mapping is remembered. */
  async apply(onlyHigh = false): Promise<number> {
    if (!this.result || !this.profile) return 0;
    const svc = this.app.services.smartFill;
    const list = onlyHigh ? svc.acceptHigh(this.suggestions) : this.suggestions;
    const taken = new Set((await this.session.fields()).map((f) => f.name));
    const sign = this.signIt && this.signWith ? (await this.signCommand(this.signWith))?.command : undefined;
    const cmd = svc.apply(list, undefined, { taken, flatten: this.flatten, extra: sign });
    if (!cmd) return 0;
    const plan = svc.plan(list, taken);
    const count = list.filter((s) => s.accepted && s.value !== '').length + (sign ? this.signFields : 0);
    const pages = [...new Set(list.filter((s) => plan.nameByRef.has(s.ref)).map((s) => s.page))];
    const ok = await this.app.guard(async () => {
      await this.session.run(cmd);
      await svc.remember(this.result!, list, this.profile!);
      if (!this.flatten) await svc.rememberCreated(this.session.doc, pages, plan.nameByRef, list, this.profile!);
      return true;
    });
    if (!ok) return 0;
    this.app.toastUndo(msg('toast.smartFillApplied', { count }));
    this.cancel();
    return count;
  }
}

export { InvalidArgumentError };
