# Folio Release 2 — "Scan & Reach" (v2.0)

| | |
|---|---|
| **Status** | Draft specification for review |
| **Date** | 2026-10-12 |
| **Builds on** | Release 1 (SPEC.md, ADR 0001–0006, `docs/PROGRESS.md`) |
| **Roadmap** | [ROADMAP.md](ROADMAP.md) |
| **Licence** | GPL-3.0-or-later (unchanged) |

## 1. Purpose and outcome

Release 1 is a Linux and web editor that cannot read scanned pages and speaks English only. Release 2 removes the two biggest barriers to adoption:

1. **Scans become text.** Local OCR makes scanned pages searchable, selectable and editable (SPEC FR-EDT-08 promised this for "Release 2").
2. **Folio runs where people are.** Windows and macOS builds, an Italian UI with a framework that makes every further language a translation-only task, and an update mechanism so users do not have to reinstall.

**Success looks like:** Marta (persona) opens a phone scan of a contract on Windows, runs "Make searchable", finds a clause with Ctrl+F, corrects a typo with the Edit text tool and saves, all with the UI in Italian and no network call.

### 1.1 In scope

| Track | Feature | IDs |
|---|---|---|
| A. OCR | Make pages searchable (invisible text layer), language selection, local worker, edit text after OCR | FR-OCR-01…04 (+ new FR-OCR-05…09) |
| A. OCR | Export text of selected pages | FR-OPT-05 |
| B. Platforms | Windows 10+ (x64) installer; macOS 12+ bundle built and tested in CI only (**community build**, no owner Mac for notarisation or manual testing) | NFR-09, §14 |
| B. Platforms | Auto-update (signed) and AppImage update information | §11.1, §14 (+ new FR-APP-14) |
| B. Platforms | Reload on external file change | FR-APP-08 |
| C. Languages | Italian UI, language framework for community translations, locale-aware formats | NFR-12 (+ new FR-APP-15) |
| D. Foundations | Spike S4a (encryption/compression verification, ADR only — no feature) | SPEC §16.6 note on S4 |

### 1.2 Out of scope (kept for later releases)

Compression, passwords, redaction (R3); handwriting recognition, table extraction, layout-aware OCR, deskew/despeckle of scans, scanner acquisition (SPEC §17.5 horizon); Windows MSI via Group Policy distribution, Microsoft Store and Mac App Store packaging; ARM Windows; Linux Flatpak/deb (may be added opportunistically but not gating).

## 2. Personas and scenarios (acceptance level)

| # | Scenario | Persona |
|---|---|---|
| S1 | Open a 12-page scanned PDF, press "Make searchable", watch progress, cancel after page 5 (pages 1–5 keep their text), resume for the remaining pages. | Marta |
| S2 | Open a scan, run OCR in Italian, search "contratto", highlights appear on the scan; copy a paragraph; paste in another app. | Luca |
| S3 | After OCR, use Edit text on a line, fix "1O0" to "100"; a notice says the line uses a substitute font. | Giulia |
| S4 | Install Folio from the Windows installer, double-click a PDF in Explorer, Folio opens it. | Marta |
| S5 | Switch the UI language to Italian in Settings, all visible strings change without restart, dates and numbers follow the locale. | Paolo |
| S6 | Folio notifies that 2.0.1 is available, user reads the notes and installs; the app restarts and reopens the recovered tabs. | all |
| S7 | A PDF open in Folio is overwritten by another program; Folio asks "Reload?" and keeps unsaved changes recoverable. | Giulia |

## 3. Functional requirements

Priorities: **P0** must ship in R2, **P1** ships but is first to be cut.

### 3.1 OCR (extends SPEC §6.10)

| ID | Requirement | Pri |
|---|---|---|
| FR-OCR-01 | Run OCR on selected pages, current page or whole document; writes an **invisible text layer** (text render mode 3) positioned on the scan image so that search, copy and accessibility work. The page image is **never modified or re-encoded**. | P0 |
| FR-OCR-02 | Language packs: English and Italian are bundled in the installer and the web build fetches them on first use from the same origin (no third party). Further packs are downloadable on demand through a user-initiated dialog showing name, size and source; cached in app storage; removable in Settings. | P0 |
| FR-OCR-03 | Runs in a dedicated Web Worker pool (Tesseract WASM) with progress per page, cancel at any time, and per-page results. Pages that already have a text layer are skipped by default (option "Redo OCR" replaces the layer produced by Folio, never foreign text). | P0 |
| FR-OCR-04 | After OCR, text is available to search, selection/copy and to the Edit text tool (substitute font is used and reported, as in FR-EDT-02). | P0 |
| FR-OCR-05 | **Pre-flight**: before running, show page count, estimated time (based on a quick benchmark of the first page), languages, and a quality hint if the page raster is below 150 DPI effective ("Low resolution: results may be poor"). | P1 |
| FR-OCR-06 | **Multi-language**: up to three languages per run (e.g. `eng+ita`); the default comes from the UI language and the last used set. | P1 |
| FR-OCR-07 | **Confidence review**: words with confidence below a threshold are listed (sidebar tab "OCR results") with "Locate" and inline correction; accepting a correction rewrites the invisible text for that word. | P1 |
| FR-OCR-08 | **Orientation and layout**: detect 90°/180°/270° rotated scans (OSD) and offer to rotate the page (non-destructive: sets `/Rotate`) before OCR; ignore pages detected as blank. | P1 |
| FR-OCR-09 | **Undo as one step**: an OCR run on N pages is a single composite command; its undo removes exactly the layer it created (identified by a marker in the content stream / OCG-free tag `Folio:OCR`). | P0 |

### 3.2 Export text

| ID | Requirement | Pri |
|---|---|---|
| FR-OPT-05 | Export extracted text of selected pages to `.txt` (UTF-8), with page separators option, reading order from the engine text layer; option to normalise hyphenation at line ends. Works on OCR'd and native text. | P1 |

### 3.3 Platforms and update

| ID | Requirement | Pri |
|---|---|---|
| NFR-09r | Release builds: **Windows 10 22H2+ / 11 x64** (NSIS installer, per-user install default, WebView2 evergreen bootstrapper), **macOS 12+** (`.dmg`, built and automatically tested on a CI macOS runner; **unsigned and not notarised**, flagged "community build, not manually tested"; it never blocks a release), Linux AppImage unchanged. Linux aarch64 build is *compile-only* unless the ADR of spike S1 re-run says otherwise. | P0 |
| FR-APP-14 | **Updates**: check at start and every 24 h **only if the user enabled it** (default off on first run, with a one-time, non-modal invitation). Shows version, release notes, size; downloads a signed artefact; verifies signature; installs on confirm; never auto-restarts a dirty session (recovery snapshot first). A "Check now" action exists in Help. Web build: no updater, shows a "new version available" banner from the service worker lifecycle only when R6's PWA ships (nothing in R2). | P0 |
| FR-APP-08 | **Reload on external change** (desktop): file watcher via platform `watch`; debounce 500 ms; if clean → non-modal "File changed on disk — Reload"; if dirty → choose "Keep mine / Reload (lose changes) / Save mine as…". Detects delete and rename. | P1 |
| FR-APP-16 | **File association and "Open with"** on Windows (registry, opt-in during setup) and macOS (UTI `com.adobe.pdf` handler, opt-in via Settings → "Make Folio the default"). Single-instance hand-off works the same as on Linux. | P0 |
| FR-APP-17 | **Platform conventions**: macOS app menu (About, Preferences ⌘,), `⌘` shortcuts per Appendix A, native title bar; Windows jump-list for recent files; high-DPI and per-monitor DPI. | P1 |

### 3.4 Languages

| ID | Requirement | Pri |
|---|---|---|
| FR-APP-15 | **Language framework**: `apps/web/src/lib/i18n/messages/<bcp47>.json` per language, key parity enforced by `tools/i18n-lint.ts` (missing key = build warning for community languages, build error for shipped languages); plural rules by `Intl.PluralRules`; no string concatenation (lint). Language chooser lists native names. Fallback chain: `it-CH → it → en`. | P0 |
| NFR-12r | **Italian** shipped as first additional language, reviewed by a native speaker; terminology glossary kept in `docs/i18n/glossary.it.md`. | P0 |
| FR-APP-18 | **Locale-aware formatting**: dates (date stamp FR-STM-05 keeps its explicit format choice), numbers, units default (mm in Italy, in in US), paper size default (A4/Letter), first-day-of-week. | P1 |
| FR-APP-19 | **Fonts for UI and stamps**: built-in stamp texts (APPROVED, …) are localised through the message catalog; the stamp's visible text is stored in the file as drawn, not as a key. | P1 |
| FR-APP-20 | **Right-to-left readiness**: UI layout uses logical CSS properties; no RTL language ships in R2, but Hebrew/Arabic fixture runs the layout tests (mirrored toolbar, sidebar side). | P1 |

## 4. UX specification

### 4.1 OCR entry points
- Sidebar page context menu and Organise view toolbar: **"Make searchable…"**. Command palette: "Run OCR". Banner on a page where Edit text found only an image (FR-EDT-08): "This page is a scan. [Make searchable]" replaces the R1 "OCR arrives in Release 2" text.
- **Dialog** (modal, one screen): pages (current / selection / all / range), languages (chips, searchable list of installed packs + "Download more…"), options (skip pages with text, rotate detected pages), estimate line, buttons **Run** / **Cancel**.
- **Progress**: non-modal bottom bar "OCR 7/12 · 2:10 left · [Cancel]". Page thumbnails get a small "T" badge as soon as their layer exists. The editor stays usable; edits to a page being recognised are queued until that page completes (command bus lock per page, not per document).
- **Result toast**: "Searchable text added to 12 pages · Undo".
- **Honest limits**: a one-time info popover explains that OCR is probabilistic and handwriting is not supported.

### 4.2 Edit text on OCR'd pages
Hover shows the OCR run box in a dashed style (to signal it is derived from recognition) and the tooltip "Recognised text · substitute font will be used". An edit never modifies the scan pixels. The edit offers two modes via a segmented control: **"Correct the hidden text only"** (default; fixes search/copy) and **"Cover scan & retype"** (whiteout over the glyph area + visible text, same as Cover & type).

### 4.3 Language and update settings
Settings → General → Language (native names, "Restart not required"). Settings → Updates: toggle, channel (stable only in R2), last check time, "Check now". Settings → OCR: installed language packs, size on disk, "Remove", "Add language…".

### 4.4 Platform-specific
Windows: installer wizard in the installer's language, option "Associate .pdf files". macOS: standard drag-to-Applications dmg background, Gatekeeper-friendly first launch text on the website.

## 5. Technical design

### 5.1 New and changed ports (`packages/ports`)

```ts
// ocr.ts — OcrEngine was reserved in SPEC §8.4; the signature is refined here.
export interface OcrWord { text: string; bbox: Rect /* px of the input raster */; confidence: number; baseline?: number; }
export interface OcrLine { words: OcrWord[]; bbox: Rect; }
export interface OcrPage { width: number; height: number; dpi: number; lines: OcrLine[]; rotation?: 0|90|180|270; meanConfidence: number; }

export interface OcrLanguagePack { code: string; name: string; sizeBytes: number; installed: boolean; bundled: boolean; }

export interface OcrEngine {
  readonly kind: 'tesseract-wasm' | 'native';
  availableLanguages(): Promise<OcrLanguagePack[]>;
  installLanguage(code: string, signal: AbortSignal): Promise<void>;   // user-initiated, via HttpClient allow-list
  removeLanguage(code: string): Promise<void>;
  detectOrientation?(page: RasterImage, signal: AbortSignal): Promise<{ rotation: 0|90|180|270; confidence: number }>;
  recognize(page: RasterImage, langs: string[], signal: AbortSignal, onProgress?: (p: number) => void): Promise<OcrPage>;
  dispose(): Promise<void>;
}
```

`PdfDocument` gains (additive, optional until the conformance suite is extended):

```ts
setInvisibleText?(i: PageIndex, layer: InvisibleTextLayer, opts: { tag: string }): Promise<void>;  // render mode 3, font Folio-OCR (Identity-H, embedded subset of a bundled Noto-based "GlyphLess" font)
removeInvisibleText?(i: PageIndex, tag: string): Promise<boolean>;
getPageRasterForOcr?(i: PageIndex, targetDpi: number): Promise<RasterImage>;     // thin wrapper around render()
```

`AppUpdater` is a new platform port (`Platform.updater?`): `check(): Promise<UpdateInfo|null>`, `downloadAndInstall(info, onProgress)`, `channel`, `lastCheck`. `FileService.watch` (already declared) is implemented by the desktop adapter (Rust `notify` crate through the fs plugin) and left undefined on the web.

### 5.2 OCR pipeline (`packages/services/src/ocr.ts`, new `OcrService`)

1. Resolve pages → for each page get a raster at `clamp(effectiveDpi, 150, 300)` (effective DPI from the largest image's pixel size ÷ page size; fall back to 200).
2. Optional light pre-processing in the worker: grayscale + Otsu threshold *for recognition only* (original untouched). Deskew is **not** done in R2 (horizon).
3. `OcrEngine.recognize` on a scheduler of `min(3, hardwareConcurrency-1)` workers; one page in flight per worker; results stream to the service.
4. `InvisibleTextLayerBuilder` (in `@folio/core`, pure) converts word boxes (px) into PDF user-space points using the page transform helpers (y-up, before page rotation, CLAUDE.md rule) and groups words per line, emitting for each word a text object with horizontal scaling (`Tz`) so the glyphless text spans exactly the word box. This is the approach used by hOCR-to-PDF tools (OCRmyPDF's hocrtransform, Tesseract's PDF renderer).
5. `PdfDocument.setInvisibleText` writes `BT /FolioOcr … 3 Tr … ET` inside a marked-content sequence with the custom tag `/FolioOCR` (no `/ActualText`, to avoid duplicated text on extraction), so the layer is removable and idempotent.
6. Result is one `CompositeCommand` (`kind: 'content'`), undo = `removeInvisibleText` for each page (inverse is cheap, no checkpoint needed).
7. Text layer cache is invalidated per page; search index updated incrementally.

**Font for the invisible layer.** Text in render mode 3 is never painted, but extraction needs a valid ToUnicode map. Use one shared embedded Type0/Identity-H font with a ToUnicode CMap generated from the characters actually used (like Tesseract's `pdf.ttf` "glyphless" font, Apache-2.0). Needs spike **S6** to verify extraction in all oracle tools and viewers.

### 5.3 OCR engine adapter (`packages/ocr-tesseract`, new package)

- Dependency candidate: **tesseract.js** (Apache-2.0), WASM core + LSTM models. Language data from `tessdata_fast` (smaller, faster) for default; "best" models are an optional pack.
- Worker bundle and `.traineddata.gz` live under `static/ocr/` (web) and in the Tauri resources (desktop) so the app works offline from the first run for English and Italian.
- Tesseract.js workers are reused across pages (creating a worker per page is slow); `terminate()` on dispose and on idle for 60 s.
- Memory: cap the page raster at 12 megapixels; for A0 plans, tile with overlap (R2 only warns and downsizes).
- Threading: no SharedArrayBuffer requirement (keeps the "runs without COOP/COEP" rule of SPEC §8.10). Evaluate SIMD-enabled core where WebKitGTK and WebKit support it (spike).

### 5.4 Platform work

| Area | Design |
|---|---|
| Tauri targets | Add `windows-latest` and `macos-latest` release jobs; `tauri.conf.json` bundle targets `nsis` and `dmg` per OS. Capabilities already scoped per window; re-audit paths for `\\` and `/`. |
| Windows | WebView2 (evergreen). Code signing: Authenticode certificate via a signing service or an OSS-friendly signing programme (evaluate SignPath Foundation, Azure Trusted Signing; decision in ADR). Unsigned builds are documented as SmartScreen-warned. |
| macOS | **Decision (2026-10-12): no Mac and no Apple Developer account available.** CI-built, unsigned, un-notarised `.dmg`; users must right-click → Open (documented). Manual verification is delegated to community testers; Developer ID signing, notarisation and stapling become a follow-up when a Mac or an account exists. Universal binary if the runner allows. |
| Keyring | `keyring` crate already abstracts Secret Service / Credential Manager / Keychain; add platform tests. |
| Atomic write | Rust `atomic write` command: Windows needs `ReplaceFileW`/`MoveFileEx` semantics and handling of sharing violations (antivirus locks) with bounded retry. |
| Printing | WebView2 and WKWebView print paths differ from WebKitGTK; the existing "hidden iframe + print()" strategy is re-validated per OS (SPEC R6). |
| Paths | `FileRef.path` may contain drive letters, UNC, and non-NFC Unicode on macOS: normalise to NFC for comparisons, never for I/O. |
| Fonts | Bundled fonts stay the only embedded fallback; do not depend on system font scanning. |
| CI | Adds Windows and macOS **test** (not compile-only) jobs: unit, conformance on Node, Playwright web build, Rust tests, bundle smoke (launch, open fixture, rotate, save, exit). |

### 5.5 Update system

- `tauri-plugin-updater`: signed artefacts (minisign key pair generated once; public key in `tauri.conf.json`, private key in CI secret — losing it means users must reinstall manually, so it is backed up offline).
- Update manifest: a static `latest.json` per channel on the project's release host, in the Tauri static format (`version`, `notes`, `pub_date`, `platforms.<os>-<arch>.{url,signature}`). Hosting is the project's own GitHub Releases / Pages; no server logic.
- Updater endpoint is added to the **network allow-list** in Rust and to the CSP `connect-src`; check requests carry **no identifiers** beyond the current version and platform (verified by an e2e test).
- AppImage: the same artefact is replaced in place; also embed `AppImageUpdate` zsync information so external tools can delta-update (SPEC §14).
- Never update while a save or OCR is running; the install step first triggers recovery snapshot (FR-APP-06) and reopens tabs after restart (existing recovery prompt).

### 5.6 Data model (migration `0002_ocr_updates_lang.sql`)

```sql
CREATE TABLE ocr_packs (
  code TEXT PRIMARY KEY,              -- 'eng', 'ita', ...
  variant TEXT NOT NULL DEFAULT 'fast',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  source TEXT NOT NULL                -- 'bundled' | 'user-download'
);
CREATE TABLE ocr_runs (               -- statistics only, never content
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, pages INTEGER NOT NULL,
  languages TEXT NOT NULL, mean_confidence REAL, duration_ms INTEGER, created_at TEXT NOT NULL
);
```
Settings keys added: `language`, `updates.enabled`, `updates.channel`, `updates.lastCheck`, `ocr.defaultLanguages`, `ocr.skipTextPages`. Language-pack binaries are **not** in SQLite; they live in `AppStorage` (files).

### 5.7 Security and privacy

- Language packs and updates are the only new network traffic; both go through `HttpClient` with a host allow-list set at build time (the project's own origin) — page content cannot add hosts (same rule as the AI base URL, ADR 0006).
- Downloaded packs are verified against a SHA-256 manifest shipped in the app, then stored; a corrupt pack never loads.
- OCR runs locally; no text leaves the machine. The OCR text layer is page content, not metadata, so "Remove all metadata" leaves it in place and the dialog says so. (R3 redaction removes it inside redacted areas.)
- Update signature failure = hard error with clear message; no downgrade offered.
- Windows installer and macOS dmg are reproducible from tagged source; SBOM includes OCR models and their licences (Apache-2.0).

## 6. Non-functional requirements (additions)

| ID | Requirement |
|---|---|
| NFR-R2-01 | OCR throughput on the reference laptop: ≥ 1 page/4 s at 200 DPI A4 for English `tessdata_fast`, single worker; ≥ 2.5× with three workers. Measure and set the real budget after spike S6. |
| NFR-R2-02 | OCR peak memory ≤ 600 MB above baseline for a 100-page run (pages released after each result). |
| NFR-R2-03 | UI stays responsive during OCR (no frame > 100 ms caused by OCR on the main thread). |
| NFR-R2-04 | Installer size: Windows ≤ 90 MB, macOS ≤ 110 MB, AppImage ≤ 120 MB (includes eng+ita packs; review after measurement). Web initial JS unchanged (≤ 600 KB gz); OCR code and data load lazily. |
| NFR-R2-05 | Italian catalogue 100 % key coverage, layout tests pass with +35 % text expansion pseudo-locale and an RTL fixture locale (no third shipped language). |
| NFR-R2-06 | Cold start on Windows/macOS ≤ 2.5 s (NFR-01 relaxed by 0.5 s until measured on those OSes). |

## 7. Testing strategy

| Level | What |
|---|---|
| Unit | `InvisibleTextLayerBuilder` geometry (rotations 0/90/180/270, CropBox offset, non-square scale), word grouping, `Tz` computation, range parsing for OCR page selection, update-state machine, locale fallback chain. Tags `@FR-OCR-0x`. |
| Conformance | New engine tests: `setInvisibleText` round-trip, `removeInvisibleText` idempotence, text extraction equals input words, rendering unchanged (pixel-identical to input). Run for every engine implementation. |
| OCR corpus | `fixtures/generated/ocr/` built by `packages/testkit` (rendered text with known fonts, noise, skew ±2°, low-DPI, two columns, mixed languages, rotated 90°, table, handwriting-like negative samples). Metrics: word error rate per language; budgets set after spike (initial gate: WER ≤ 5 % clean print, ≤ 15 % noisy). |
| Interop | `pdftotext`, `mutool draw -F text`, `qpdf --check`, `pdfcpu validate` on OCR output; Acrobat/Preview/Okular/Chrome/Firefox search finds the word and highlights align (manual matrix recorded). |
| e2e | Playwright: OCR flow with fake slow engine (progress, cancel, undo); language switch; update flow against a local manifest server; no-network test with explicit allow-list entries for the two user-initiated paths. |
| Platform | Windows and macOS CI: bundle smoke test analogous to `pnpm appimage:smoke` (rotate and save flow), atomic write under file lock, long path and non-ASCII path fixtures. |
| Visual | Baselines per OS (fonts differ); compare only on the OS that rendered them. |
| Manual | Screen-reader pass on OCR dialog; Italian proof-read; usability test of S1–S3. |

## 8. Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| R2-1 | OCR accuracy on poor scans disappoints users | Pre-flight resolution hint, confidence review, honest limits popover, `best` model pack |
| R2-2 | WASM OCR slow on low-end laptops | Worker pool, page-level cancel/resume, background priority, option to OCR current page only |
| R2-3 | Invisible layer misaligned in some viewers | Spike S6 viewer matrix; use `Tz` per word not per line; keep baseline from Tesseract |
| R2-4 | Windows signing delays; no macOS signing or manual testing possible | Treat as release-process item; ship unsigned builds with documented warnings (SPEC §14); macOS labelled community build and excluded from release gates |
| R2-5 | WebView2/WKWebView feature gaps (OffscreenCanvas, OPFS) | S1 re-run per OS; `ImageData` fallback already exists |
| R2-6 | Update key loss or compromise | Offline backup, documented rotation by shipping a new key in a manual-install release |
| R2-7 | Translation drift | Key-parity lint, glossary, PR template item "strings reviewed" |

**Open questions for the product owner**
**Decided by the product owner on 2026-10-12**

| # | Question | Decision |
|---|---|---|
| D1 | Auto-update default | **Off by default**, with a one-time non-modal invitation (FR-APP-14 as written) |
| D2 | Third language | **None in R2**; Italian only. The framework is validated by the pseudo-locale (+35 % expansion) and RTL fixture tests instead of a real third language |
| D3 | Mac for notarisation and testing | **Not available** → macOS is a CI-built, unsigned community build (see §5.4), not a release gate |
| D4 | Windows signing | Still open (certificate, signing service or unsigned) |

**Still open**
1. Windows signing: purchase a certificate, use a signing service, or ship unsigned initially?
2. Bundle OCR packs in installers (larger download) or download on first use (needs network)? Proposal: bundle `eng` + `ita`.

## 9. Delivery plan

| Phase | Goal | Exit gate |
|---|---|---|
| **R2-P0 Spikes** | S4a (qpdf vs built-in `EPDF_SetEncryption` for R3, ADR), S6 OCR layer (quality, extraction in 6 viewers/tools, speed), S7 Windows/macOS webview parity, S8 updater signing flow | ADRs 0007–0010 written; go/no-go for each track |
| **R2-P1 Ports and testkit** | `OcrEngine`, `Updater`, invisible text methods, OCR fixture builders, fake OCR engine | Conformance suite extended and green on the existing engine |
| **R2-P2 OCR services** | `OcrService`, layer builder, commands, export text, language packs repo, migration 0002 | FR-OCR-01…09, FR-OPT-05 tests green; WER budgets met |
| **R2-P3 Platform services** | Tauri adapters per OS, watch, updater, file association, i18n framework | Adapter conformance on three OS; update test against local server |
| **R2-P4 App layer** | View-models for OCR dialog/progress/review, update settings, language chooser | Epics E8 (scan to searchable), E9 (switch language), E10 (update) headless green |
| **R2-P5 UI** | Screens, Italian strings, dark/light, a11y | Playwright three browsers + Windows bundle smoke (macOS CI smoke informational); axe clean |
| **R2-P6 Hardening** | Interop matrix, performance, licence/SBOM, docs, signing, release notes | `tools/gate.sh R2` green; installers published |

**Definition of Done** (unchanged from CLAUDE.md, plus): Italian strings present, behaviour verified on all three OSes where applicable, ADR written for each spike.

## 10. Horizon (prepared, not built)

Deskew/despeckle/auto-crop of scans, scanner acquisition (SANE/WIA), layout-aware OCR and table extraction, handwriting recognition (needs a different model class), OCR on a native engine for huge scans (R6 native engine can host it), optional AI-assisted OCR cleanup (via `AiProvider`).

## 11. Research notes and sources

- Tesseract.js is Apache-2.0, runs as a WASM port with a worker/scheduler API, caches language files after first fetch, and supports `tessdata_fast`/`best` models. Verify the exact current version and per-language file sizes during spike S6 (not confirmed in this research pass). <https://github.com/naptha/tesseract.js>
- Tessdata trade-off between speed and accuracy: <https://github.com/tesseract-ocr/tessdata_fast>
- Tauri updater: requires signed artefacts, static JSON or dynamic endpoint; on Linux the AppImage itself is replaced, on Windows the NSIS/MSI installer is reused, on macOS a `.app.tar.gz` is used; `createUpdaterArtifacts: true`; Windows `installMode` passive by default. <https://v2.tauri.app/plugin/updater/>
- Windows uses WebView2, macOS WKWebView, Linux webkit2gtk (version table: <https://v2.tauri.app/reference/webview-versions/>). Minimum macOS version was **not** confirmed in research; check the Tauri prerequisites page when starting R2-P0.
- Invisible-text-layer technique (render mode 3 over scan image) as used by OCRmyPDF/Tesseract PDF renderer: validate by spike S6.
