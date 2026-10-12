# Folio Release 6 — "Forms & Scale" (v6.0)

| | |
|---|---|
| **Status** | Draft specification for review |
| **Date** | 2026-10-12 |
| **Builds on** | Release 5 (page furniture, link/outline editors), Release 4 (batch runner, operation registry) |
| **Roadmap** | [ROADMAP.md](ROADMAP.md) |

## 1. Purpose and outcome

Release 6 closes the deferred list. Two themes:

1. **Forms become a two-way street.** Folio fills forms (R1) and recognises fillable areas (R1); now it **creates and edits** them, checks spelling while typing, and exchanges form data in the standard FDF/XFDF formats other tools understand. Smart Fill gets its usage panel.
2. **Scale and offline.** A native Rust engine takes over files that the WASM engine cannot hold (SPEC NFR-06: > 500 MB / 5 000 pages) and heavy batch jobs; the web build becomes an installable offline PWA.

**Success looks like:** Giulia turns a Word-exported invoice template into a fillable PDF in five minutes — text fields with tab order, a dropdown for VAT rate, a checkbox group, a signature placeholder — and reopens it in Acrobat and Okular with all fields working. Paolo opens an 1.4 GB scanned archive in Folio on his desktop; it opens editable instead of read-only, and batch compression runs on the native engine.

### 1.1 In scope

| Track | Feature | IDs |
|---|---|---|
| A. Form authoring | Create/edit fields: text, multiline, comb, checkbox, radio group, dropdown, list box, push button (limited), signature placeholder; properties; tab order; alignment tools | FR-FRM-08 (+ FR-FRM-11…20) |
| B. Form data | Spell-check in text fields; FDF/XFDF/JSON import and export | FR-FRM-04, §17.3 basic (+ FR-FRM-21…24) |
| C. AI usage | Cost/usage panel from `ai_runs` | FR-AIF-11 |
| D. Native engine | `NativePdfEngine` (Rust, PDFium) behind the existing port, large-file mode, batch worker | §8.9, NFR-06 |
| E. Offline web | PWA: service worker, installability, update flow | §14 |

### 1.2 Out of scope

Form JavaScript (calculations, validation, formatting scripts): **never executed**, as in SPEC §17.3; formatting actions written by other tools are preserved but inert, and simple known formats are interpreted for display (FR-FRM-03). XFA. Form distribution/collection/server submission. Conditional visibility and calculation-order designer. Digital signature fields that sign (placeholders only; no certificate signing). Mobile apps.

## 2. Scenarios

| # | Scenario | Persona |
|---|---|---|
| S1 | From a non-fillable form, run "Detect fillable areas" (R1), then "Convert all suggestions to fields"; fix names; set tab order by reading order. | Giulia |
| S2 | Draw a text field, set name `client_name`, tooltip, required, font 11 pt, max length 40, alignment right; duplicate across 5 rows with Ctrl+D and "increment name". | Giulia |
| S3 | Create a radio group "payment" with three options, export values `cash`, `card`, `bank`; save; fill it in Okular. | Marta |
| S4 | Export field data as XFDF; import it on a copy of the same form to fill 40 fields. | Marta |
| S5 | Type "recieve" in a text field: red squiggle, right-click → "receive". | Luca |
| S6 | Open a 1.4 GB scan archive: banner "Large file mode (native engine)"; scrolling, search, rotate pages, save work. | Paolo |
| S7 | Install the PWA from the browser, go offline, open a PDF, edit, save (download). | Paolo |
| S8 | Open Settings → AI → Usage: 38 runs this month, 41 k tokens, per model; "Clear usage history". | Marta |

## 3. Functional requirements

### 3.1 Form authoring (SPEC FR-FRM-08 expanded)

| ID | Requirement | Pri |
|---|---|---|
| FR-FRM-08 | **Create field** tools: text, multi-line text, comb, checkbox, radio (group), dropdown (combo, editable option), list box (single/multi), push button (label only, no actions), signature placeholder. Draw rectangle → field; fields are standard AcroForm widgets with appearance streams and `/DA`. | P0 |
| FR-FRM-11 | **Properties panel**: name (unique, validated, hierarchical with `.`), tooltip (`TU`), default value, required, read-only, hidden, print visibility, max length, comb cells, multiline, scroll, password flag (text), options list (label/export value), checkbox/radio export values and style (check, circle, cross, square, star), border colour/width/style, background, text colour, font (bundled set; embedded in `DR`), size or auto, alignment, rotation (0/90/180/270). | P0 |
| FR-FRM-12 | **Selection and layout**: select multiple fields, align, distribute, same size/width/height, snap to guides and page content boxes (reuse FR-ANN-06 helpers), nudge with arrows, lock position. | P1 |
| FR-FRM-13 | **Tab order**: by row, by column, by structure, or manual list drag; shown as numbered badges; stored in `/Tabs` and widget order (`/Annots`). | P1 |
| FR-FRM-14 | **Duplicate/multi-place**: copy fields to other pages at the same anchor (R4 model); auto-rename with numeric suffix pattern; radio groups keep one group name. | P1 |
| FR-FRM-15 | **Convert from detection**: transform R1 "fillable area" ghosts (FR-FRM-07) in bulk into real fields with inferred names from nearby labels (heuristic mapper reused from Smart Fill; user can accept per field). | P1 |
| FR-FRM-16 | **Edit existing fields** of any AcroForm (rename, move, resize, change type where compatible, delete); renaming updates dependent references (`Parent`/`Kids`); conflicts reported. Deleting a radio option updates the group. | P0 |
| FR-FRM-17 | **Authoring vs. fill mode** switch ("Edit form" / "Fill form") with distinct chrome; in authoring mode field highlights always on, inputs are not interactive. | P0 |
| FR-FRM-18 | **Validation panel**: duplicates, empty names, overlapping widgets, tiny fields (< 6 pt), missing export values, radio groups with one option, fields outside CropBox. One-click fixes where safe. | P1 |
| FR-FRM-19 | **Format hints** without scripting: number (decimals, thousands separator), date (pattern), percent, ZIP/phone masks stored as *non-executed* metadata consumed by Folio for display and input validation; written to `/AA` only when the target viewers' behaviour is understood — **default: not written** (no JavaScript in output). | P2 |
| FR-FRM-20 | **Field templates**: save selected fields as a reusable template (SQLite) for headers like "Name / Address / Date". | P2 |

### 3.2 Form data and spelling

| ID | Requirement | Pri |
|---|---|---|
| FR-FRM-04 | **Spellcheck** in text and multiline fields using the webview/OS spell checker where available (`spellcheck` attribute); language per field from document `Lang` or UI language; "Add to dictionary" delegated to the OS; clearly disabled with a reason when the platform has no spell checker. No document text is sent anywhere. | P1 |
| FR-FRM-21 | **Export field data** to **FDF**, **XFDF**, JSON (existing), CSV (one row per document); fields subset; flattened-state aware. | P1 |
| FR-FRM-22 | **Import field data** from FDF/XFDF/JSON/CSV with a **preview/mapping table** (field name → value, status *matched/ignored/type mismatch*), partial import, one composite undo. | P1 |
| FR-FRM-23 | **Batch fill** (batch operation, R4 registry): apply a data file (CSV with header row = field names) to a form to produce N filled PDFs named by a column. | P2 |
| FR-FRM-24 | **Reset and clear** semantics preserved for authored fields (default values honoured). | P0 |

### 3.3 AI usage panel (FR-AIF-11)

| ID | Requirement | Pri |
|---|---|---|
| FR-AIF-11 | Settings → AI → Usage: runs, prompt/completion tokens, model, mode, estimated cost if the user entered per-token prices (no built-in prices to avoid stale numbers), per day/month, export CSV, clear. Reads `ai_runs`; **never** shows or stores document content. | P1 |
| FR-AIF-12 | **Budget guard**: optional monthly token limit; warns and blocks at limit with override. | P2 |

### 3.4 Native engine and large files

| ID | Requirement | Pri |
|---|---|---|
| FR-ENG-01 | `NativePdfEngine` implements `PdfEngine`/`PdfDocument` in a Rust crate (PDFium via bindings) exposed by Tauri commands. It passes the **entire existing conformance suite** (SPEC §8.9); any capability it lacks is reported through a `capabilities` object, and the UI hides the dependent tools. | P0 |
| FR-ENG-02 | **Engine selection policy**: WASM engine by default; native engine automatically for files above the NFR-06 threshold or on user choice (Settings → Advanced → Engine: Auto / WASM / Native); the decision and reason are visible in Document properties. **Decided 2026-10-12:** after a stabilisation period the native engine becomes the **default on desktop** (criteria in §5.3); until then Auto selects it only above the size threshold. Web build: WASM only. | P0 |
| FR-ENG-03 | **Streaming I/O**: native engine opens by path (memory-mapped / lazy xref) rather than transferring whole buffers over IPC; renders return compressed tiles (PNG/raw via shared memory/IPC binary channel) with cancellation. | P0 |
| FR-ENG-04 | **Batch worker**: R4 batch runner can use native engine instances in a Rust thread pool for CPU-heavy jobs (compress, OCR pre-render, N-up) with the same operation registry. | P1 |
| FR-ENG-05 | **Parity guard**: conformance and interop golden images run against both engines in CI; differences above a threshold fail the build; a "compare engines" CLI tool renders pages with both for diagnosis. | P0 |
| FR-ENG-06 | **Large-file UX**: no full-document thumbnails generation up front, lazy outline, search progress and cancellation, memory meter in status bar, honest limits message. | P1 |
| NFR-06r | Native engine: opens a 1.5 GB / 20 000-page file with first page visible ≤ 3 s; resident memory ≤ 1.2 GB during scroll. WASM limits unchanged. | P0 |

### 3.5 Offline web (PWA)

| ID | Requirement | Pri |
|---|---|---|
| FR-WEB-01 | **Service worker** caches app shell, PDFium WASM, OCR worker and chosen language packs; versioned cache with atomic switch; works fully offline after first load. | P1 |
| FR-WEB-02 | **Installable**: web manifest, icons, `file_handlers` (PDF) and `launch_handler` where the browser supports; **share target** is *not* added (privacy review). | P1 |
| FR-WEB-03 | **Update flow**: new version detected → banner "Update available · Reload" never forcing reload with unsaved work; recovery snapshot first. | P1 |
| FR-WEB-04 | **Storage persistence**: request `navigator.storage.persist()` after the first save to protect OPFS (SQLite file, recovery snapshots); display quota usage in Settings. | P2 |

## 4. UX specification highlights

- **Forms mode** is a third top-level mode next to Organise and Edit ("Fill & Sign" from R1 stays). In authoring mode the left toolbar shows field tools; the right inspector shows properties; a bottom strip shows **tab order** toggle and **validation** badge.
- Field creation uses *show, don't ask*: after choosing a tool the cursor shows a ghost; a drag draws; **double-click** on a field opens its properties inline popover (name first, focused).
- **Radio groups**: draw first button → dialog "New group name"; subsequent buttons added via "Add option" keep the group; visual group outline when selected.
- **Import data** dialog is a two-pane diff (left: file data, right: current values) with filters "changed only".
- **Spellcheck**: standard red squiggle; no custom dictionary UI in Folio.
- **Large file banner**: non-blocking, with a "Learn why" popover (what the native engine changes, what still is not supported).
- **PWA**: install prompt only from Settings or the browser's own UI; no nagging.
- Accessibility: authoring tools fully keyboard operable (Arrow nudge, Tab through fields, F2 rename, Enter properties); tab order list is a proper listbox; badges have text labels.

## 5. Technical design

### 5.1 Field creation and editing

- The pinned PDFium build exports `EPDFPage_CreateFormField` (page, field type, rect, …), `EPDFAnnot_SetFormFieldName/Value/Options`, `EPDFAnnot_GenerateFormFieldAP`, `EPDFAnnot_ShareFormField` (radio/shared fields), `EPDFAnnot_SetDefaultAppearance`, `EPDFAnnot_SetMKColor/SetBorderStyle/SetTextAlignment`, `EPDFAnnot_GetButtonExportValue`. Spike **S14** validates: all field types, appearance regeneration, radio group semantics, `Opt` arrays for choice fields, comb and max length, `/Q`, `/DA` with embedded font in `/DR`, round-trip in Acrobat/Preview/Okular/Chrome/pdf.js (fill + save + reload).
- **Port** additions:

```ts
export type FieldSpec =
  | { kind: 'text'; multiline?: boolean; comb?: number; maxLen?: number; password?: boolean; ... }
  | { kind: 'checkbox'; exportValue: string; style: CheckStyle }
  | { kind: 'radio'; group: string; exportValue: string; style: CheckStyle }
  | { kind: 'choice'; combo: boolean; editable?: boolean; multi?: boolean; options: { label: string; value: string }[] }
  | { kind: 'button'; caption: string }
  | { kind: 'signature' };
interface PdfDocument {
  createFormField(page: PageIndex, rect: Rect, spec: FieldSpec, props: FieldProps): Promise<FieldId>;
  updateFormField(id: FieldId, patch: Partial<FieldProps & FieldSpec>): Promise<void>;
  deleteFormField(id: FieldId): Promise<void>;
  setTabOrder(page: PageIndex, order: FieldId[] | 'row' | 'column' | 'structure'): Promise<void>;
  getFieldTree(): Promise<FieldNode[]>;     // hierarchy with Parent/Kids for rename and validation
}
```
- Fallback if S14 fails for a type: build the field dictionaries and APs in the adapter through the lower-level object API or a vetted pure-JS writer (pdf-lib-class) with a **snapshot hand-over** (SPEC §8.7: never two writers at once).
- **Appearance**: adapter generates AP for each state (`/N`, `/D`, `/Off` for buttons) with the chosen font; `NeedAppearances` is **not** relied upon; no `/AA` or `/JS` written (security rule). Existing JS in documents is preserved byte-for-byte but never run; a "Document contains scripts that Folio ignores" notice appears on open (R1 FR-SEC-05).
- **Names** follow the PDF fully-qualified naming (`parent.child`); duplicates detection is document-wide; when a user types a name that already exists for a different type, UI suggests joining (radio/checkbox share) or auto-suffix.

### 5.2 FDF/XFDF

- FDF is a PDF-syntax subset; XFDF (ISO 19444-1) is XML with `<fields><field name="…"><value>…</value></field></fields>` and optional `<f href>`; annotations are out of scope (fields only).
- `FormDataService` in `@folio/services`: `parseFdf`, `parseXfdf` (use a safe XML parser configuration: **no DTD, no external entities**, size limits), `toXfdf`, `toFdf`, `toCsv`; value type coercion by field type; rich text values (`<value-richtext>`) imported as plain text with a notice.
- JSON export (R1) is unchanged; the three formats share the same intermediate `FormData` model.

### 5.3 Native engine (`apps/desktop/src-tauri/engine` crate, `packages/engine-native` TS adapter)

- Crate: bindings to PDFium (candidate `pdfium-render`, actively maintained as of mid-2026, current 0.9.x; **licence and the exact function coverage must be checked** in spike S15, particularly for the EPDF extension functions used by the WASM build, which are not part of upstream PDFium). Shared library bundled per platform (macOS/Windows/Linux) with the same build flags as the WASM build where possible.
- **Capability gap strategy**: where the EPDF extension functions are not available natively, either (a) build the same PDFium fork natively (the fork is open source — pin and record), or (b) mark the capability absent and hide dependent tools. S15 decides; ADR 0018.
- **IPC design**: commands are coarse (`open(path) → docId`, `render(docId, page, rect, scale) → binary`, `listObjects`, `apply(commandBatch)`), results via Tauri binary responses to avoid base64; document handles live in Rust with an LRU and explicit `close`. The TS adapter implements the same `PdfEngine`/`PdfDocument` interfaces and therefore `packages/app` does not change except for the engine factory and the selection policy.
- **Atomicity and recovery**: native save writes to temp then renames (existing `atomic write`); recovery snapshots use incremental diffs for huge files (full snapshot would be 1 GB): snapshot policy = *command journal* + periodic checkpoint to temp file; recovery replays the journal. Needs ADR (journal format) and tests with kill -9.
- **Default-on-desktop criteria** (all must hold before the switch): conformance and golden-parity gates green on both engines for two consecutive minor releases; no open data-loss or recovery defect; fuzz corpus run without an uncontained crash; the engine switch is reversible in Settings. Collected without telemetry: the criteria are evaluated on the project's own test corpus and issue tracker.
- **Security**: the native engine parses untrusted PDFs in the main privilege domain of the app; therefore run it in a **separate helper process** (sidecar) with a minimal capability set (no network, filesystem access only to given paths via handles), crash-isolated and restartable, with memory limits (`prlimit`/job object). This is a hard requirement for FR-ENG-01 release.

### 5.4 PWA
SvelteKit `src/service-worker.ts` with versioned precache of build assets and runtime caching for language packs; manifest with icons (SVG + PNG maskable); `file_handlers` entry for `application/pdf` (Chromium); fallback for Safari/Firefox (no install, but offline caching works). COOP/COEP remain unneeded (R1 decision) — verify OCR worker threading does not require them. No analytics, no push notifications.

### 5.5 Data model — migration `0006_forms_usage.sql`

```sql
CREATE TABLE field_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, fields_json TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE ai_runs ADD COLUMN prompt_tokens INTEGER;     -- if absent in 0001
ALTER TABLE ai_runs ADD COLUMN completion_tokens INTEGER;
CREATE TABLE ai_prices (model TEXT PRIMARY KEY, prompt_per_mtok REAL, completion_per_mtok REAL, currency TEXT NOT NULL);
```
(`ai_runs` columns must be reconciled with `0001_init.sql` — check before writing the migration; this document lists intent, not the final SQL.)

## 6. Non-functional requirements (additions)

| ID | Requirement |
|---|---|
| NFR-R6-01 | Create/modify a field ≤ 50 ms perceived; 500-field forms stay interactive (≥ 55 fps while scrolling). |
| NFR-R6-02 | Authored forms open and fill correctly in Acrobat Reader, Preview, Okular, Chrome, Firefox (pdf.js), Edge: 100 % of the authoring fixtures in the manual matrix. |
| NFR-R6-03 | XFDF import of 1 000 fields ≤ 1 s; parser rejects DTD/entities and files > 20 MB. |
| NFR-R6-04 | Native engine parity: ≥ 99 % of conformance tests identical; render diffs ≤ 1 % pixels (tolerance per anti-aliasing) on the golden corpus. |
| NFR-R6-05 | Native engine helper crash never loses work (journal + recovery tests). |
| NFR-R6-06 | PWA offline cold start ≤ 2.5 s after install; cache size ≤ 80 MB with eng+ita OCR. |

## 7. Testing strategy

| Level | What |
|---|---|
| Unit | Field naming/tree operations, validation rules, tab-order calculators, XFDF/FDF parse/serialise (incl. malicious samples: DTD, entity bombs, huge values), CSV mapping, usage aggregation, engine selection policy. |
| Conformance | `createFormField` for every type; fill→save→reload value persistence; radio exclusivity; choice `Opt`; comb; `setTabOrder`; delete group; flatten after creation. **Same suite run against both engines.** |
| Oracle | `qpdf --check`, `pdfcpu validate`, `pdfcpu form list/export`, `mutool` widget listing, `pdftoppm` renders; `poppler` `pdftotext -layout` with fields. |
| Interop (manual matrix) | Create-in-Folio → fill-in-viewer → open-in-Folio for each field type; documented in `docs/interop/forms.md`. |
| Native engine | Conformance, golden parity, fuzz inputs from corpus (crashes must be contained in helper), kill/restart tests, large file synthetic generator in testkit (streamed builder, no 1 GB in git). |
| e2e | Authoring flows with keyboard; import data preview; spellcheck presence (Chromium/WebKit differences recorded as capability); PWA offline via Playwright `context.setOffline`. |
| Security | Fuzzing of XFDF/FDF parsers, helper process sandbox test (denied network/file access), PWA cache poisoning tests. |

## 8. Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| R6-1 | Authored forms behave differently across viewers (appearance, fonts, radio logic) | Spike S14 matrix, restrict to features with proven parity, validation panel |
| R6-2 | Native engine parity gap and doubled maintenance | Port + shared conformance suite; ship native as *large-file mode* first, broader use later |
| R6-3 | EPDF extensions missing in native builds | Build the same fork natively or hide capabilities (ADR 0018) |
| R6-4 | Unsandboxed native parsing of untrusted PDFs | Helper process with restricted capabilities; fuzzing in CI |
| R6-5 | Spellcheck availability varies (WebKitGTK needs enchant/hunspell dictionaries) | Capability flag; disable with explanation; do not bundle dictionaries in R6 |
| R6-6 | PWA storage eviction | `persist()`, quota meter, recovery to downloads on warning |
| R6-7 | Scope: two XL items in one release | Milestones: 6.0-alpha forms+data, 6.0-beta native engine, 6.0 PWA+polish; native engine may slip to 6.1 without blocking forms |

**Open questions**
1. Should format hints (FR-FRM-19) ever be written as JavaScript `AA` for compatibility with other viewers? (Proposed: no — product rule.)
2. ~~Native engine default?~~ **Decided 2026-10-12:** default on desktop after stabilisation (see FR-ENG-02); large files use it from 6.0.
3. Which platforms get the native engine in 6.0 — Linux first (AppImage) or all three?
4. CSV batch fill: in 6.0 or deferred to 6.1?
5. Is a hosted web demo with the PWA acceptable (SPEC §18 open item 2)?

## 9. Delivery plan

| Phase | Goal | Exit gate |
|---|---|---|
| R6-P0 | Spikes S14 (form field creation), S15 (native engine feasibility, helper process), S16 (PWA/WebKit quirks), ADRs 0017–0019 | ADRs, go/no-go per track |
| R6-P1 | Ports (`FieldSpec`, engine capabilities), pure models, fixtures (`blankForm`, `radioGroups`, `giantArchive` builder) | Unit green |
| R6-P2 | WASM adapter: field authoring; FormDataService | Conformance + oracles |
| R6-P3 | Native engine crate, helper process, TS adapter, selection policy | Conformance parity, fuzz, recovery journal tests |
| R6-P4 | App layer: Forms authoring view-models, usage panel, PWA lifecycle | Epics E22–E25 headless |
| R6-P5 | UI + Italian strings, a11y | e2e on three browsers, desktop bundle smoke on three OS |
| R6-P6 | Hardening, interop matrix, release | `tools/gate.sh R6` |

## 10. Horizon (not built, prepared)

Conditional visibility and calculation designer (needs a safe expression language, not JavaScript), form distribution without server (email-less export bundles), accessibility tagging of forms (tagged PDF), mobile apps on the same adapters, plug-in operation registry for batch, certificate signatures (`SigningService` port) if the owner ever reverses the R1 decision.

## 11. Research notes and sources

- The installed PDFium build exposes field creation and appearance functions (`EPDFPage_CreateFormField`, `EPDFAnnot_GenerateFormFieldAP`, `EPDFAnnot_SetFormFieldOptions`, `EPDFAnnot_ShareFormField`, …) — inspected in typings of `@embedpdf/pdfium` 2.15.1 (MIT). Their real behaviour is not yet verified.
- `pdfium-render` (Rust) binds PDFium at run time, supports WASM builds, current release series 0.9.x with ongoing 2026 commits; licence and coverage of extension APIs **still to confirm**. <https://github.com/ajrcarey/pdfium-render>, <https://docs.rs/pdfium-render>
- XFDF is standardised as ISO 19444-1; FDF is part of ISO 32000. Parsers must disable DTD and external entities (general XML security practice).
- Tauri updater and WebView differences apply to all desktop features (see R2 notes). <https://v2.tauri.app/plugin/updater/>
