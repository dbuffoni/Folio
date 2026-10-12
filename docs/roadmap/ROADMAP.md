# Folio — Roadmap after Release 1

| | |
|---|---|
| **Status** | Proposal for product-owner review |
| **Date** | 2026-10-12 |
| **Source** | SPEC §5, §6 (`Post-R1` tags), §17.0 (deferred list), §18 (risks) and the state of the code at commit `47ddb01` (`docs/PROGRESS.md`, ADR 0001–0006) |
| **Scope of this document** | Release 2 to Release 6 (five major releases). Release 1 is locked in SPEC §5 and is not repeated here. |

> **Rule that still applies.** `CLAUDE.md` says "never implement a `Post-R1` feature" inside Release 1. This roadmap does not change that. A feature becomes buildable only when its release specification is **approved** and the Release 1 scope statement in SPEC §5 is amended (see "Adoption procedure" below).

---

## 1. How the releases were ordered

The deferred features (SPEC §17.0 plus every `Post-R1` tag in §6, §8, §10, §14) were scored on four criteria. Order follows the score and the dependencies, not the module layout of the spec.

| Criterion | Question |
|---|---|
| **Everyday value** | How often does one of the personas in SPEC §3 (Marta, Luca, Giulia, Paolo) hit this need? |
| **Spec commitment** | Did SPEC already promise it for "Release 2" (Windows/macOS, OCR, spike S4)? |
| **Dependency** | Does another feature need it first (OCR before text edit on scans, page scaling before "unify page size", batch queue after the single-file operations)? |
| **Risk / effort** | Engine capability available? Needs a new dependency? Needs a new platform? |

Each release mixes one **headline capability** (large, risky) with several **quick wins** (small, self-contained), so a release can always ship even if the headline slips to the next one. Every release also carries its own hardening budget (tests, interop, docs), as in R1 phases P8–P9.

### Finding that shapes the plan

SPEC §8.7 and §18 (R4) assume PDFium cannot write encrypted files, cannot redact, and cannot create form fields, so they require qpdf-WASM, a rasteriser and so on. The PDFium build actually in use (`@embedpdf/pdfium` 2.15.1, MIT) exports, among others, `EPDF_SetEncryption`, `EPDF_RemoveEncryption`, `EPDF_UnlockOwnerPermissions`, `EPDFPage_ApplyRedactions`, `EPDFText_RedactInRect`, `EPDFPage_CreateFormField`, `EPDFBookmark_*`, `FPDFPage_SetCropBox`, `FPDF_ImportNPagesToOne`, `FPDF_GetPageLabel` and `FPDFAnnot_AddInkStroke`. `setOutline` already uses the `EPDFBookmark_*` family in `packages/engine-pdfium/src/document.ts`. That does not prove the functions are *good enough* (algorithm, interop, edge cases), so each affected release starts with a short **verification spike** with a written ADR. If a spike fails, the fallback named in the release document applies. Net effect: R3 and R6 are less risky than the original spec implied.

---

## 1.1 Decisions of the product owner (2026-10-12)

| # | Decision | Effect |
|---|---|---|
| D1 | Auto-update is **off by default** | R2 FR-APP-14: opt-in with a one-time invitation |
| D2 | **No third UI language** in R2 | Italian only; framework validated by pseudo-locale and RTL fixtures |
| D3 | **No Mac available** | macOS is a CI-built, unsigned, un-notarised community build and not a release gate; notarisation deferred until a Mac or account exists |
| D4 | **Pattern-based redaction is admitted** in R3 | FR-SEC-10 stays; SPEC §17.4 to be amended on adoption |
| D5 | Native engine becomes **default on desktop after stabilisation** | R6 FR-ENG-02 with explicit criteria |

Still open: Windows code-signing route (R2), remaining per-release questions listed at the end of each document.

## 2. Roadmap at a glance

| Release | Codename | Theme | Headline | Quick wins |
|---|---|---|---|---|
| **R2 (v2.0)** | **Scan & Reach** | Open Folio to more people and to scanned documents | Local OCR (English, Italian) + Windows build (macOS as unsigned community build) | Italian UI + language framework, auto-update, reload on external change, export text, spike S4 |
| **R3 (v3.0)** | **Protect & Shrink** | Send documents safely and small | Compress / reduce file size | Set and remove password with permission flags, secure redaction, metadata scrub, hidden-data scan |
| **R4 (v4.0)** | **Pages & Batch** | Power page handling and repeatable work | Batch queue (GUI + CLI) | Crop, reverse, interleave, resize, N-up, page labels, split by bookmarks / size / odd-even, apply signature to many pages, library import/export, unify page size on merge, presentation mode, remappable shortcuts |
| **R5 (v5.0)** | **Compose & Edit** | Add and change content, not just fix it | Watermark, header/footer, page numbers, find & replace | Outline (bookmark) and link editor, freehand pen and highlighter, "trim content permanently" crop |
| **R6 (v6.0)** | **Forms & Scale** | Author forms, handle very large files | Create/edit form fields | Spellcheck in fields, form data import/export (FDF/XFDF), AI usage panel, native Rust engine for >500 MB files, PWA offline |

```
2.0 ── OCR, platforms, i18n, updater ─────────────┐
3.0 ── qpdf/encrypt/redact/compress ──────────────┤  each release = tracks A..D run in parallel
4.0 ── page ops, batch, CLI ──────────────────────┤  each track ends with its own gate
5.0 ── content composition, outline, ink ─────────┤
6.0 ── form authoring, native engine, XFDF ───────┘
```

### Coverage matrix: every deferred item has a home

| Deferred item (SPEC §17.0 / `Post-R1` tag) | IDs | Release |
|---|---|---|
| Windows and macOS builds | NFR-09, §14 | **R2** |
| Italian and other UI languages | NFR-12 | **R2** |
| Auto-update (updater, AppImageUpdate) | §11, §14 | **R2** |
| Reload on external change | FR-APP-08 | **R2** |
| Local OCR (English, Italian first) | FR-OCR-01…04 | **R2** |
| Export text | FR-OPT-05 | **R2** |
| Compress / reduce file size | FR-OPT-01 | **R3** |
| Set / remove password (AES-256), permission flags | FR-SEC-01, FR-SEC-02 | **R3** |
| Secure redaction | FR-SEC-03 | **R3** |
| Page crop, reverse order, odd/even interleave | FR-ORG-11, FR-ORG-12 | **R4** |
| Page labels display | FR-ORG-13 | **R4** |
| Resize/scale pages, N-up | FR-ORG-14 | **R4** |
| Split by bookmarks, by size, odd/even; batch queue | FR-MRG-04 (rest), FR-MRG-07 | **R4** |
| Apply signature/initials/stamp to many pages | FR-STM-04 | **R4** |
| Signature library import/export | FR-STM-11 | **R4** |
| Presentation (full-screen) mode | FR-VIEW-10 | **R4** |
| Remappable shortcuts (§7.6, §17.5 partial) | — | **R4** |
| Watermark, header/footer, page numbers | FR-EDT-10 | **R5** |
| Find & replace text | FR-EDT-09 | **R5** |
| Outline/bookmark and link editor | FR-EDT-11, FR-ANN-10 (editing) | **R5** |
| Freehand pen and highlighter | FR-ANN-05 | **R5** |
| Create/edit form fields | FR-FRM-08 | **R6** |
| Spellcheck in form fields | FR-FRM-04 | **R6** |
| AI cost/usage panel | FR-AIF-11 | **R6** |
| Native (Rust) PDF engine for very large files | §8.9 | **R6** |
| PWA service worker (offline web) | §14 | **R6** |
| FDF/XFDF form data import/export | §17.3 (basic) | **R6** |

### Explicitly **not** scheduled

These stay in SPEC §17.1–§17.5 as parking lot and are outside this roadmap: certificate-based signatures (the product owner excluded them), Office/HTML conversion, PDF/A and tagging, cloud and collaboration, scripting/plugins, XFA, form JavaScript, mobile apps, measurement tools, scanner acquisition, chat-with-PDF and other AI helpers. Each release document lists "horizon" items it prepares the ground for without implementing them.

---

## 3. Cross-release principles

1. **Services first, UI last** (SPEC §16) holds for every release: ports → engine adapter → service → app view-model → UI. The `ui-unlocked` gate is re-run per release in the form "release services complete".
2. **One new capability = one ADR before code.** Each release lists its spikes; ADR numbers continue from 0007.
3. **Ports grow additively.** New `PdfEngine` members are added as optional or in new interfaces (`OcrEngine`, `Encryptor`) so older adapters and the conformance suite stay valid. Breaking changes of a port are allowed only at a major release and need a migration note.
4. **Database changes are numbered migrations** (`0002_…`) that run unchanged on Node SQLite, desktop `rusqlite` and SQLite WASM (ADR 0005). Every migration has a rollback-free forward test with data from the previous release.
5. **Privacy invariants never regress** (NFR-14): no network call in default configuration. R2 adds two *user-initiated* network paths (language-data download, update check) and both are opt-in, visible and covered by the no-network e2e test with explicit allow-listing.
6. **Interop first.** Every writer feature is verified with the oracle set (`qpdf --check`, `pdfcpu validate`, `mutool`, `pdftoppm`, `pdftotext`) plus a viewer matrix that now includes Windows and macOS viewers from R2.
7. **Honest UI.** Features with limits (OCR accuracy, lossy compression, redaction by rasterisation, N-up of rotated pages) say so before commit, in line with SPEC §4.5.
8. **Licensing check** (`pnpm licenses`) is part of the DoD for every new dependency; GPL-3.0-or-later compatibility is stated in the release document.

## 4. Adoption procedure for a release

1. Product owner reviews the release document; open questions (last section of each document) are answered.
2. SPEC §5 table and §17.0 list are amended: the features move from "deferred" to "included in Release N"; the `Post-R1` tags in §6 are replaced by the release label.
3. `docs/PROGRESS.md` gets one phase table per release (template in each document: "Delivery plan").
4. `CLAUDE.md` scope paragraph is updated to name the current release; the spec-guardian agent is told which deferred list applies.
5. Spikes run, ADRs are written, then the tracks start.

## 5. Dependency graph between releases

```
R2 OCR ───────────────► R5 find & replace works on OCR'd text
R2 spike S4 ──────────► R3 encrypt / compress decision
R2 i18n framework ────► every later release ships IT strings with the feature
R2 updater ───────────► makes R3..R6 deliverable to existing users
R3 rasterise + recompress ──► R4 "unify page size" and R5 "trim content" reuse page scaling and re-render
R4 batch queue ───────► R6 native engine is the batch worker for large files
R4 page scaling ──────► R5 header/footer margins, R6 form fields on resized pages
R5 outline editor ────► R4 split by bookmarks only needs the *read* outline (already in R1), so no hard dependency
R6 native engine ─────► needs conformance suite (R1) + R4 batch queue
```

## 6. Estimates and capacity

Sizes are relative (S ≈ days, M ≈ 1–2 weeks, L ≈ 3–5 weeks, XL ≈ 6+ weeks) for one developer pairing with Claude Code under the same TDD recipe used for Release 1. They are planning aids, not commitments; each release document refines them after its spikes.

| Release | Headline size | Whole release (indicative) | Biggest risk |
|---|---|---|---|
| R2 | L (OCR) + L (platforms) | ~10–14 weeks | Signing/notarisation logistics; OCR accuracy and size on weak hardware |
| R3 | L (compress) | ~8–10 weeks | Lossy recompression quality; redaction correctness proof |
| R4 | M (batch) + many S | ~8–10 weeks | Breadth: many small features each needing UI and tests |
| R5 | L (content composition) | ~8–10 weeks | Font handling for header/footer text; replace in subset fonts |
| R6 | XL (native engine) + L (form designer) | ~12–16 weeks | Native engine parity; widget appearance generation |

## 7. Documents

| Release | Specification |
|---|---|
| R2 | [release-2-scan-and-reach.md](release-2-scan-and-reach.md) |
| R3 | [release-3-protect-and-shrink.md](release-3-protect-and-shrink.md) |
| R4 | [release-4-pages-and-batch.md](release-4-pages-and-batch.md) |
| R5 | [release-5-compose-and-edit.md](release-5-compose-and-edit.md) |
| R6 | [release-6-forms-and-scale.md](release-6-forms-and-scale.md) |

Research sources used for this roadmap are listed at the end of each release document and in `docs/roadmap/SOURCES.md`.
