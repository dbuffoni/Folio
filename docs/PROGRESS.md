# Progress

Status of the delivery phases of SPEC §16.6. Update this file at the end of each phase gate.

| Phase | State | Evidence |
|---|---|---|
| P0 Foundations | done | workspace, `CLAUDE.md`, `.claude/` skills, agents, commands, hooks; walking-skeleton AppImage |
| P1 Test infrastructure | done | `packages/testkit`: 25 fixture builders, oracle wrappers (qpdf, pdfcpu, poppler, mupdf), matchers, golden tools, fakes |
| P2 Engine core + spikes | done | `packages/engine-pdfium`; conformance suite (56 tests, also through the worker RPC); ADR 0001–0003 |
| P3 Structure services | done | page, document, merge, split, images-to-PDF, export, recovery, history |
| P4 Content services | done | text, render, navigation, annotations, signatures, stamps, forms, text edit, images, whiteout |
| P5 Persistence + intelligence | done | migrations and repositories on two SQLite drivers; OpenAI provider; Smart Fill (corpus accuracy ≥ 85 %, injection fixtures) |
| P6 Application layer | done | `packages/app`; epics E1–E7 as headless scenarios |
| P7 Platform shell | done | web and Tauri adapters, Rust commands with tests, AppImage smoke test; `services-complete` gate passed 2026-10-11 |
| P8 User interface | done | Svelte screens bound to `packages/app`; Playwright on Chromium, Firefox and WebKit (epics E1–E7, screens, axe in both themes, no-network); visual baselines; AppImage ships the real UI |
| P9 Release hardening | done locally | interop, golden and performance suites; i18n lint; licence review and notices; bundle budget; CI and release workflows written; `tools/gate.sh P9` passed 2026-10-12 |
| P10 Incremental releases | in progress | releases built from the Notion plan (SPEC §16.10); 0.1.1: 13 cards analysed, waiting for acceptance |

## Release 0.1.1

Thirteen cards of the Folio Kanban (Notion), merged to main (PR #7). Every card has unit tests
(services, app view-models, db on both SQLite drivers), conformance tests where the engine changed, oracle
tests (qpdf, pdfcpu, poppler) where PDFs are written, and Playwright scenarios.

| Card | Requirements | Where |
|---|---|---|
| Local AI server presets | FR-AIF-12 | `packages/core/src/ai-endpoints.ts`, `packages/ai`, `packages/app/src/ai-settings.ts`, Rust `http.rs` |
| Model capability check | FR-AIF-13 | `OpenAiProvider.probeCapabilities`, `aiCapabilities` in settings |
| Bookmark editor | FR-EDT-11, FR-EDT-27 | `PdfDocument.editOutline`, `OutlineService`, `OutlineModel`, sidebar |
| Reduce file size | FR-OPT-01, 07, 09, 11 | `CompressService`, `engine-pdfium/src/compact.ts`, `CompressModel`, `folio-cli compress` |
| Create form fields, Edit existing fields | FR-FRM-08, 11, 15, 16, 17 | `engine-pdfium/src/fieldedit.ts`, `FormAuthoringService`, `FieldDetectionService`, Edit form mode |
| Smart Fill on scanned paper forms | FR-AIF-14 | `SmartFillService.plan/apply`, image-hash fingerprint |
| Field templates | FR-FRM-20 | migration 0002, `FieldTemplateRepo`, `ProfilesModel`, profiles editor |
| Make scanned pages searchable, Multi-language OCR, OCR language packs, Read difficult scans with AI | FR-OCR-01…04, 06, 09, 10 | `packages/ocr-tesseract`, `OcrService`, `OcrLanguageRepo`, `addOcrLayer`, Rust `download_file` |
| Extract tables | FR-OPT-12 | `core/src/tables.ts`, `TableService`, `TablesModel` |
| Bugs and small features 130, 132, 133, 134 | FR-APP-03, FR-FRM-20, FR-STM-01, FR-STM-05, FR-AIF-04 | `Home.svelte` menu, `ProfilesPane.svelte`, `SignModel.placeDate/dateChoices`, migration 0003, `SmartFillService.signFields` |

Known limits of this release: moved bookmarks keep page/position/zoom and web addresses but not named,
script or launch actions (PDFium cannot re-attach them); field authoring rewrites the file through pdf-lib
and refuses XFA and password-protected files; OCR tessdata for languages other than English and Italian
is downloaded from a pinned `tessdata_fast` release; the OCR run reads a page at 300 dpi and processes
one page at a time; table extraction is one page at a time and ignores rotated text.

Run `tools/gate.sh <phase>` to re-check a gate, `pnpm trace` for the requirement matrix (`docs/traceability.md`).

## Known gaps

Not implemented

- **Text selection from the keyboard**: there is no caret, so a piece of text can only be selected with the pointer. Keyboard-only users can place and move every annotation (Enter at the centre of the page, then arrows), and Enter highlights an existing selection, but cannot start a text-based markup on their own. Accepted limit for Release 1 (NFR-11 is met for placement, not for text markup).
- **Print scale** (part of FR-VIEW-09): the print dialog of Folio offers page range and copies; scale is chosen in the browser or system print dialog, which a print frame cannot preset. Folio-side scaling needs page scaling (Post-R1 machinery).
- **Merge option "unify page size"** (part of FR-MRG-02): needs page scaling (Post-R1 machinery).
- **FakePdfEngine**: services and view-models are tested against the real engine, which starts in ~20 ms in Node.
- **CJK fixture**: no CJK font is bundled or installed; Greek, Cyrillic, Hebrew and Polish text are covered.

Implemented but not verified where it matters

- **Release workflow and distro matrix.** `ci.yml` runs on every push and pull request and is green on
  main. `release.yml` (tag build, checksums, SBOM, draft release) has not run yet, and the distro
  matrix (Arch, older glibc) and AppImage signing are untested.
- **Screens without a browser test.** The e2e suite (33 scenarios on three browsers) covers the
  seven epics, every mode and tool group, the main dialogs and accessibility scans. Not driven in a
  browser: custom stamp editor, drag-and-drop reordering (keyboard and buttons are tested), printing,
  clipboard paste, the recovery prompt, Smart Fill with a real AI key, profile import/export, image
  resize handles. Their view-models are tested headlessly.
- **Desktop-only paths.** Native file dialogs, the keyring, drag-and-drop from the file manager and
  the single-instance hand-off are covered by Rust unit tests and the smoke test's IPC checks, not
  by a UI flow (WebDriver cannot operate native dialogs).
- **Performance in the real UI.** NFR-02/04/05 budgets are measured on the engine in Node; start-up
  time (NFR-01) was not measured in the AppImage. Scrolling (NFR-03) is tracked with the opt-in
  profiler (`?perf`, Ctrl+Alt+Shift+P in the AppImage), not by a gate.
- **Visual baselines** are compared only on the machine that rendered them.
- **Smart Fill accuracy** (≥ 85 %) is measured on the generated forms corpus, not on real-world forms.

Needs people

- Usability tests (§7.9), a manual screen-reader pass, and opening output in Acrobat Reader and
  Preview (poppler, MuPDF, qpdf and pdfcpu are automated).
