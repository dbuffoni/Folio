import { Emitter, containsPoint, fitTextBox, isFolioError, msg, rectFromPoints, translate, type Msg } from '@folio/core';
import type {
  Annotation,
  Color,
  ImageSpec,
  MarkupAnnotation,
  PageIndex,
  PageObject,
  Point,
  Rect,
  Size,
  StampAnnotation,
  StandardFontFamily,
  TextLayer,
} from '@folio/ports';
import {
  HIGHLIGHT_COLORS,
  constrainBox,
  constrainLine,
  fontBadge,
  moveAnnotation,
  nudge,
  placeAt,
  resizeAnnotation,
  resizeLocked,
  snapRect,
  type DetectedArea,
  type EditableLine,
  type LineEditResult,
  type ListedAnnotation,
  type SnapResult,
} from '@folio/services';
import type { Services } from './services.ts';
import type { DocumentSession, Mode } from './session.ts';

export type ToolId =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'textbox'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polyline'
  | 'place'
  | 'edit-text'
  | 'add-text'
  | 'whiteout'
  | 'cover-type'
  | 'check'
  | 'cross'
  | 'snapshot';

/** Tools offered in each mode's contextual toolbar (SPEC §7.2). `select` is always available. */
export const MODE_TOOLS: Record<Mode, ToolId[]> = {
  view: ['select', 'snapshot'],
  organise: ['select'],
  annotate: [
    'select',
    'highlight',
    'underline',
    'strikeout',
    'squiggly',
    'note',
    'textbox',
    'rect',
    'ellipse',
    'line',
    'arrow',
    'polyline',
  ],
  fill: ['select', 'cover-type', 'check', 'cross'],
  edit: ['select', 'edit-text', 'add-text', 'whiteout'],
};
const MARKUP: ToolId[] = ['highlight', 'underline', 'strikeout', 'squiggly'];
const SHAPES: ToolId[] = ['rect', 'ellipse', 'line', 'arrow'];

export interface Modifiers {
  shift?: boolean;
  alt?: boolean;
  mod?: boolean;
}
export type Handle = 'tl' | 'tr' | 'bl' | 'br';

export interface ToolOptions {
  color: Color;
  highlightColor: Color;
  fillColor?: Color;
  opacity: number;
  strokeWidth: number;
  strokeStyle: 'solid' | 'dashed';
  fontFamily: StandardFontFamily;
  fontSize: number;
  textColor: Color;
  align: 'left' | 'center' | 'right';
  /** FR-EDT-06: write added text into the page content instead of a FreeText annotation. */
  addAsPageContent: boolean;
  /** FR-EDT-05: also remove the objects fully covered by a whiteout. */
  removeUnderWhiteout: boolean;
}
export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  color: { r: 211, g: 47, b: 47 },
  highlightColor: HIGHLIGHT_COLORS.yellow!,
  opacity: 1,
  strokeWidth: 2,
  strokeStyle: 'solid',
  fontFamily: 'sans',
  fontSize: 12,
  textColor: { r: 29, g: 78, b: 216 },
  align: 'left',
  addAsPageContent: false,
  removeUnderWhiteout: false,
};

/** Something following the pointer until it is dropped (signature, stamp, date, image). */
export interface Ghost {
  kind: 'signature' | 'stamp' | 'image';
  size: Size;
  page: PageIndex | null;
  rect: Rect | null;
  /** Builds what is placed once the position is known. */
  make: (rect: Rect, page: PageIndex) => { annotation: StampAnnotation } | { image: ImageSpec };
  /** Preview shown inside the ghost (PNG bytes), when available. */
  preview?: Uint8Array;
}
export interface Draft {
  tool: ToolId;
  page: PageIndex;
  start: Point;
  current: Point;
  /** Polyline vertices so far. */
  points?: Point[];
}
export interface Drag {
  page: PageIndex;
  kind: 'move' | 'resize';
  handle?: Handle;
  start: Point;
  /** Annotations being changed, as they were. */
  items: Annotation[];
  /** Live geometry for the overlay. */
  preview: Annotation[];
  object?: PageObject;
  objectPreview?: Rect;
  snap: SnapResult;
}
export interface InlineEdit {
  page: PageIndex;
  line: EditableLine;
  layer: TextLayer;
  text: string;
  caret: number;
  badge: { text: string; substituted: boolean };
}
export interface Typing {
  page: PageIndex;
  rect: Rect;
  fontSize: number;
  kind: 'textbox' | 'cover' | 'page-content';
  area?: DetectedArea;
  /** Existing free-text annotation being re-edited. */
  editing?: Annotation;
}
export interface EditNotice {
  kind: 'substituted' | 'overflow' | 'missingGlyphs';
  message: Msg;
  result: LineEditResult;
  /** Where the edited line is (PDF user space): the notice is drawn next to it. */
  rect?: Rect;
}

/**
 * Tool state machine for one document (SPEC §8.6, §7.4). The UI converts pointer events to page
 * coordinates (PDF user space) and forwards them; everything else — what a click means in the
 * current tool, live previews, the command that results — is decided here, without a DOM.
 */
export class ToolController {
  readonly changed = new Emitter<void>();
  tool: ToolId = 'select';
  /** Shift-click on a tool keeps it active after use (FR "sticky if Shift held"). */
  sticky = false;
  options: ToolOptions = { ...DEFAULT_TOOL_OPTIONS };
  ghost: Ghost | null = null;
  draft: Draft | null = null;
  drag: Drag | null = null;
  inlineEdit: InlineEdit | null = null;
  typing: Typing | null = null;
  hoverLine: { page: PageIndex; line: EditableLine } | null = null;
  notice: EditNotice | null = null;
  /** Message for the canvas when a tool cannot work on this page (e.g. scanned page). */
  hint: Msg | null = null;
  private textAnchor: { page: PageIndex; index: number } | null = null;
  private areas = new Map<PageIndex, DetectedArea[]>();

  constructor(
    private readonly session: DocumentSession,
    private readonly services: Services,
    private readonly feedback: { error(e: unknown): void; info(m: Msg): void } = {
      error: () => undefined,
      info: () => undefined,
    },
  ) {
    session.invalidated.on(() => this.areas.clear());
  }

  private emit(): void {
    this.changed.emit();
  }
  private async safe<T>(task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await task();
    } catch (e) {
      if (!(isFolioError(e) && e.code === 'cancelled')) this.feedback.error(e);
      return undefined;
    }
  }

  // ---- tool selection ------------------------------------------------------------------------

  setTool(tool: ToolId, opts: { sticky?: boolean } = {}): void {
    this.cancel();
    this.tool = tool;
    this.sticky = !!opts.sticky;
    this.hint = null;
    this.emit();
  }
  setOptions(patch: Partial<ToolOptions>): void {
    this.options = { ...this.options, ...patch };
    this.emit();
  }
  /** After a one-shot tool is used, go back to Select unless the tool is sticky. */
  private done(): void {
    if (!this.sticky) this.tool = 'select';
    this.emit();
  }
  /** Esc: drop whatever is in progress, then deselect, then fall back to Select. */
  cancel(): void {
    const busy = this.ghost || this.draft || this.drag || this.inlineEdit || this.typing;
    this.ghost = null;
    this.draft = null;
    this.drag = null;
    this.inlineEdit = null;
    this.typing = null;
    this.textAnchor = null;
    this.notice = null;
    if (!busy) {
      if (this.session.selection.kind !== 'none') this.session.select({ kind: 'none' });
      else if (this.tool !== 'select') this.tool = 'select';
    }
    this.emit();
  }

  // ---- placement of signatures, stamps and images (FR-STM-03) --------------------------------

  beginPlacement(ghost: Omit<Ghost, 'page' | 'rect'>): void {
    this.cancel();
    this.tool = 'place';
    this.ghost = { ...ghost, page: null, rect: null };
    this.emit();
  }
  private pageBounds(page: PageIndex): Rect {
    return this.session.pageInfos[page]?.cropBox ?? { x: 0, y: 0, ...this.pageSize(page) };
  }
  private clampPoint(p: Point, page: PageIndex): Point {
    const b = this.pageBounds(page);
    return {
      x: Math.min(b.x + b.width, Math.max(b.x, p.x)),
      y: Math.min(b.y + b.height, Math.max(b.y, p.y)),
    };
  }
  private pageSize(page: PageIndex): Size {
    return this.session.pageInfos[page]?.size ?? { width: 612, height: 792 };
  }
  private async place(page: PageIndex): Promise<void> {
    const ghost = this.ghost;
    if (!ghost?.rect) return;
    const made = ghost.make(ghost.rect, page);
    await this.safe(async () => {
      if ('annotation' in made) {
        const ref = await this.session.run(this.services.annotations.add(page, made.annotation));
        this.session.select({ kind: 'annotations', page, ids: [ref.id] });
      } else {
        const id = await this.session.run(this.services.objects.insert(page, made.image));
        this.session.select({ kind: 'object', page, id });
      }
    });
    this.ghost = null;
    this.done();
  }

  // ---- pointer events --------------------------------------------------------------------------

  async pointerDown(page: PageIndex, p: Point, mods: Modifiers = {}, handle?: Handle): Promise<void> {
    this.notice = null;
    if (this.tool === 'place') return this.place(page);
    if (this.typing || this.inlineEdit) return; // the UI commits the open editor first

    if (MARKUP.includes(this.tool) || this.tool === 'select') {
      // Handles and annotations take precedence over text under them.
      if (this.tool === 'select') {
        const annotations = await this.session.annotations(page);
        const sel = this.session.selection;
        if (handle && sel.kind === 'annotations' && sel.page === page) {
          const items = annotations.filter((a) => sel.ids.includes(a.id!));
          this.drag = {
            page,
            kind: 'resize',
            handle,
            start: p,
            items,
            preview: items,
            snap: { dx: 0, dy: 0, guides: [] },
          };
          return this.emit();
        }
        if (handle && sel.kind === 'object' && sel.page === page) {
          const image = (await this.session.doc.listObjects(page)).find((o) => o.id === sel.id);
          if (image) {
            this.drag = {
              page,
              kind: 'resize',
              handle,
              start: p,
              items: [],
              preview: [],
              object: image,
              objectPreview: image.bounds,
              snap: { dx: 0, dy: 0, guides: [] },
            };
            return this.emit();
          }
        }
        const hit = this.services.annotations.hitTest(
          annotations.filter((a) => a.type !== 'link'),
          p,
        );
        if (hit) {
          const already = sel.kind === 'annotations' && sel.page === page && sel.ids.includes(hit.id!);
          const ids =
            mods.shift || mods.mod
              ? already
                ? (sel as { ids: string[] }).ids.filter((i) => i !== hit.id)
                : [...(sel.kind === 'annotations' && sel.page === page ? sel.ids : []), hit.id!]
              : already
                ? (sel as { ids: string[] }).ids
                : [hit.id!];
          this.session.select(ids.length ? { kind: 'annotations', page, ids } : { kind: 'none' });
          const items = annotations.filter((a) => ids.includes(a.id!) && !a.locked);
          if (items.length)
            this.drag = {
              page,
              kind: 'move',
              start: p,
              items,
              preview: items,
              snap: { dx: 0, dy: 0, guides: [] },
            };
          return this.emit();
        }
        if (this.session.mode === 'edit') {
          const image = this.services.objects.imageAt(await this.session.doc.listObjects(page), p);
          if (image) {
            this.session.select({ kind: 'object', page, id: image.id });
            this.drag = {
              page,
              kind: handle ? 'resize' : 'move',
              handle,
              start: p,
              items: [],
              preview: [],
              object: image,
              objectPreview: image.bounds,
              snap: { dx: 0, dy: 0, guides: [] },
            };
            return this.emit();
          }
        }
      }
      const layer = await this.session.text.layer(page);
      const index = this.session.text.charAt(layer, p);
      this.textAnchor = index >= 0 ? { page, index } : null;
      this.session.select({ kind: 'none' });
      return this.emit();
    }

    switch (this.tool) {
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'arrow':
      case 'whiteout':
      case 'snapshot':
        this.draft = { tool: this.tool, page, start: p, current: p };
        break;
      case 'polyline':
        if (this.draft?.tool === 'polyline' && this.draft.page === page)
          this.draft = { ...this.draft, points: [...this.draft.points!, p], current: p };
        else this.draft = { tool: 'polyline', page, start: p, current: p, points: [p] };
        break;
      case 'note': {
        const ref = await this.safe(() =>
          this.session.run(this.services.annotations.add(page, this.services.annotations.noteAt(p))),
        );
        if (ref) this.session.select({ kind: 'annotations', page, ids: [ref.id] });
        this.done();
        break;
      }
      case 'textbox':
        this.typing = {
          page,
          rect: {
            x: p.x,
            y: p.y - this.options.fontSize * 1.6,
            width: 180,
            height: this.options.fontSize * 1.6,
          },
          fontSize: this.options.fontSize,
          kind: 'textbox',
        };
        break;
      case 'add-text':
        this.typing = {
          page,
          rect: {
            x: p.x,
            y: p.y - this.options.fontSize * 0.3,
            width: 220,
            height: this.options.fontSize * 1.4,
          },
          fontSize: this.options.fontSize,
          kind: this.options.addAsPageContent ? 'page-content' : 'textbox',
        };
        break;
      case 'cover-type': {
        const areas = await this.detectedAreas(page);
        const box = this.services.forms.boxAt(p, areas, await this.session.text.layer(page));
        this.typing = { page, rect: box.rect, fontSize: box.fontSize, kind: 'cover', area: box.area };
        break;
      }
      case 'check':
      case 'cross': {
        const def = (await import('@folio/services')).BUILTIN_STAMPS.find((s) => s.mark === this.tool)!;
        const areas = await this.detectedAreas(page);
        const box = areas.find((a) => a.kind === 'checkbox' && containsPoint(a.rect, p, 3));
        const annotation = this.services.stamps.annotation(def, p, this.pageSize(page), box?.rect);
        await this.safe(() => this.session.run(this.services.annotations.add(page, annotation)));
        this.emit();
        break;
      }
      case 'edit-text':
        await this.beginInlineEdit(page, p);
        break;
    }
    this.emit();
  }

  async pointerMove(page: PageIndex, p: Point, mods: Modifiers = {}): Promise<void> {
    if (this.ghost) {
      this.ghost = { ...this.ghost, page, rect: placeAt(p, this.ghost.size, this.pageSize(page)) };
      return this.emit();
    }
    if (this.draft && this.draft.page === page) {
      let current = p;
      if (mods.shift)
        current =
          this.draft.tool === 'line' || this.draft.tool === 'arrow'
            ? constrainLine(this.draft.start, p)
            : this.draft.tool === 'polyline'
              ? constrainLine(this.draft.points![this.draft.points!.length - 1]!, p)
              : constrainBox(this.draft.start, p);
      this.draft = { ...this.draft, current };
      return this.emit();
    }
    if (this.drag && this.drag.page === page) {
      const d = this.drag;
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      if (d.object) {
        const b = d.object.bounds;
        d.objectPreview =
          d.kind === 'move'
            ? translate(b, dx, dy)
            : resizeLocked(b, this.anchorOf(b, d.handle!), p, 8, this.pageBounds(page));
      } else if (d.kind === 'move') {
        const moved = d.items.map((a) => moveAnnotation(a, dx, dy));
        // Snap the first item to the page and to other annotations unless Alt is held.
        const others = (await this.session.annotations(page))
          .filter((a) => !d.items.some((i) => i.id === a.id))
          .map((a) => a.rect);
        const size = this.pageSize(page);
        d.snap =
          mods.alt || !moved[0]
            ? { dx: 0, dy: 0, guides: [] }
            : snapRect(moved[0].rect, others, { x: 0, y: 0, ...size });
        d.preview = moved.map((a) => moveAnnotation(a, d.snap.dx, d.snap.dy));
      } else if (d.items[0]) {
        const a = d.items[0];
        const anchor = this.anchorOf(a.rect, d.handle!);
        // Stamps and signatures keep their proportions; everything else resizes freely (Shift locks).
        const to =
          a.type === 'stamp' || mods.shift
            ? resizeLocked(a.rect, anchor, p, 8, this.pageBounds(page))
            : rectFromPoints(anchor, this.clampPoint(p, page));
        d.preview = to.width > 4 && to.height > 4 ? [resizeAnnotation(a, to)] : d.preview;
      }
      return this.emit();
    }
    if (this.textAnchor && this.textAnchor.page === page) {
      const layer = await this.session.text.layer(page);
      const index = this.session.text.charAt(layer, p, 12);
      if (index >= 0)
        this.session.select({
          kind: 'text',
          range: this.session.text.rangeBetween(page, this.textAnchor.index, index),
        });
      return;
    }
    if (this.tool === 'edit-text' && !this.inlineEdit) {
      const lines = await this.editableLines(page);
      const line = lines ? this.services.textEdit.lineAt(lines.lines, p) : undefined;
      const next = line ? { page, line } : null;
      if (next?.line !== this.hoverLine?.line) {
        this.hoverLine = next;
        this.emit();
      }
    }
  }

  async pointerUp(page: PageIndex, p: Point, mods: Modifiers = {}): Promise<void> {
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      const moved = Math.hypot(p.x - d.start.x, p.y - d.start.y) > 0.75;
      if (moved) {
        await this.safe(async () => {
          if (d.object && d.objectPreview) {
            const cmd =
              d.kind === 'move'
                ? this.services.objects.move(
                    d.page,
                    d.object,
                    d.objectPreview.x - d.object.bounds.x,
                    d.objectPreview.y - d.object.bounds.y,
                  )
                : this.services.objects.resize(d.page, d.object, d.objectPreview);
            await this.session.run(cmd);
          } else {
            for (let k = 0; k < d.items.length; k++)
              await this.session.run(this.services.annotations.update(d.page, d.items[k]!, d.preview[k]!));
          }
        });
      }
      return this.emit();
    }
    if (this.draft && this.draft.tool !== 'polyline') {
      const draft = this.draft;
      this.draft = null;
      await this.finishDraft(draft);
      return;
    }
    if (this.textAnchor) {
      this.textAnchor = null;
      const sel = this.session.selection;
      // In a markup tool, selecting text applies the markup at once (FR-ANN-01).
      if (sel.kind === 'text' && MARKUP.includes(this.tool)) {
        await this.applyMarkup(this.tool as MarkupAnnotation['type']);
        if (!this.sticky && !mods.shift) this.tool = 'select';
      }
      this.emit();
    }
    void page;
  }

  /** Double-click: select a word; finish a polyline; re-open a text box for editing. */
  async doubleClick(page: PageIndex, p: Point): Promise<void> {
    if (this.draft?.tool === 'polyline') {
      const draft = this.draft;
      this.draft = null;
      return this.finishDraft(draft);
    }
    if (this.tool !== 'select') return;
    const hit = this.services.annotations.hitTest(await this.session.annotations(page), p);
    if (hit?.type === 'freetext' && !hit.locked) {
      this.typing = { page, rect: hit.rect, fontSize: hit.fontSize, kind: 'textbox', editing: hit };
      return this.emit();
    }
    const layer = await this.session.text.layer(page);
    const index = this.session.text.charAt(layer, p);
    if (index >= 0) this.session.select({ kind: 'text', range: this.session.text.wordAt(layer, index) });
  }
  /** Triple-click selects the line (FR-VIEW-03). */
  async tripleClick(page: PageIndex, p: Point): Promise<void> {
    const layer = await this.session.text.layer(page);
    const index = this.session.text.charAt(layer, p);
    if (index >= 0) this.session.select({ kind: 'text', range: this.session.text.lineAt(layer, index) });
  }

  private anchorOf(r: Rect, handle: Handle): Point {
    // The corner opposite to the dragged handle stays put. Page space: y grows upwards.
    return {
      x: handle === 'tl' || handle === 'bl' ? r.x + r.width : r.x,
      y: handle === 'tl' || handle === 'tr' ? r.y : r.y + r.height,
    };
  }

  private async finishDraft(draft: Draft): Promise<void> {
    const rect = rectFromPoints(draft.start, draft.current);
    const o = this.options;
    const stroke = {
      strokeWidth: o.strokeWidth,
      strokeStyle: o.strokeStyle,
      color: o.color,
      opacity: o.opacity,
    };
    await this.safe(async () => {
      if (draft.tool === 'polyline') {
        const vertices = draft.points!;
        if (vertices.length < 2) return;
        const xs = vertices.map((v) => v.x);
        const ys = vertices.map((v) => v.y);
        const box = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
        const ref = await this.session.run(
          this.services.annotations.add(draft.page, { type: 'polyline', rect: box, vertices, ...stroke }),
        );
        this.session.select({ kind: 'annotations', page: draft.page, ids: [ref.id] });
      } else if (draft.tool === 'line' || draft.tool === 'arrow') {
        if (Math.hypot(draft.current.x - draft.start.x, draft.current.y - draft.start.y) < 3) return;
        const ref = await this.session.run(
          this.services.annotations.add(draft.page, {
            type: 'line',
            rect,
            start: draft.start,
            end: draft.current,
            startEnding: 'none',
            endEnding: draft.tool === 'arrow' ? 'openArrow' : 'none',
            ...stroke,
          }),
        );
        this.session.select({ kind: 'annotations', page: draft.page, ids: [ref.id] });
      } else if (rect.width < 3 || rect.height < 3) {
        return;
      } else if (draft.tool === 'rect' || draft.tool === 'ellipse') {
        const ref = await this.session.run(
          this.services.annotations.add(draft.page, {
            type: draft.tool === 'rect' ? 'square' : 'circle',
            rect,
            fillColor: o.fillColor,
            ...stroke,
          }),
        );
        this.session.select({ kind: 'annotations', page: draft.page, ids: [ref.id] });
      } else if (draft.tool === 'whiteout') {
        const color = await this.services.objects.backgroundAt(this.session.doc, draft.page, rect);
        const objects = o.removeUnderWhiteout ? await this.session.doc.listObjects(draft.page) : undefined;
        await this.session.run(
          this.services.objects.whiteout(draft.page, rect, color, {
            removeUnder: o.removeUnderWhiteout,
            objects,
          }),
        );
      } else if (draft.tool === 'snapshot') {
        await this.services.platform.clipboard.writeImage(
          await this.services.exporter.snapshotPng(this.session.doc, draft.page, rect),
        );
        this.feedback.info(msg('toast.snapshotCopied'));
      }
    });
    if (SHAPES.includes(draft.tool) || draft.tool === 'polyline' || draft.tool === 'snapshot') this.done();
    else this.emit();
  }

  // ---- text markup (FR-ANN-01) -----------------------------------------------------------------

  /** Mini-toolbar action: mark up the current text selection. */
  async applyMarkup(type: MarkupAnnotation['type'], color?: Color): Promise<boolean> {
    const sel = this.session.selection;
    if (sel.kind !== 'text') return false;
    const layer = await this.session.text.layer(sel.range.page);
    const quads = this.session.text.quads(layer, sel.range);
    const ok = await this.safe(async () => {
      const a = this.services.annotations.markup(type, quads, {
        color: color ?? (type === 'highlight' ? this.options.highlightColor : undefined),
      });
      const ref = await this.session.run(this.services.annotations.add(sel.range.page, a));
      this.session.select({ kind: 'annotations', page: sel.range.page, ids: [ref.id] });
      return true;
    });
    return !!ok;
  }
  /** Mini-toolbar "comment": a note anchored at the end of the selection. */
  async commentSelection(text: string): Promise<boolean> {
    const sel = this.session.selection;
    if (sel.kind !== 'text') return false;
    const layer = await this.session.text.layer(sel.range.page);
    const b = this.session.text.bounds(layer, sel.range);
    const note = this.services.annotations.noteAt({ x: b.x + b.width + 4, y: b.y + b.height }, text);
    return !!(await this.safe(() => this.session.run(this.services.annotations.add(sel.range.page, note))));
  }
  async selectedText(): Promise<string> {
    const sel = this.session.selection;
    if (sel.kind !== 'text') return '';
    return this.session.text.text(await this.session.text.layer(sel.range.page), sel.range);
  }
  async copySelection(): Promise<boolean> {
    const sel = this.session.selection;
    if (sel.kind === 'text') {
      await this.services.platform.clipboard.writeText(await this.selectedText());
      return true;
    }
    if (sel.kind === 'annotations') {
      const list = (await this.session.annotations(sel.page)).filter((a) => sel.ids.includes(a.id!));
      await this.services.platform.clipboard.writeText(this.services.annotations.serialize(list));
      return true;
    }
    return false;
  }
  private lastPaste: { text: string; page: PageIndex; step: number } | null = null;
  /** Paste annotations copied in this or another tab onto `page`. */
  async paste(text: string, page: PageIndex): Promise<number> {
    // Each further paste of the same copy on the same page steps further away from the original.
    const again = this.lastPaste?.text === text && this.lastPaste.page === page;
    const step = again ? this.lastPaste!.step + 1 : 1;
    const items = this.services.annotations.deserialize(text, { x: 12 * step, y: -12 * step });
    if (items.length === 0) return 0;
    this.lastPaste = { text, page, step };
    const refs = await this.safe(() =>
      this.session.run(
        this.services.annotations.addMany(
          items.map((annotation) => ({ page, annotation })),
          'cmd.paste',
        ),
      ),
    );
    if (refs) this.session.select({ kind: 'annotations', page, ids: refs.map((r) => r.id) });
    return refs?.length ?? 0;
  }

  // ---- typed text: text boxes and Cover & type (FR-ANN-03, FR-FRM-06, FR-EDT-06) ----------------

  /** Commit the open text box. Empty text cancels (and deletes a re-edited box). */
  async commitTyping(text: string): Promise<void> {
    const t = this.typing;
    if (!t) return;
    this.typing = null;
    const value = text.replace(/\s+$/g, '');
    const o = this.options;
    await this.safe(async () => {
      if (t.editing) {
        if (value === '')
          await this.session.run(this.services.annotations.remove([{ page: t.page, annotation: t.editing }]));
        else
          await this.session.run(
            this.services.annotations.update(t.page, t.editing, { ...t.editing, contents: value }),
          );
      } else if (value === '') {
        return;
      } else if (t.kind === 'page-content') {
        await this.session.run(
          this.services.textEdit.addText(t.page, {
            text: value,
            origin: { x: t.rect.x, y: t.rect.y + t.fontSize * 0.3 },
            fontSize: t.fontSize,
            fontFamily: o.fontFamily,
            color: o.textColor,
          }),
        );
      } else if (t.kind === 'cover') {
        const a = t.area
          ? this.services.forms.fromArea(t.area, value)
          : this.services.forms.coverText(t.rect, value, { fontSize: t.fontSize });
        await this.session.run(this.services.annotations.add(t.page, a));
      } else {
        const bounds = this.session.pageInfos[t.page]?.cropBox ?? {
          x: 0,
          y: 0,
          width: t.rect.x + t.rect.width + 400,
          height: t.rect.y + t.rect.height + 400,
        };
        const rect = fitTextBox(value, t.fontSize, t.rect, bounds);
        await this.session.run(
          this.services.annotations.add(t.page, {
            type: 'freetext',
            rect,
            contents: value,
            fontFamily: o.fontFamily,
            fontSize: t.fontSize,
            textColor: o.textColor,
            align: o.align,
          }),
        );
      }
    });
    if (t.kind === 'cover') this.emit();
    else this.done();
  }
  /** Fillable areas detected on a page, cached until the page changes (FR-FRM-07 ghosts). */
  async detectedAreas(page: PageIndex): Promise<DetectedArea[]> {
    let list = this.areas.get(page);
    if (!list) this.areas.set(page, (list = await this.services.forms.detect(this.session.doc, page)));
    return list;
  }

  // ---- inline text edit (FR-EDT-01/02/04/08) ---------------------------------------------------

  private async editableLines(page: PageIndex): Promise<{ layer: TextLayer; lines: EditableLine[] } | null> {
    const layer = await this.session.text.layer(page);
    try {
      return { layer, lines: this.services.textEdit.lines(layer) };
    } catch (e) {
      if (isFolioError(e) && e.code === 'unsupportedFeature') {
        // Scanned page: say so and point at Cover & type (OCR arrives in Release 2).
        this.hint = msg('edit.scannedPage');
        return null;
      }
      throw e;
    }
  }
  private async beginInlineEdit(page: PageIndex, p: Point): Promise<void> {
    const found = await this.editableLines(page);
    if (!found) return;
    const line = this.services.textEdit.lineAt(found.lines, p);
    if (!line) return;
    if (line.blocked) {
      this.feedback.info(line.blocked);
      return;
    }
    this.hoverLine = null;
    this.inlineEdit = {
      page,
      line,
      layer: found.layer,
      text: line.text,
      caret: this.services.textEdit.caretAt(found.layer, line, p),
      badge: fontBadge({ kind: 'reused', fontName: line.fontName }, line.fontSize),
    };
  }
  /** Enter or click-away: apply the edit. Unchanged text is a no-op. */
  async commitInlineEdit(text: string): Promise<LineEditResult | null> {
    const e = this.inlineEdit;
    if (!e) return null;
    this.inlineEdit = null;
    if (text === e.line.text) {
      this.emit();
      return null;
    }
    const info = this.session.pageInfos[e.page] ?? (await this.session.doc.getPageInfo(e.page));
    const result = await this.safe(() =>
      this.session.run(this.services.textEdit.editLine(e.page, e.layer, e.line, text, info)),
    );
    if (result) {
      // Honest feedback (FR-EDT-02/04): missing glyphs lose text, so they come first; then a line that no
      // longer fits; then a substituted font. The notice is anchored on the line that was edited.
      const rect = e.line.line.rect;
      if (result.missingGlyphs)
        this.notice = { kind: 'missingGlyphs', message: msg('edit.missingGlyphs'), result, rect };
      else if (result.overflow) this.notice = { kind: 'overflow', message: msg('edit.overflow'), result, rect };
      else if (result.font.kind === 'substituted')
        this.notice = {
          kind: 'substituted',
          message: msg('edit.fontSubstituted', { from: result.font.from, to: result.font.to }),
          result,
          rect,
        };
    }
    this.emit();
    return result ?? null;
  }
  /** "Shrink to fit" from the overflow notice. */
  async shrinkToFit(): Promise<boolean> {
    const n = this.notice;
    if (!n?.result.shrinkFactor) return false;
    const ok = await this.safe(async () => {
      await this.session.run(
        this.services.textEdit.shrinkToFit(n.result, n.result.width > 0 ? this.sizeOf(n.result) : 12),
      );
      return true;
    });
    this.notice = null;
    this.emit();
    return !!ok;
  }
  private sizeOf(result: LineEditResult): number {
    const layer = this.session.pageInfos[result.page];
    void layer;
    return this.lastEditSize;
  }
  private lastEditSize = 12;
  /** The inline editor reports the size it started from so shrink-to-fit can scale it. */
  rememberEditSize(size: number): void {
    this.lastEditSize = size;
  }

  // ---- keyboard on the canvas ------------------------------------------------------------------

  /** Delete/Backspace: remove the selection. Returns the number of removed things. */
  async deleteSelection(): Promise<number> {
    const sel = this.session.selection;
    if (sel.kind === 'annotations') {
      const items: ListedAnnotation[] = (await this.session.annotations(sel.page))
        .filter((a) => sel.ids.includes(a.id!))
        .map((annotation) => ({ page: sel.page, annotation }));
      if (items.length === 0) return 0;
      const ok = await this.safe(async () => {
        await this.session.run(this.services.annotations.remove(items));
        return true;
      });
      if (ok === undefined) return 0;
      this.session.select({ kind: 'none' });
      return items.length;
    }
    if (sel.kind === 'object') {
      await this.safe(() => this.session.run(this.services.objects.delete(sel.page, sel.id)));
      this.session.select({ kind: 'none' });
      return 1;
    }
    return 0;
  }
  /** Arrow keys nudge the selected annotations: 1 pt, or 10 pt with Shift. */
  async nudgeSelection(
    key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
    big: boolean,
  ): Promise<boolean> {
    const sel = this.session.selection;
    if (sel.kind !== 'annotations') return false;
    const size = this.pageSize(sel.page);
    const items = (await this.session.annotations(sel.page)).filter(
      (a) => sel.ids.includes(a.id!) && !a.locked,
    );
    for (const a of items) {
      const to = nudge(a.rect, key, big, size);
      await this.safe(() =>
        this.session.run(
          this.services.annotations.update(sel.page, a, moveAnnotation(a, to.x - a.rect.x, to.y - a.rect.y)),
        ),
      );
    }
    return items.length > 0;
  }
  /** Inspector edits (colour, width, font, text…) applied to every selected annotation. */
  async restyleSelection(patch: Partial<Annotation>): Promise<void> {
    const sel = this.session.selection;
    if (sel.kind !== 'annotations') return;
    for (const a of (await this.session.annotations(sel.page)).filter((x) => sel.ids.includes(x.id!))) {
      await this.safe(() =>
        this.session.run(this.services.annotations.update(sel.page, a, { ...a, ...patch } as Annotation)),
      );
    }
  }
  async reorderSelection(where: 'front' | 'back' | 'forward' | 'backward'): Promise<void> {
    const sel = this.session.selection;
    if (sel.kind !== 'annotations' || sel.ids.length !== 1) return;
    const order = (await this.session.annotations(sel.page)).map((a) => a.id!);
    const cmd = this.services.annotations.reorder(sel.page, order, sel.ids[0]!, where);
    if (cmd) await this.safe(() => this.session.run(cmd));
  }
}
