import type { Color, Matrix, Point, Quad, Rect, Rotation, Size } from './geometry.ts';

export type PageIndex = number; // 0-based
export type AnnotId = string;
export type FieldId = string;
export type ObjId = string;

// ---------------------------------------------------------------------------------------------
// Document level
// ---------------------------------------------------------------------------------------------

export interface DocMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modDate: string;
  /** e.g. "1.7" */
  pdfVersion: string;
  hasXfa: boolean;
  hasAcroForm: boolean;
  isEncrypted: boolean;
  hasSignatures: boolean;
  /** true when the cross-reference table had to be rebuilt (damaged file opened in recovery mode). */
  wasRepaired: boolean;
}
export type EditableMeta = Pick<DocMeta, 'title' | 'author' | 'subject' | 'keywords'>;

export interface PageInfo {
  /** Unrotated size of the visible page area (crop box) in points. */
  size: Size;
  rotation: Rotation;
  mediaBox: Rect;
  cropBox: Rect;
  label?: string;
}

/** Raw raster in RGBA, 8 bits per channel, not premultiplied, rows top to bottom. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /**
   * Set instead of pixel data (`data` is then empty) when `RenderOptions.bitmap` was honoured: a
   * decoded image the UI thread can draw without copying pixels (an `ImageBitmap` in browsers).
   */
  bitmap?: RasterBitmap;
}
/** The part of an `ImageBitmap` the ports need; keeps DOM types out of the interfaces. */
export interface RasterBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface RenderOptions {
  /** Device pixels per point. 1 = 72 dpi. */
  scale: number;
  /** Tile, in device pixels of the full rendered (rotated) page; defaults to the whole page. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Extra view rotation added to the page's own rotation. */
  rotation?: Rotation;
  annotations?: boolean;
  forms?: boolean;
  /** Page background; defaults to opaque white. */
  background?: Color;
  /**
   * Ask for a decoded bitmap (`RasterImage.bitmap`) instead of pixel data. Honoured only where the
   * engine runs behind a worker boundary with `createImageBitmap`; otherwise pixels are returned.
   */
  bitmap?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

export interface FontInfo {
  /** PostScript name as stored in the file, subset prefix removed ("ABCDEF+Arial" → "Arial"). */
  name: string;
  family: string;
  isEmbedded: boolean;
  isSubset: boolean;
  weight: number;
  italic: boolean;
  /** PDF font descriptor flags (bit 1 fixed pitch, bit 2 serif, …). */
  flags: number;
}

export interface TextChar {
  /** One UTF-16 code unit sequence (usually one character). */
  text: string;
  rect: Rect;
  origin: Point;
}

export interface TextRun {
  /** Page object the run belongs to; `undefined` for generated characters. */
  objId?: ObjId;
  text: string;
  rect: Rect;
  /** Baseline origin of the first glyph. */
  origin: Point;
  /** Rotation of the baseline in degrees, counter-clockwise. 0 for normal horizontal text. */
  angle: number;
  font: FontInfo;
  fontSize: number;
  color: Color;
  /** Index of the first character in `TextLayer.chars` and number of characters. */
  charStart: number;
  charCount: number;
}

/** Editable unit of Release 1: adjacent runs on one baseline with equal font, size and colour. */
export interface TextLine {
  text: string;
  rect: Rect;
  runs: number[]; // indexes into TextLayer.runs
  /** false for rotated/vertical text or text with broken Unicode mapping. */
  editable: boolean;
}

export interface TextLayer {
  page: PageIndex;
  text: string;
  chars: TextChar[];
  runs: TextRun[];
  lines: TextLine[];
  /** true when the page has no text objects but is covered by an image (scan). */
  isScanned: boolean;
}

export interface SearchQuery {
  text: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  pages?: PageIndex[];
}
export interface SearchHit {
  page: PageIndex;
  /** Character range in the page text. */
  charStart: number;
  charCount: number;
  rects: Rect[];
  snippet: { before: string; match: string; after: string };
}

// ---------------------------------------------------------------------------------------------
// Outline, links, attachments
// ---------------------------------------------------------------------------------------------

export type LinkTarget =
  | { kind: 'page'; page: PageIndex; point?: Point; zoom?: number }
  | { kind: 'uri'; uri: string }
  /** `missing`: the destination page no longer exists in the document (FR-EDT-27). */
  | { kind: 'unsupported'; reason: 'javascript' | 'launch' | 'remote' | 'named' | 'unknown' | 'missing' };

export interface OutlineNode {
  title: string;
  target?: LinkTarget;
  children: OutlineNode[];
}
/**
 * One edit of the bookmark tree. Paths are child indexes from the root. Everything the edit does not
 * name (actions, style, open state of other entries) is left exactly as in the file (FR-EDT-27).
 * For `move`, `parent` and `index` describe the position in the tree after the entry was taken out.
 */
export type OutlineEdit =
  | { op: 'add'; parent: number[]; index: number; title: string; target?: LinkTarget }
  | { op: 'rename'; path: number[]; title: string }
  | { op: 'remove'; path: number[] }
  | { op: 'move'; path: number[]; parent: number[]; index: number }
  | { op: 'setTarget'; path: number[]; target: LinkTarget };
export interface LinkInfo {
  rect: Rect;
  target: LinkTarget;
}
export interface AttachmentInfo {
  index: number;
  name: string;
  size: number;
}

// ---------------------------------------------------------------------------------------------
// Annotations (engine-neutral, JSON-serialisable except binary image payloads)
// ---------------------------------------------------------------------------------------------

export type LineEnding = 'none' | 'openArrow' | 'closedArrow' | 'circle' | 'square' | 'diamond' | 'butt' | 'slash';
export type StrokeStyle = 'solid' | 'dashed';

export interface AnnotationBase {
  /** Assigned by the engine on creation; stable for the life of the document (stored in /NM). */
  id?: AnnotId;
  rect: Rect;
  /** Main colour (stroke / markup colour). */
  color?: Color;
  opacity?: number;
  author?: string;
  /** Text content / comment. */
  contents?: string;
  /** PDF date strings (D:YYYYMMDDHHmmSS). */
  created?: string;
  modified?: string;
  locked?: boolean;
  hidden?: boolean;
}

export interface MarkupAnnotation extends AnnotationBase {
  type: 'highlight' | 'underline' | 'strikeout' | 'squiggly';
  quads: Quad[];
}
export interface NoteAnnotation extends AnnotationBase {
  type: 'text';
  icon?: 'Comment' | 'Note' | 'Help' | 'Insert' | 'Key' | 'NewParagraph' | 'Paragraph';
  open?: boolean;
}
export interface FreeTextAnnotation extends AnnotationBase {
  type: 'freetext';
  fontFamily: StandardFontFamily;
  fontSize: number;
  textColor: Color;
  align: 'left' | 'center' | 'right';
  backgroundColor?: Color;
  borderColor?: Color;
  borderWidth?: number;
}
export interface LineAnnotation extends AnnotationBase {
  type: 'line';
  start: Point;
  end: Point;
  startEnding: LineEnding;
  endEnding: LineEnding;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  fillColor?: Color;
}
export interface ShapeAnnotation extends AnnotationBase {
  type: 'square' | 'circle';
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  fillColor?: Color;
}
export interface PolylineAnnotation extends AnnotationBase {
  type: 'polyline' | 'polygon';
  vertices: Point[];
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  fillColor?: Color;
}
export interface InkAnnotation extends AnnotationBase {
  type: 'ink';
  paths: Point[][];
  strokeWidth: number;
}
/** Vector path in the stamp's own coordinate box (0,0)-(width,height), y up. */
export interface StampPath {
  /** SVG-like commands in absolute coordinates. */
  segments: Array<
    | { op: 'M' | 'L'; x: number; y: number }
    | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { op: 'Z' }
  >;
  stroke?: Color;
  strokeWidth?: number;
  fill?: Color;
}
export type StampAppearance =
  | { kind: 'image'; image: RasterImage }
  | { kind: 'vector'; width: number; height: number; paths: StampPath[] }
  | {
      kind: 'text';
      text: string;
      color: Color;
      fontFamily: StandardFontFamily;
      bold?: boolean;
      border?: boolean;
    };
export interface StampAnnotation extends AnnotationBase {
  type: 'stamp';
  /** Semantic name: "Approved", "Signature", "Date", … */
  name?: string;
  /** Rotation of the appearance inside `rect`, degrees counter-clockwise. */
  rotation?: number;
  /** Required when creating; absent when read back from a file (the appearance lives in the PDF). */
  appearance?: StampAppearance;
}
export interface LinkAnnotation extends AnnotationBase {
  type: 'link';
  target: LinkTarget;
}
/** Annotation written by another tool that Folio shows and can move/delete but not restyle. */
export interface ForeignAnnotation extends AnnotationBase {
  type: 'other';
  subtype: string;
}

export type Annotation =
  | MarkupAnnotation
  | NoteAnnotation
  | FreeTextAnnotation
  | LineAnnotation
  | ShapeAnnotation
  | PolylineAnnotation
  | InkAnnotation
  | StampAnnotation
  | LinkAnnotation
  | ForeignAnnotation;
export type AnnotationType = Annotation['type'];

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'button' | 'signature';

export interface FormWidget {
  page: PageIndex;
  rect: Rect;
  /** Export value of this widget for checkbox/radio ("Yes", "optionA"). */
  exportValue?: string;
}

export interface FormField {
  /** Stable id: fully qualified field name (plus a suffix for unnamed fields). */
  id: FieldId;
  name: string;
  type: FormFieldType;
  /** Tooltip from /TU. */
  label?: string;
  /** Text value, selected option for choices, export value for radio groups, 'Off' or export value for checkboxes. */
  value: string;
  /** Multi-select list boxes. */
  values?: string[];
  options?: { label: string; value: string }[];
  widgets: FormWidget[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  password: boolean;
  comb: boolean;
  multiSelect: boolean;
  maxLength?: number;
  /** Known simple format from AA/JS, interpreted without executing JavaScript. */
  format?: { kind: 'number'; decimals: number } | { kind: 'date'; pattern: string } | { kind: 'percent'; decimals: number };
}
export type FieldValue = string | boolean | string[];

/** A form field to create (FR-FRM-08, FR-FRM-11). Rectangles are in PDF user space. */
export interface FieldSpec {
  type: FormFieldType;
  /** Fully qualified name; a dot creates a hierarchy. Radio widgets with the same name join one group. */
  name: string;
  page: PageIndex;
  rect: Rect;
  tooltip?: string;
  /** Initial text, selected option, or "Yes"/"Off" style value for check boxes. */
  value?: string;
  required?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  password?: boolean;
  comb?: boolean;
  maxLength?: number;
  /** Choices of dropdowns and list boxes. */
  options?: { label: string; value: string }[];
  /** Export value of this check box / radio button; defaults to "Yes" and to the group's option number. */
  exportValue?: string;
  /** Button caption. */
  caption?: string;
  /** Font size in points; 0 or absent = automatic. */
  fontSize?: number;
  font?: StandardFontFamily;
  align?: 'left' | 'center' | 'right';
  textColor?: Color;
  backgroundColor?: Color;
  borderColor?: Color;
  borderWidth?: number;
}
/** Properties that can be changed on an existing field (FR-FRM-16). */
export interface FieldPatch {
  tooltip?: string;
  required?: boolean;
  readOnly?: boolean;
  /** text ↔ multiline. */
  multiline?: boolean;
  maxLength?: number | null;
  /** Choice fields; dropdown ↔ list box is `listbox`. */
  options?: { label: string; value: string }[];
  listbox?: boolean;
  fontSize?: number;
  align?: 'left' | 'center' | 'right';
}

// ---------------------------------------------------------------------------------------------
// Page content objects
// ---------------------------------------------------------------------------------------------

export type PageObjectType = 'text' | 'image' | 'path' | 'shading' | 'form';

export interface PageObject {
  id: ObjId;
  type: PageObjectType;
  bounds: Rect;
  matrix: Matrix;
  /** Present for text objects. */
  text?: string;
  /** Present for image objects: pixel size of the source image. */
  imageSize?: Size;
  /** Present for image objects: how the pixels are stored (FR-OPT-01). */
  imageInfo?: {
    bitsPerPixel: number;
    /** Size of the stored (still compressed) image data in bytes. */
    byteSize: number;
    /** PDF filters in order, e.g. ["DCTDecode"] or ["FlateDecode"]. */
    filters: string[];
  };
  fillColor?: Color;
  strokeColor?: Color;
}

/** Bundled font families every engine must support (metric-compatible OFL fonts, SPEC §8.7). */
export type StandardFontFamily = 'sans' | 'serif' | 'mono';

export interface TextStyle {
  fontFamily?: StandardFontFamily;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  color?: Color;
  charSpacing?: number;
}
export interface TextSpec extends TextStyle {
  text: string;
  /** Baseline origin of the first glyph. */
  origin: Point;
  /** Rotation in degrees counter-clockwise. */
  angle?: number;
}
export type TextEditFont = { kind: 'reused'; fontName: string } | { kind: 'substituted'; from: string; to: string };
export interface TextEditResult {
  /** Id of the (possibly new) text object holding the edited text. */
  objId: ObjId;
  font: TextEditFont;
  /** Width of the new text in points. */
  width: number;
  warnings: Array<'overflow' | 'missingGlyph'>;
}
export interface ImageSpec {
  image: RasterImage | { jpeg: Uint8Array; width: number; height: number };
  /** Where the image is drawn on the page. */
  rect: Rect;
  /** Rotation around the rect centre, degrees counter-clockwise. */
  angle?: number;
}
export interface RectSpec {
  rect: Rect;
  fill?: Color;
  stroke?: Color;
  strokeWidth?: number;
}

export interface SaveOptions {
  /** Append changes instead of rewriting (keeps earlier revisions and signatures valid up to that point). */
  incremental?: boolean;
  /**
   * Lossless size pass on a full rewrite: object streams, a compressed cross-reference stream and
   * Flate for every uncompressed stream (FR-OPT-07). Ignored together with `incremental`.
   */
  compact?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

export interface PdfEngine {
  /** @throws PasswordRequiredError | InvalidPdfError */
  open(data: Uint8Array, opts?: { password?: string }): Promise<PdfDocument>;
  /** New empty document (0 pages). */
  create(): Promise<PdfDocument>;
  /** New document made of the given pages, in order. Source documents are not modified. */
  merge(parts: { doc: PdfDocument; pages: PageIndex[] }[]): Promise<PdfDocument>;
  /**
   * Draws one line of text with the given TrueType/OpenType font on a transparent background
   * (typed signatures, text stamps previews). The image is cropped to the page box of the text.
   */
  rasterizeText(spec: { text: string; font: Uint8Array; fontSize: number; color: Color }): Promise<RasterImage>;
  dispose(): Promise<void>;
}

export interface PdfDocument {
  readonly id: string;
  readonly pageCount: number;
  getMeta(): Promise<DocMeta>;

  // pages & structure
  getPageInfo(i: PageIndex): Promise<PageInfo>;
  insertBlank(at: PageIndex, size: Size): Promise<void>;
  importPages(src: PdfDocument, pages: PageIndex[], at: PageIndex): Promise<void>;
  deletePages(pages: PageIndex[]): Promise<void>;
  /** Moves `pages` (kept in the given order) so that the first lands at index `to` of the resulting document. */
  movePages(pages: PageIndex[], to: PageIndex): Promise<void>;
  /** Adds `deg` clockwise to each page's rotation. */
  rotatePages(pages: PageIndex[], deg: 90 | 180 | 270): Promise<void>;

  // rendering
  render(i: PageIndex, o: RenderOptions, signal?: AbortSignal): Promise<RasterImage>;

  // content intelligence
  getTextLayer(i: PageIndex): Promise<TextLayer>;
  search(q: SearchQuery): AsyncIterable<SearchHit>;
  getOutline(): Promise<OutlineNode[]>;
  setOutline(nodes: OutlineNode[]): Promise<void>;
  /** In-place edit of one bookmark (FR-EDT-11). @throws InvalidArgumentError for a path that does not exist. */
  editOutline(edit: OutlineEdit): Promise<void>;
  getLinks(i: PageIndex): Promise<LinkInfo[]>;
  listAttachments(): Promise<AttachmentInfo[]>;
  getAttachment(index: number): Promise<Uint8Array>;

  // annotations
  listAnnotations(i: PageIndex): Promise<Annotation[]>;
  /** Creates (no id) or updates (id present) an annotation and regenerates its appearance stream. */
  upsertAnnotation(i: PageIndex, a: Annotation): Promise<AnnotId>;
  removeAnnotation(i: PageIndex, id: AnnotId): Promise<void>;
  /** Puts the listed annotations in the given back-to-front order; the others keep their place. */
  reorderAnnotations(i: PageIndex, ids: AnnotId[]): Promise<void>;
  /** Burns annotations (not form widgets) into page content; `types` limits it to some annotation types. */
  flattenAnnotations(pages?: PageIndex[], types?: AnnotationType[]): Promise<void>;

  // forms
  listFormFields(): Promise<FormField[]>;
  setFieldValue(id: FieldId, v: FieldValue): Promise<void>;
  /** Renames a field (used to resolve collisions when merging). */
  renameField(id: FieldId, name: string): Promise<FieldId>;
  flattenForm(): Promise<void>;
  /**
   * Creates fields in one step (FR-FRM-08). Names must be unused, except radio buttons of one group.
   * Appearance streams are generated so other viewers show them. @returns the ids, in order.
   * @throws InvalidArgumentError (bad or taken name, bad rectangle), UnsupportedFeatureError (XFA, encrypted)
   */
  createFields(specs: FieldSpec[]): Promise<FieldId[]>;
  /** Changes properties of an existing field (FR-FRM-16); returns its (unchanged) id. */
  updateField(id: FieldId, patch: FieldPatch): Promise<FieldId>;
  /** Moves/resizes one widget; the appearance is regenerated. */
  setWidgetRect(id: FieldId, widget: number, rect: Rect): Promise<void>;
  /** Removes a field with all its widgets, or just one widget (`widget` given); the last widget removes the field. */
  removeField(id: FieldId, widget?: number): Promise<void>;

  // page content objects
  listObjects(i: PageIndex): Promise<PageObject[]>;
  replaceTextRun(i: PageIndex, objId: ObjId, text: string, style?: TextStyle): Promise<TextEditResult>;
  addText(i: PageIndex, spec: TextSpec): Promise<ObjId>;
  addImage(i: PageIndex, img: ImageSpec): Promise<ObjId>;
  getImage(i: PageIndex, id: ObjId): Promise<RasterImage>;
  replaceImage(i: PageIndex, id: ObjId, image: ImageSpec['image']): Promise<void>;
  transformObject(i: PageIndex, id: ObjId, m: Matrix): Promise<void>;
  removeObject(i: PageIndex, id: ObjId): Promise<void>;
  addRect(i: PageIndex, spec: RectSpec): Promise<ObjId>;

  // IO
  setMetadata(m: Partial<EditableMeta>): Promise<void>;
  /** Removes Info entries and XMP metadata. */
  clearMetadata(): Promise<void>;
  save(opts?: SaveOptions): Promise<Uint8Array>;
  /** Cheap full-state capture used for history checkpoints and recovery. */
  snapshot(): Promise<Uint8Array>;
  restore(bytes: Uint8Array): Promise<void>;
  dispose(): void;
}
