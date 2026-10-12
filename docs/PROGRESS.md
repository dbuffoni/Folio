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

Run `tools/gate.sh <phase>` to re-check a gate, `pnpm trace` for the requirement matrix (`docs/traceability.md`).

## Known gaps

Not implemented

- **Print scale** (part of FR-VIEW-09): the print dialog of Folio offers page range and copies; scale is chosen in the browser or system print dialog, which a print frame cannot preset. Folio-side scaling needs page scaling (Post-R1 machinery).
- **Merge option "unify page size"** (part of FR-MRG-02): needs page scaling (Post-R1 machinery).
- **FakePdfEngine**: services and view-models are tested against the real engine, which starts in ~20 ms in Node.
- **CJK fixture**: no CJK font is bundled or installed; Greek, Cyrillic, Hebrew and Polish text are covered.

Implemented but not verified where it matters

- **CI has never run.** `.github/workflows/ci.yml` and `release.yml` were written without a GitHub
  runner to try them on; expect to fix details on the first push. The distro matrix (Fedora, Arch,
  older glibc), AppImage signing and the SBOM step are untested.
- **Screens without a browser test.** The e2e suite (33 scenarios on three browsers) covers the
  seven epics, every mode and tool group, the main dialogs and accessibility scans. Not driven in a
  browser: custom stamp editor, drag-and-drop reordering (keyboard and buttons are tested), printing,
  clipboard paste, the recovery prompt, Smart Fill with a real AI key, profile import/export, image
  resize handles. Their view-models are tested headlessly.
- **Desktop-only paths.** Native file dialogs, the keyring, drag-and-drop from the file manager and
  the single-instance hand-off are covered by Rust unit tests and the smoke test's IPC checks, not
  by a UI flow (WebDriver cannot operate native dialogs).
- **Performance in the real UI.** NFR-02/04/05 budgets are measured on the engine in Node; start-up
  time (NFR-01) and scrolling frame rate (NFR-03) were not measured in the AppImage.
- **Visual baselines** are compared only on the machine that rendered them.
- **Smart Fill accuracy** (≥ 85 %) is measured on the generated forms corpus, not on real-world forms.

Needs people

- Usability tests (§7.9), a manual screen-reader pass, and opening output in Acrobat Reader and
  Preview (poppler, MuPDF, qpdf and pdfcpu are automated).
