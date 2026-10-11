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
| P8 User interface | in progress | see below |
| P9 Release hardening | not started | |

Run `tools/gate.sh <phase>` to re-check a gate, `pnpm trace` for the requirement matrix (`docs/traceability.md`).

## Known gaps

- **Merge option "unify page size"** (part of FR-MRG-02) is not implemented; it needs page scaling (Post-R1 machinery).
- **CJK fixture** is missing (no CJK font is bundled or installed); Greek, Cyrillic, Hebrew and Polish text are covered.
- **FakePdfEngine** was not written: services are tested against the real engine, which starts in ~20 ms in Node. View-model tests use it too.
- **Golden-image baselines** are not committed; render checks compare against poppler/MuPDF renders and ink/colour probes instead.
- **Distro matrix, signing, SBOM, release workflow run** — configured in CI files but never executed on GitHub.
- **Usability tests (§7.9)** and a manual screen-reader pass need people.
