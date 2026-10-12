# Folio Release 5 — "Compose & Edit" (v5.0)

| | |
|---|---|
| **Status** | Draft specification for review |
| **Date** | 2026-10-12 |
| **Builds on** | Release 4 (anchor model, batch operation registry, page layout) and Release 2 (OCR text) |
| **Roadmap** | [ROADMAP.md](ROADMAP.md) |

## 1. Purpose and outcome

Release 1 lets users *fix* content (line-level text edit, whiteout, images) and *mark up* with real annotations. Release 5 lets them **compose**: put recurring content on many pages, change the same words everywhere, shape the navigation of the document, and draw freely.

| Track | Feature | IDs |
|---|---|---|
| A. Page furniture | Watermark (text/image), header/footer, page numbers (Bates-style numbering as a token option) | FR-EDT-10 (+ FR-EDT-12…18) |
| B. Find & replace | Replace text across the document with preview and font-safety rules | FR-EDT-09 (+ FR-EDT-19…22) |
| C. Navigation | Outline (bookmark) editor and link editor | FR-EDT-11, FR-ANN-10 (+ FR-EDT-23…27) |
| D. Ink | Freehand pen and highlighter, eraser, smoothing, stylus pressure | FR-ANN-05 (+ FR-ANN-12…15) |
| E. Crop finish | "Trim content permanently" for crop (R4 set CropBox only) | FR-ORG-11 (tail) |

**Success looks like:** Giulia adds "CONFIDENTIAL" diagonal watermark at 15 % opacity to pages 2–end and "Page 3 of 40 · Invoice 2026-114" in the footer in one dialog with a live preview; Marta replaces the old company name in 14 places after reviewing a list; Luca sketches a circle with a stylus on a figure and highlights a line with the pen.

### 1.1 Out of scope

Paragraph reflow and text-box layout engine (SPEC §17.2), editing vector paths, per-page background templates and "document assembly" templates, Bates numbering with prefix/suffix registers across *multiple files* (single-document counter included, multi-file continuation is horizon with batch), handwriting recognition, shape recognition, stylus note-taking suite (§17.5).

## 2. Scenarios

| # | Scenario | Persona |
|---|---|---|
| S1 | Add a text watermark "DRAFT" at −45°, 20 % opacity, centred, behind content, on all pages; change opacity live; apply; remove it later by the same dialog ("Remove watermark"). | Giulia |
| S2 | Add an image watermark (logo) bottom-right at 15 % width to odd pages only. | Giulia |
| S3 | Footer "{filename} · Page {page} of {pages}" with roman numerals for the first 4 pages and arabic after; margin 12 mm; font Liberation Sans 9 pt; skip first page. | Luca |
| S4 | Find "ACME Ltd" → Replace "ACME Limited"; list shows 14 hits; 3 hits flagged "needs font substitution"; accept all except one; results undoable as one step. | Marta |
| S5 | Replace on an OCR'd scan: replacement edits hidden text only (default) and warns that visible pixels are unchanged. | Luca |
| S6 | Outline editor: add "Appendix A" bookmark on page 30, drag it above "References", rename, delete a node, undo/redo. | Luca |
| S7 | Link editor: drag a rectangle on a figure to make it link to page 5 or `https://…`; list all links on the page; fix a broken internal target. | Giulia |
| S8 | Pen at 2 px black with smoothing; highlighter at 40 % yellow, multiply blend; eraser removes whole strokes; select and move a stroke. | Luca |
| S9 | Crop with "trim content permanently": content outside the box is removed and file shrinks. | Paolo |

## 3. Functional requirements

### 3.1 Watermark, header/footer, page numbers (SPEC FR-EDT-10 expanded)

| ID | Requirement | Pri |
|---|---|---|
| FR-EDT-10 | **Watermark**: text (font from bundled set, size or "fit", colour, opacity 5–100 %, rotation, position by anchor + offset or tiled) or image (PNG/JPEG/SVG-rasterised, scale, opacity); layer above or below content; page scope (all, range, odd/even, exclude first/last). Written as page content wrapped in a marked-content sequence tagged `/Folio:Watermark` plus an `ExtGState` for opacity. | P0 |
| FR-EDT-12 | **Header/footer/page numbers**: three zones per band (left/centre/right) × header/footer; tokens `{page}`, `{pages}`, `{label}`, `{date}`, `{time}`, `{filename}`, `{title}`, `{author}`, `{n}` (document counter), `{n:000}`; number styles (arabic, roman upper/lower, alpha); start value; first-page override; odd/even mirror; margins in document units; font/size/colour; "shrink to fit width". Tag `/Folio:HeaderFooter`. | P0 |
| FR-EDT-13 | **Live preview** on up to 4 selected sample pages, including pages of different sizes/rotations; overflow indicator when a zone collides with page content bounds (uses `getPageContentBounds`, R4). | P0 |
| FR-EDT-14 | **Re-edit and remove**: Folio recognises its own watermark/header-footer sets by tag and opens them in the dialog pre-filled; "Remove" deletes exactly those objects. Foreign watermarks are detected heuristically (large semi-transparent repeated text/image) and offered as "Remove similar" with a preview. | P1 |
| FR-EDT-15 | **Presets**: save/load watermark and header/footer sets (SQLite); usable from the batch queue as operations (R4 registry). | P1 |
| FR-EDT-16 | **Unicode and fonts**: only embedded subset of bundled OFL fonts; text with glyphs missing from the chosen font falls back per-script to Noto with a notice; RTL text shaped by the engine (simple run, no complex shaping beyond what the font supplies — limitation stated). | P1 |
| FR-EDT-17 | **Accessibility metadata**: furniture is marked as **Artifact** (pagination/header/footer, watermark) in tagged files so screen readers skip it. | P1 |
| FR-EDT-18 | **Bates-style numbering** (single document): prefix, suffix, start, digits, zone; offered as a preset of FR-EDT-12. | P1 |

### 3.2 Find & replace (SPEC FR-EDT-09)

| ID | Requirement | Pri |
|---|---|---|
| FR-EDT-09 | **Replace across document** using FR-EDT-02 rules for each hit; **preview list** (page, context, state: *clean* / *font substituted* / *overflow* / *not editable*), per-hit accept; "Replace all clean", "Replace selected". | P0 |
| FR-EDT-19 | **Matching**: case, whole word, regular expression (JS regex, with capture group references `$1`), accent-insensitive option, search across line breaks **off** in R5 (hits must lie in one run/line — stated limitation); hyphenated line ends optionally joined for search only. | P1 |
| FR-EDT-20 | **Substitution policy**: default skips hits that would require a different font ("Skip needs substitution" checked); "Allow substitution" shows font name used per hit before commit. Never silently change a whole paragraph's look. | P0 |
| FR-EDT-21 | **Scope**: current page, selection, whole document; includes/excludes annotations (FreeText) and form field values (as separate toggles that use their own APIs). | P1 |
| FR-EDT-22 | **OCR interplay**: hits in OCR text layers are replaced in the hidden layer; option "also cover & retype visible scan text" is **off** and shown only per hit (expensive, lossy). | P1 |

### 3.3 Outline and links

| ID | Requirement | Pri |
|---|---|---|
| FR-EDT-11 | **Outline editor** (sidebar "Outline" becomes editable via an *Edit* toggle): add (at current page/position), rename (F2), delete, indent/outdent, drag to reorder/reparent, set target (page + position or URL), expand/collapse state `Open`, style (bold, italic, colour). Undoable commands; bulk **"Generate from headings"** (font-size/weight heuristics on text layer with preview) and **"Generate from page labels"**. | P0 |
| FR-EDT-23 | **Link editor**: list links per page; create rectangle links (to page + zoom/position, URL, named destination, file path only after explicit confirmation), edit target, border style (none/thin, colour), delete; auto-link detection of URLs/emails in text with review ("Make links clickable"). | P0 |
| FR-ANN-10 | Link creation (R1) shares the same dialog and appears in the list. | P0 |
| FR-EDT-24 | **Destinations**: named destinations list, rename/delete, "Copy link to this place" (internal `#nameddest`). | P1 |
| FR-EDT-25 | **Broken link check**: internal targets pointing to missing pages, empty URLs, local `file:` links; report with fix suggestions. External URLs are **not** fetched. | P1 |
| FR-EDT-26 | **Security**: Launch/JavaScript/SubmitForm actions on existing links are shown as "Unsupported action (disabled)" and can be deleted but never created or executed (FR-SEC-05). | P0 |
| FR-EDT-27 | **Outline after structural edits**: reorder/delete/insert pages keep outline targets consistent (R1 behaviour) — now verified by property tests and visible as "target removed" warnings in the editor. | P0 |

### 3.4 Freehand ink

| ID | Requirement | Pri |
|---|---|---|
| FR-ANN-05 | **Pen** and **highlighter** tools: Pointer Events (mouse, touch, stylus) with pressure and tilt when available; smoothing slider (Catmull-Rom/Chaikin on resampled points, simplified with Ramer–Douglas–Peucker for file size); stroke width 0.5–24 pt; colour palette shared with markup; opacity; highlighter uses Multiply blend. Strokes become standard `Ink` annotations with appearance streams (width variation baked in the AP when pressure is used). | P0 |
| FR-ANN-12 | **Eraser**: stroke eraser (deletes whole ink annotation under pointer) and optional **pixel/segment eraser** splitting strokes — segment mode behind a toggle, implemented as geometric splitting of the polyline. | P1 |
| FR-ANN-13 | **Groups**: strokes drawn within 1.5 s and 40 pt of each other are grouped into a single `Ink` annotation with multiple `InkList` paths (keeps annotation count manageable); "Ungroup". | P1 |
| FR-ANN-14 | **Select/move/resize/recolour** like other annotations; palm rejection toggle for touch+stylus devices. | P1 |
| FR-ANN-15 | **Shape snapping** (hold a pause to snap to line/ellipse/rectangle) — optional, off by default. | P2 (stretch) |

### 3.5 Permanent crop

| ID | Requirement | Pri |
|---|---|---|
| FR-ORG-11b | **Trim content permanently**: after crop, an action removes page objects wholly outside the crop box, clips partially overlapping vector/text/images (image data cropped, text objects partially outside either removed or clipped depending on a toggle), sets MediaBox = CropBox, offsets coordinates, and reports bytes saved. A warning explains that the action is irreversible after save. | P1 |

## 4. UX specification highlights

- **"Insert" menu** gains **Watermark…** and **Header & footer…**; both open a right-side inspector panel (not a modal) with the live canvas preview on the page; Apply/Cancel at bottom; keyboard: Enter applies.
- **Header & footer** panel layout mirrors the page: a 3×2 grid of text fields (left/centre/right × header/footer), token chips ("+ Page", "+ Date") insert tokens at the caret; font/size/colour row; page range row; "Preview on pages: 1 · 2 · n-1 · n".
- **Find & replace** extends the Find bar (Mod+F) with a *Replace* toggle (Mod+H); results appear as list in the sidebar tab "Search" with state badges; a banner states the limitations: "Replacement works within a single line".
- **Outline editor**: inline rename, drag handles, context menu, toolbar (add, indent, outdent, delete); target preview on hover as thumbnail.
- **Link tool** (shortcut `K`): rectangle drag → popover with Page / URL / Named destination.
- **Pen tool group** in the main toolbar next to Shape: Pen (P), Highlighter (Shift+H), Eraser (Shift+E); a compact property bar floats near the pointer with width, colour and smoothing.
- **Dark/light**: previews render with page background; ink colour defaults adapt to dark page mode only visually, never altering stored colour.

## 5. Technical design

### 5.1 Page furniture engine

- `PageFurnitureService` computes, per page, a **render plan**: list of text/image objects with matrices based on the anchor model from R4 (`anchor`, `offset`, rotation, **page rotation and CropBox aware**), token expansion, number formatting, and bounds. The plan is a pure function → exhaustive unit tests.
- Engine writes through existing `addText`, `addImage`, `transformObject` with an additional `opts: { tag, opacity, blend, layer: 'over'|'under' }`. "Under content" is implemented by inserting objects at the start of the content stream (`FPDFPage_InsertObjectAtIndex` or equivalent in the adapter); needs verification in spike S11.
- Tag and removal: the engine port gains `listObjectsByTag(i, tag)` / `removeObjectsByTag`. Because PDFium page objects have no persistent ID across save, tags are written as marked-content (`BDC /Folio:Watermark <</Set "uuid">>`) so re-opened files can be recognised. Spike checks `FPDFPageObj_AddMark*`/`GetMark*` availability.
- Fonts: text furniture embeds the bundled font subset **once per document** (shared resource) to avoid per-page duplicates; verified through file size tests (500 pages × footer must add < 40 KB beyond text).

### 5.2 Replace engine

1. `search` (R1) yields hits with run ids (`objId`, char range).
2. Hits are grouped by editable line (the unit from `getTextLayer`).
3. For each line, build the new string and call `replaceTextRun` in **dry-run mode** (new `TextEditResult` prediction: `fontReused|substituted|overflow|missingGlyph`) — port addition `previewReplaceTextRun`.
4. Commit uses a `CompositeCommand`; one checkpoint (structural content kind) for the batch; undo restores in one step.
5. Regex mode runs on the concatenated line text; capture groups; guard against catastrophic backtracking (time/size bounded, RE2-style subset documented; use `safe-regex`-style check or a worker with timeout).

### 5.3 Outline and links

- Outline API exists (`getOutline`, `setOutline`, EPDF bookmark functions). Editor holds a **pure tree model** in `@folio/core` (nodes with stable ids, operations, invariants) producing the full `setOutline` payload; commit as one command with the previous tree as inverse (cheap).
- Heading detection uses the text layer: font size > body median × 1.15, bold or distinct font, line shorter than 100 chars, followed by larger gap; configurable; preview before accept. Language agnostic.
- Links: `getLinks` exists; add `upsertLink`/`removeLink` (Link annotations with `/A` or `/Dest`, `/Border [0 0 0]` default). Named destinations through `EPDFNamedDest_*` (present in build).
- URL auto-detection runs on text layer with a conservative regex and TLD list; creates links only on user accept.

### 5.4 Ink

- `Annotation` union already has `ink`; add `InkStroke { points: {x,y,p?}[], width }[]`, `blend`.
- **Appearance stream generation** (adapter) draws each stroke as a stroked path with round caps, or as a filled variable-width polygon when pressure varies; highlighter AP uses `/BM /Multiply` in ExtGState; interop matrix (spike S2 matrix extended) with Acrobat, Preview, Okular, Chrome, pdf.js — variable-width fidelity may degrade to constant width in viewers that rebuild AP themselves (document).
- Input pipeline in `apps/web`: coalesced pointer events (`getCoalescedEvents`) → local canvas overlay for latency (< 16 ms) → on pointer-up, `core` smoothing + simplification → single `AddAnnotation` command (merging of rapid strokes per FR-ANN-13 via `Command.merge`).
- Eraser hit-testing in `core` using distance-to-polyline with stroke width.

### 5.5 Permanent crop
Engine-side: for each page object compute bounds (already available via `listObjects`); remove fully outside; image partially outside → crop pixel data via `replaceImage` (`getImage` exists) after lossless decode (JPEG partial crop re-encodes — warn); text partially outside → remove object (default) or clip with a clipping path; set boxes. Reuses R3's image recompression helper for re-encoding.

### 5.6 Data model — migration `0005_compose.sql`

```sql
CREATE TABLE furniture_presets (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('watermark','headerfooter')),
                                name TEXT NOT NULL, spec_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE replace_history (id TEXT PRIMARY KEY, find TEXT NOT NULL, replace TEXT NOT NULL, options_json TEXT NOT NULL, used_at TEXT NOT NULL);
```
`replace_history` stores **search strings the user typed**; there is a setting to disable it, and it is cleared with "Clear history". Document text is never stored.

## 6. Non-functional requirements (additions)

| ID | Requirement |
|---|---|
| NFR-R5-01 | Apply header/footer + watermark to 500 pages ≤ 5 s; added file size ≤ 40 KB + image size once. |
| NFR-R5-02 | Replace preview over a 300-page document ≤ 2 s; commit ≤ 300 ms per replaced line (NFR-04). |
| NFR-R5-03 | Ink latency ≤ 16 ms (pointer-to-ink on overlay), file size ≤ 2 KB per typical stroke after simplification. |
| NFR-R5-04 | Outline edit operations ≤ 50 ms on 5 000 nodes (tree model purity, virtualised list). |
| NFR-R5-05 | Furniture, replace and ink round-trip in Acrobat, Preview, Okular, Chrome and pdf.js with visual parity (manual matrix + `pdftoppm` automatic). |

## 7. Testing strategy

| Level | What |
|---|---|
| Unit | Token expansion, number styles (roman edge cases), anchor math with rotated pages and CropBox offsets, overflow detection, regex safety guard, replace planning, outline tree ops (property: apply+undo = identity, no cycles), heading detector, simplification (RDP error bound), smoothing continuity, eraser hit-test. |
| Conformance | Mark/tag round-trips, `removeObjectsByTag` removes exactly the set, ExtGState opacity and blend preserved, `previewReplaceTextRun` equals real replace outcome, ink AP renders (golden image tolerance), link upsert/remove, named destinations. |
| Interop/oracles | `qpdf --check`, `pdfcpu validate`, `mutool` render, `pdftotext` (furniture text present in order; watermark text optional-to-extract setting), `pdftoppm` golden images for furniture on 6 page sizes/rotations. |
| Corpus | The 50-PDF text edit corpus from S3 re-used for replace (success rate gate ≥ 90 % clean hits). |
| e2e | Watermark flow, header/footer live preview, replace flow with skip/accept, outline drag/drop and keyboard, link tool, pen/highlighter/eraser with synthetic pointer events (including pressure). |
| Manual | Real stylus on Linux/Windows/macOS; screen reader on outline editor; printing with watermark. |

## 8. Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| R5-1 | "Under content" insertion unsupported in the adapter | Spike S11; fallback: draw over content with Multiply blend for text watermarks, or re-emit content stream via `snapshot` + pdf-lib only for that op |
| R5-2 | Replace changes glyph widths and breaks layout | Overflow hints (FR-EDT-04), skip substitution default, shrink-to-fit option, preview |
| R5-3 | Ink looks different in other viewers | AP always generated by adapter; constant-width fallback; documented |
| R5-4 | Heading detection quality varies | Always preview, never auto-apply |
| R5-5 | Regex performance and safety | Worker timeout + bounded match counts |
| R5-6 | Permanent crop + signed docs | Blocked with FR-APP-11 style message |

**Open questions**
1. Should furniture default to **"under content"** (watermark) with an "over" toggle (proposed)?
2. Page numbering **across several files** (Bates continuation) — keep in batch horizon or add `{n}` start offset parameter now (proposed: offset parameter only)?
3. Regex replace: expose to all users or behind "Advanced"? (Proposed: behind "Advanced".)
4. Is a stretch goal for shape snapping (FR-ANN-15) wanted?

## 9. Delivery plan

| Phase | Goal | Exit gate |
|---|---|---|
| R5-P0 | Spikes S11 (z-order insert + marked content tags), S12 (ink AP interop), S13 (replace dry-run); ADRs 0014–0016 | ADRs |
| R5-P1 | Ports, pure planners, fixtures | Unit green |
| R5-P2 | Engine adapters: tags, furniture, ink AP, link upsert, dry-run replace | Conformance + oracles |
| R5-P3 | Services: PageFurniture, Replace, OutlineEditor, LinkEditor, Ink, PermanentCrop; batch operations registered | FR tests green |
| R5-P4 | App layer and keymap entries | Epics E18–E21 |
| R5-P5 | UI + Italian strings | e2e + axe |
| R5-P6 | Hardening and release | `tools/gate.sh R5` |

## 10. Horizon

Multi-file Bates continuation, background/template pages, stamps with dynamic data from forms (§17.5), paragraph-level edit (needs layout engine), comment threads, ink-to-text, shape recognition, text-box wrapping across objects.

## 11. Research notes and sources

- Header/footer, watermark and numbering are classic features of the commercial editors listed in SPEC §2.2 (Acrobat/Foxit "Edit → Header & Footer / Watermark / Bates").
- PDFium marked-content and page-object APIs (`FPDFPageObj_*Mark*`) and the EPDF extension set are present in the pinned build (typings inspected locally); availability of each function for the operations above is **to be verified in spike S11**, not assumed.
- Outline and named destination writing is already supported in the pinned build (`EPDFBookmark_*`, `EPDFNamedDest_*`), and `setOutline` is implemented in `packages/engine-pdfium/src/document.ts`.
