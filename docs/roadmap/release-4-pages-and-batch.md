# Folio Release 4 — "Pages & Batch" (v4.0)

| | |
|---|---|
| **Status** | Draft specification for review |
| **Date** | 2026-10-12 |
| **Builds on** | Release 3 (compress, protect, redact) |
| **Roadmap** | [ROADMAP.md](ROADMAP.md) |

## 1. Purpose and outcome

Release 1 covers the everyday page tasks (reorder, rotate, delete, insert, extract, merge, split). Release 4 completes the **document-assembly toolbox** and makes repeated work cheap:

- the remaining page operations (crop, reverse, interleave, resize, N-up, page labels);
- the remaining split modes (by bookmarks, by size, odd/even);
- **apply a signature, initials or stamp to many pages in one step**, and move the signature library between machines;
- a **batch queue** (many files × one operation or a short pipeline), available in the GUI and in `folio-cli`;
- viewer comfort: presentation mode and remappable shortcuts;
- closing the known gap "Merge: unify page size" from `docs/PROGRESS.md`.

**Success looks like:** Luca scans a two-sided stack in two passes, interleaves fronts and backs, crops margins on all pages, and splits by chapter bookmarks into files named `{n}-{title}.pdf`. Marta initials every page of a 40-page lease in two clicks. Giulia drops 30 invoices on the batch queue and runs "Flatten → Compress → Rename" overnight-style while she works.

### 1.1 In scope

| Track | Feature | IDs |
|---|---|---|
| A. Page tools | Crop (non-destructive CropBox), reverse, interleave, resize/scale, N-up, page labels (read), unify page size on merge | FR-ORG-11…14, FR-MRG-02 (gap) |
| B. Split | By bookmarks, by size, odd/even extraction | FR-MRG-04 (rest) |
| C. Stamps | Apply to multiple pages with live preview; library import/export | FR-STM-04, FR-STM-11 |
| D. Batch | Batch queue GUI + CLI pipelines, job persistence, result report | FR-MRG-07 (+ FR-MRG-08…12) |
| E. Viewer/UX | Presentation mode, remappable shortcuts | FR-VIEW-10, §7.6, §17.5 partial |

### 1.2 Out of scope

Watched-folder automation and scheduled jobs (SPEC §17.5 horizon, prepared by the queue design), scripting API/plugins, Action-Wizard-style custom workflow designer (R4 ships a fixed list of operations in a linear pipeline), page-label **editing** (read only per FR-ORG-13; editing is horizon), "trim content permanently" crop (R5, needs content clipping).

## 2. Scenarios

| # | Scenario | Persona |
|---|---|---|
| S1 | Open `fronts.pdf` (20 pages), pick "Interleave with…" `backs.pdf` (20 pages, reversed scan order) → option "reverse backs", preview, apply → 40 pages in correct order. | Luca |
| S2 | Crop: draw a rectangle on page 1, "Apply to all odd pages / all pages / selection", numeric margins in mm; undo. | Luca |
| S3 | Resize all pages to A4 with "fit/ fill / centre" and a margin; N-up 2×1 landscape with gutter and borders for handouts. | Giulia |
| S4 | Split by top-level bookmarks into files; names from titles; conflict handling; preview lists 9 files with page ranges. | Luca |
| S5 | Split a 180 MB scan into parts ≤ 25 MB each (email limit); the plan shows 8 files with real sizes after execution. | Marta |
| S6 | Pick the saved "JD initials", choose "Every page except first, bottom-right", watch ghost previews on thumbnails, apply as one undoable step. | Marta |
| S7 | Export signature library to `folio-signatures.folio-lib`, import it on another machine; encrypted entries require the passphrase. | Paolo |
| S8 | Add 30 files to the batch queue, choose **Flatten forms → Compress (Balanced) → Save in folder**, run, see per-file result and a summary; one failed file is retried. | Giulia |
| S9 | Press F5 → presentation mode: arrow keys, laser pointer, blank screen B, Esc exits. | Luca |
| S10 | Rebind "Highlight" from H to Y, see conflict warning if Y is taken, export/import keymap JSON. | Paolo |

## 3. Functional requirements

### 3.1 Page tools (SPEC §6.3 extended)

| ID | Requirement | Pri |
|---|---|---|
| FR-ORG-11 | **Crop**: interactive rectangle on one page (handles, numeric fields in unit of settings, aspect presets), apply to selection / all / odd / even / range; sets `CropBox` (non-destructive). "Reset crop" restores `MediaBox`. Auto-detect margins ("Trim whitespace") computed from rendered page content bounds with padding. Pages with different sizes keep per-page rect semantics: **absolute** or **relative to page** option. | P0 |
| FR-ORG-12 | **Reverse order** of selection or document; **Interleave** two files or two page groups (a1,b1,a2,b2…; option "reverse second group" for double-sided scans; handles unequal counts with report); **Odd/even helpers**: select odd/even, rotate odd only. | P0 |
| FR-ORG-13 | **Page labels**: display labels (i, ii, 1, 2, A-1) from `/PageLabels` in thumbnails, page box, goto page and search results ("page iv (4)"); toggle "show labels / show indices". Read-only. | P1 |
| FR-ORG-14 | **Resize/scale**: target paper size (A-series, Letter, Legal, custom), orientation, mode (fit, fill, stretch-off, centre, no-scale), margins, scope (selection/all). **N-up**: 2, 4, 6, 9 per sheet and custom grid, order (row-major/column-major, RTL), spacing, border, rotate-to-fit, output paper size. New document by default, option "replace pages" with undo checkpoint. | P1 |
| FR-ORG-15 | **Insert page numbers area guard**: pages with CropBox ≠ MediaBox show an indicator and a quick "Reset crop". | P1 |
| FR-MRG-02a | **Unify page size on merge** (removes the Release 1 gap): reuses FR-ORG-14 scale engine; options per above; off by default. | P0 |

### 3.2 Split

| ID | Requirement | Pri |
|---|---|---|
| FR-MRG-04b | **By bookmarks**: choose outline level (1..n); nodes with the same target page merge; pages before first bookmark → file "front matter" (option); naming tokens add `{title}`, `{level}`; titles sanitised for the filesystem per OS rules (reserved names on Windows, length). Preview tree with page ranges before running. | P0 |
| FR-MRG-04c | **By size**: target max size (MB); algorithm in §5.2; shows planned files and estimated sizes, final sizes after write; never splits inside a page; warns when a single page exceeds the limit. | P1 |
| FR-MRG-04d | **Odd/even extraction**: produce one file of odd pages and/or one of even pages. | P1 |
| FR-MRG-05b | Naming tokens: `{title}`, `{label}` (page label of first page), `{date}`, `{index:03}`; invalid or duplicate names auto-resolve with a visible diff. | P1 |

### 3.3 Stamps and signature library

| ID | Requirement | Pri |
|---|---|---|
| FR-STM-04 | **Apply to multiple pages**: scope = current, all, range ("1,3,5-7"), odd/even, "all except first/last"; **position-matched** to the placed object relative to the page *corner/edge anchors* (default bottom-right) so differently-sized pages stay consistent; live preview ghosts in thumbnails; each page gets its own annotation (editable, deletable individually); result is one `CompositeCommand`. | P0 |
| FR-STM-13 | **Variants per page**: tokens for stamps/text stamps (`{page}`, `{pages}`, `{date}`), so "Page 3 of 40" and a dated "REVIEWED" stamp are possible without waiting for headers/footers (R5). | P1 |
| FR-STM-11 | **Library import/export**: `.folio-lib` (ZIP with `manifest.json`, `signatures/*.png|svg`, `stamps/*`; schema-versioned). Options: include signatures, initials, stamps; merge or replace on import with conflict list (same id/name). Entries encrypted at rest (FR-STM-10) are exported **only** re-encrypted with a user-chosen passphrase (AES-GCM + PBKDF2, same `CryptoService`) — never in plaintext unless the user explicitly unchecks "protect" and confirms. | P1 |
| FR-STM-14 | **Provenance note** on import: shows count, names, and size; blocks files with unknown schema versions and oversize images (> 2 MB per entry). | P1 |

### 3.4 Batch queue

| ID | Requirement | Pri |
|---|---|---|
| FR-MRG-07 | **Batch queue**: add files (dialog, drop, folder with optional recursive, glob in CLI), choose an **operation list** (pipeline, run in order per file) from: rotate pages, delete pages by range, extract range, flatten (annotations/forms), compress (preset), protect/remove password, metadata set/clear, export images, OCR, add stamp/signature to pages, crop/resize/N-up, split. Run with concurrency N (default 2), progress per job, cancel, retry failed. | P0 |
| FR-MRG-08 | **Output rules**: folder + naming template (`{name}`, `{n}`, `{date}`, suffix), conflict policy (ask once/auto-number/overwrite-with-confirm), "never overwrite originals" default. | P0 |
| FR-MRG-09 | **Presets**: save a pipeline as a named preset (SQLite), export/import JSON; presets appear in the command palette and Home. | P1 |
| FR-MRG-10 | **Result report**: per file status (ok / skipped / failed + typed reason), size before/after, duration; "Copy report", "Reveal output"; optional text/CSV export. | P0 |
| FR-MRG-11 | **Safety**: password-protected inputs prompt once per file (never stored); signed documents are skipped with reason unless the operation is read-only; destructive operations (redact) are not allowed in batch in R4. | P0 |
| FR-MRG-12 | **CLI parity**: `folio-cli batch --preset name | --ops "compress:balanced,flatten:forms" --in dir --out dir --jobs 4 --report report.json`; exit codes (0 ok, 1 partial, 2 failure); stable JSON output; no network. | P1 |

### 3.5 Viewer and shortcuts

| ID | Requirement | Pri |
|---|---|---|
| FR-VIEW-10 | **Presentation mode**: full-screen, single page fit, next/prev (arrows, PgUp/PgDn, Space, click, wheel), go to page, **blank/black** screen (B/W), **laser pointer** (hold L or toggle), auto-hide cursor, optional auto-advance interval, Esc exits; multi-monitor: uses current display. Disables editing tools and annotations UI; shows annotations as rendered. Prevents OS sleep during presentation where the platform allows. | P1 |
| FR-APP-21 | **Remappable shortcuts**: Settings → Keyboard: searchable list of all commands with current binding, record new chord, conflict detection with reassign/cancel, reset one/all, import/export JSON; layout-aware (use `KeyboardEvent.key` + code fallback so AZERTY/QWERTZ work); reserved system keys protected; palette shows the current binding. | P1 |

## 4. UX specification highlights

- **Organise view toolbar** grows a **"Pages ▾"** menu grouping crop/reverse/interleave/resize/N-up so the primary toolbar stays at ~8 tools (principle 4). Each operation opens an inline **preview panel** (before/after thumbnails of the first 4 affected pages) rather than a modal.
- **Crop** is also a tool on the main page: drag rectangle, Enter applies, Esc cancels; the area outside is dimmed. Numeric panel uses document units.
- **Interleave** is a two-column dialog: left group, right group, middle preview of resulting order with page numbers; shortcuts to reverse either group.
- **Split wizard** gets a third mode selector row (ranges / every N / each page / **bookmarks / size / odd-even**) and keeps the single preview table (FR-MRG-06).
- **Multi-page stamp**: after placing the object, a floating bar "Apply to: [This page ▾] [Apply]". The bar remembers the last scope per stamp type.
- **Batch queue** is a full-height view reached from Home tile "Batch": left file list (thumbnail of first page, pages, size, status), right pipeline builder (reorderable steps with parameters), bottom status. Keyboard: Del removes, Alt+arrows reorder.
- **Presentation mode** has no chrome; a 2-second hint "Esc to exit · ← → to move" on entry.
- Every new action is in the command palette; every new destructive replace-in-place has undo.

## 5. Technical design

### 5.1 Engine and geometry

| Feature | Engine support | Notes |
|---|---|---|
| Crop | `FPDFPage_SetCropBox` (present in the pinned build) → port `PdfDocument.setCropBox(i, box)` (already declared in SPEC §8.5, absent in code) | Geometry helpers in `@folio/core` convert UI rect (view space, rotation-aware) to PDF user space; CropBox must be clamped to MediaBox; tests for rotation 0/90/180/270 and non-zero origins |
| Reverse / interleave | `movePages`/`importPages` | Pure planning function `planInterleave(a, b, opts)` in core; service executes |
| Resize / N-up | `FPDF_ImportNPagesToOne` is experimental in PDFium; scaling single pages needs form-XObject wrapping (`FPDF_NewXObjectFromPage`) and a transform | `PageLayoutService` builds new page content = XObject placement with matrix; N-up via the same primitive (don't rely on the experimental call) so annotations and links can be remapped |
| Page labels | `FPDF_GetPageLabel` | Read-only; cached per document |
| Split by bookmarks | `getOutline()` (exists) | Planner flattens tree to ranges |
| Split by size | `save()` of candidate ranges | See §5.2 |
| Annotations on scaled pages | — | Annotation rects and link rects are transformed with the page matrix; form fields keep names; fields on N-up duplicates get renamed (reuse merge's collision renaming) |

New port members (additive): `setCropBox`, `getPageLabels`, `placePageAsXObject` (internal to engine for layout), `getPageContentBounds(i)` (for trim whitespace; may be implemented in service via render).

### 5.2 Split by size algorithm
1. Estimate per-page weight: size of page's referenced objects not shared (images/fonts) via engine analysis (`analyzeImages` from R3 + stream sizes); shared resources (fonts) are charged once per output file.
2. Greedy accumulation to limit L; then **measure** by actually saving each planned file; if a file exceeds L, move its last page to the next file and re-measure (max iterations bound).
3. Report planned vs actual; if the minimum possible (a single page) > L, warn and emit that page alone.
Complexity bounded by `pages × log(pages)` saves in the worst case; runs in the worker; cancelable.

### 5.3 Batch queue architecture (`packages/services/src/batch.ts`)

```ts
interface BatchOperation { id: string; kind: BatchOpKind; params: unknown; /* zod-validated */ }
interface BatchJob { id: string; input: FileRef; ops: BatchOperation[]; output: OutputRule; state: 'queued'|'running'|'done'|'failed'|'skipped'|'cancelled'; result?: BatchResult; error?: TypedError }
interface BatchRunner { enqueue(jobs: BatchJob[]): void; start(opts: { concurrency: number }): void; cancel(id?: string): void; on(cb): Unsubscribe; }
```
- Each job opens its own `PdfDocument` (no tabs/UI session), applies operations **through the same services as the UI** (no duplicated logic) using a headless `DocumentSession` without the history budget, saves to a temp file and atomically moves to the output rule.
- Concurrency uses the worker pool; memory budget manager refuses to start a job when the estimated size × factor exceeds the remaining cache cap.
- The queue state is persisted (SQLite `batch_jobs`) so a crash or restart offers "Resume 12 pending jobs"; completed output paths are kept for the report only.
- The runner is UI-agnostic and is also what `folio-cli batch` uses; CLI and GUI share operation schemas (zod) and tests.
- Operation registry is declarative: adding an operation in later releases means registering `{kind, schema, run, label}`; R5/R6 operations (watermark, XFDF import) plug in here.

### 5.4 Multi-page stamping
`StampService.applyToPages(spec, scope)` computes per-page rect from an **anchor model**: `{ anchor: 'bl'|'bc'|'br'|'ml'|'mc'|'mr'|'tl'|'tc'|'tr', offset: {dx, dy} in points, size, rotation }` relative to the page's CropBox after rotation. Tokens are expanded per page. Creates `Stamp` annotations (or page content when "flatten" is selected). Memory: one appearance stream shared by all instances when possible (engine API `cloneAnnotationAppearance`), keeps file size small.

### 5.5 Library file format
```
folio-signatures.folio-lib   (ZIP, deflate)
 ├─ manifest.json   { schema: 1, app: "folio", version, created, encrypted: bool, kdf: {salt, iterations}, items: [...] }
 ├─ items/<id>.png (or .bin when encrypted: iv||ciphertext||tag)
 └─ items/<id>.svg (optional)
```
Parser validates schema with Zod, limits entries (≤ 500), per-entry size, rejects path traversal, and never executes content. Import is an `Import` command in the repository layer (transactional).

### 5.6 Presentation and shortcuts
- `WindowService.setFullscreen` exists; add `Platform.power?.keepAwake(bool)` (Wake Lock API on web; Rust/OS inhibitors on desktop).
- Keymap: `packages/app/src/keymap.ts` already defines defaults; add `KeymapStore` (SQLite `settings.keymap`), validation, conflict resolver, and migration of defaults between versions (new default shortcuts never override user bindings).

### 5.7 Data model — migration `0004_batch_keymap.sql`

```sql
CREATE TABLE batch_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, ops_json TEXT NOT NULL, output_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE batch_jobs   (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, input_path TEXT, input_name TEXT NOT NULL, ops_json TEXT NOT NULL,
                           output_json TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, bytes_in INTEGER, bytes_out INTEGER, updated_at TEXT NOT NULL);
CREATE INDEX idx_batch_state ON batch_jobs(batch_id, state);
```
Keymap and last scope per stamp type live in `settings`.

## 6. Non-functional requirements (additions)

| ID | Requirement |
|---|---|
| NFR-R4-01 | Crop/reverse/rotate-type ops on 500 pages ≤ 1.5 s; resize/N-up ≤ 20 ms/page. |
| NFR-R4-02 | Batch: 100 small PDFs (≤ 1 MB) Flatten→Compress in ≤ 90 s on reference laptop with concurrency 3; peak memory ≤ 1 GB. |
| NFR-R4-03 | Split by size: actual files ≤ L in 100 % of non-degenerate cases; plan time ≤ 10 s for 1000 pages. |
| NFR-R4-04 | Presentation mode: page change ≤ 100 ms with pre-rendered next page; 60 fps cursor/laser. |
| NFR-R4-05 | Library import never blocks UI > 100 ms (chunked) and is atomic. |

## 7. Testing strategy

| Level | What |
|---|---|
| Unit | Interleave/reverse planners (unequal counts), split-by-bookmark planner (nested, duplicates, no outline, out-of-range dests), split-by-size greedy, anchor math with rotation and CropBox offsets, N-up grid ordering, filename sanitiser per OS, keymap conflict resolver, library schema validation. |
| Conformance | `setCropBox` round-trip, `getPageLabels` against fixtures with roman/prefix ranges, page placement matrix correctness (pixel comparison of scaled page vs expected render), annotations/links remapping. |
| Property | Batch idempotence for lossless ops; "crop then reset" returns identical page boxes; interleave∘split(odd/even) = identity. |
| Oracle | `qpdf --check`, `pdfcpu validate`, `pdfcpu boxes list`, `pdftoppm` vs reference render, `mutool pages`. |
| e2e | Organise ops with previews; split wizard modes; stamp multi-page; batch queue with injected failure/retry; presentation keyboard; rebind shortcut and reload. |
| CLI | Golden-output tests of `folio-cli batch` JSON report, exit codes. |
| Manual | Open N-up and cropped outputs in Acrobat/Preview/Okular; printing of N-up. |

New builders: `twoSidedScan(front,back)`, `bookmarkedBook`, `mixedPageSizes`, `labelledPages`, `cropBoxOffset`, `rotatedPagesWithAnnots`, `hugeImagePages` (for size split).

## 8. Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| R4-1 | Scaling pages breaks annotations, links or fields | Transform pipeline with oracles; warn when a feature (e.g. form JS) cannot be remapped; test corpus |
| R4-2 | Experimental PDFium N-up semantics change | Use own XObject-based layout; keep upstream call only as cross-check |
| R4-3 | Batch memory spikes | Memory budget manager, concurrency auto-throttle, per-job isolation |
| R4-4 | Scope creep into workflow engine | Linear pipeline only; operation registry is the only extension point |
| R4-5 | Shortcut remapping on non-US layouts | Use `key` + `code`, tests on AZERTY/QWERTZ fixtures |
| R4-6 | Breadth (≈ 25 requirements) | Quick wins sliced into 3 milestones: 4.0-alpha (A,B), 4.0-beta (C,E), 4.0 (D) |

**Open questions**
1. Should batch accept *redaction* with a prepared mark set? (Proposed: no, R3 rationale.)
2. Is the `.folio-lib` format acceptable as the future stamp-sharing format (SPEC §17.5 notes "import/export of the library only")?
3. Page-label **editing** in this release (small) or later?
4. Presentation-mode extras (notes, timer, dual-screen presenter view) — cut at "laser, blank, auto-advance" for R4?

## 9. Delivery plan

| Phase | Goal | Exit gate |
|---|---|---|
| R4-P0 | Spike S9: page layout via XObject (scale, N-up, annotation remap), S10: batch memory model; ADRs 0012–0013 | ADRs |
| R4-P1 | Ports + planners + fixtures | Unit green |
| R4-P2 | Engine adapters: crop, labels, layout | Conformance + oracles |
| R4-P3 | Services: PageLayout, Split extensions, StampMulti, LibraryTransfer, BatchRunner + CLI | FR tests green, CLI goldens |
| R4-P4 | App layer: view-models, keymap store, presentation controller | Epics E14–E17 headless |
| R4-P5 | UI + Italian strings | e2e + axe |
| R4-P6 | Hardening and release | `tools/gate.sh R4` |

## 10. Horizon

Watched folders and scheduled batch (queue + `Platform.watch` already shaped), custom pipeline designer, page-label editing, headers/footers via the same anchor model (R5), batch on native engine (R6), "Print booklet" imposition, duplex-aware printing helpers.

## 11. Research notes and sources

- PDFium page import/N-up API: `FPDF_ImportPagesByIndex`, `FPDF_ImportNPagesToOne` (marked experimental; builds a grid of source pages per output page with width/height and x/y counts), `FPDF_NewXObjectFromPage` (turns a page into a form XObject tied to the destination document lifetime). <https://pdfium.googlesource.com/pdfium/+/HEAD/public/fpdf_ppo.h>
- Pinned build exports `FPDFPage_SetCropBox`, `FPDF_GetPageLabel`, `FPDF_ImportNPagesToOne` (verified in installed typings of `@embedpdf/pdfium` 2.15.1).
- Interleaving, reverse and rotate odd/even are the standard fix for double-sided scans done in two passes (PDF Arranger/PDFsam-class tools) — see SPEC §2.1.
