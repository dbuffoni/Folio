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
| P10 Incremental releases | in progress | releases built from the Notion plan (SPEC §16.10); 0.1.1 and 0.1.2 delivered; 0.1.3 (quality and protection, 13 cards) built, in review |

## Release 0.1.3

Thirteen cards of the Folio Kanban (Notion): two features, three quality features and eight tasks. Built on a
branch (`release/0.1.3`) without questions; decisions are in the commit messages and the PR.

| Card | Requirements | Where |
|---|---|---|
| Remove metadata (hidden data) | FR-SEC-12, FR-SEC-04 | `engine-pdfium/src/hidden.ts`, `PdfDocument.inspectHiddenData/removeHiddenData`, `DocumentService`, `AppModel.removeHiddenData`, `HiddenDataDialog.svelte` |
| Respect protected files | FR-SEC-07 | `DocMeta.permissions`, `CommandRegistry` permission gate (`needs`), lock icon, Properties, `AppModel.unlockRestrictions` |
| Browser tests for remaining screens | various | `apps/web/tests/gaps.spec.ts` (stamp editor, drag reorder, print frame, paste, image resize, certificate password, hidden data, protected file) |
| Release pipeline checks | - | `release.yml` distro matrix, GPG signing, SBOM validation, `tools/validate-sbom.mjs`, `smoke-distro.sh`, `docs/BUILDING.md` |
| Usability and screen-reader pass | NFR-11 | partly: `docs/usability-0.1.3.md` (people, Orca, Acrobat and Preview are not available here) |
| Code review of 0.1.1 and 0.1.2 | - | `docs/review-0.1.3.md`: 19 findings, the blocker and serious ones fixed (signature validation, compress, tables) |
| Code and test consolidation | - | dead exports removed (jscpd finds 0.06 % duplication), duplicated `node:sqlite` driver rows removed, coverage of signing, certificates and AI raised to >= 90 % lines / 80 % branches |
| Zero warnings in tests / in build and deploy | - | warning guard in testkit setup and in the Playwright `app` fixture, Svelte a11y warnings fixed, clippy clean, workflows on current action majors |
| Visual polish pass | - | four-size, two-theme sweep (`tests/visual-sweep/run.mjs`), fixes in `app.css`, toolbar, dialogs |
| Performance pass | NFR-01, 03 | `tests/perf/ui/run-ui.mjs`, baseline in `docs/perf-0.1.3.md` (nothing needed speeding up) |
| Branding pass | - | real symbol in title bar, splash and About; `docs/branding/CHECKLIST.md` |

Known limits: the distro matrix, GPG signing and the draft release were never run (no containers or
GitHub here); the "failed to load ./ita.special-words" line printed by Tesseract's engine during OCR tests is
third-party stderr and remains; PKCS#12 files protected with 3DES/SHA-1 (common from Windows) are still
reported as a wrong password.

## Release 0.1.2

Five cards of the Folio Kanban (Notion), all in the digital-signature area (ADR 0007).

| Card | Requirements | Where |
|---|---|---|
| Certificate management | FR-CRT-01…04 | `signing/certs.ts`, `CertificateService`, migration 0004, `CertificatesModel`, Settings ▸ Certificates |
| Sign with a digital certificate | FR-SIG-01…03 | `signing/sign.ts`, `signing/incremental.ts`, `DigitalSignModel`, `DigitalSignDialog.svelte` |
| Visible digital signature appearance | FR-SIG-02 | appearance in `signPdf`, corner presets and picture in the dialog |
| Validate existing digital signatures | FR-SIG-04…06 | `signing/validate.ts`, `signing/revocation.ts`, `SignaturePanelModel`, `SignaturesDialog.svelte` |
| Signature timestamps | FR-SIG-07, 08 | `signing/timestamp.ts`, `signing/dss.ts`, Rust `binary_request`, `WebBinaryTransport` |

Screenshots of the new screens (light and dark) are in `docs/screenshots/0.1.2`.

Known limits: in the browser, timestamp and revocation requests need servers that allow CORS; on the web the
imported key lives for the session only; only RSA and ECDSA P-256/P-384 keys; no smart cards or qualified
signatures (§17.1). The Rust command was checked only as a unit test of its request filter (no GTK in the build environment).

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

- **Distro matrix and signing.** `ci.yml` runs on every push and pull request and is green on main;
  v0.1.0 is published. The distro matrix (Fedora, Arch, older glibc), AppImage signing and the SBOM
  step are untested.
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
- **AI debug window.** Ctrl+Alt+Shift+D opens a hidden window with the AI requests of the current
  session and their answers (images left out, no key), to select and copy, optionally with the full
  text of the open document. Memory only; nothing is stored or sent.
- **Visual baselines** are compared only on the machine that rendered them.
- **Smart Fill accuracy** (≥ 85 %) is measured on the generated forms corpus, not on real-world forms.

Needs people

- Usability tests (§7.9), a manual screen-reader pass, and opening output in Acrobat Reader and
  Preview (poppler, MuPDF, qpdf and pdfcpu are automated).
