# Folio

Open-source everyday PDF editor (GPL-3.0-or-later). Tauri 2 + SvelteKit + TypeScript + Tailwind, PDFium WASM engine, SQLite. Full specification: [SPEC.md](SPEC.md). UI mockup: [docs/mockup/index.html](docs/mockup/index.html).

## Scope

- Release 1 (0.1.0) is delivered; its scope is SPEC §5. Development is in phase P10: incremental releases built from the Notion plan (SPEC §16.10).
- **Build only cards of the current release that are Ready.** A `Post-R1` feature or a §17.0 entry outside that set stays out of scope; if a task seems to need one, stop and say so.
- UI language is English only; every user-facing string goes through i18n (`apps/web/src/lib/i18n/messages/en.json`).

## Architecture rules

- Ports and adapters. Business logic depends on interfaces in `packages/ports`.
- `packages/core`, `packages/services`, `packages/app` never import Tauri, DOM APIs, Node built-ins, or anything under `apps/*`. Enforced by `pnpm lint` (dependency-cruiser + ESLint).
- `packages/engine-pdfium` is the only place that knows PDFium. No PDFium type leaks out of it.
- All port coordinates are PDF user space: points, origin bottom-left, y up, before page rotation. Convert in `@folio/core` geometry helpers.
- Every document change is a `Command` run through the session's command bus (undo/redo, recovery).
- Rust (`apps/desktop/src-tauri`) only does what a browser cannot: file I/O, keyring, HTTP proxy, OS integration.

## Working agreement

- Services first, UI last. `apps/web/src/lib/ui` and `apps/web/src/routes` are locked by a hook until `.claude/state/ui-unlocked` exists (created by the `services-complete` gate, phase P7).
- Test first. Tag every test title with the requirement IDs it proves, e.g. `it('rotates pages @FR-ORG-04', …)`.
- No skipped tests without a linked issue. No binary fixtures over 200 KB in git; fixtures are built by `packages/testkit` builders.
- Verify PDF output with independent oracles (`qpdf --check`, `pdfcpu validate`, `mutool`, `pdftoppm`, `pdftotext`).
- Decisions from spikes are recorded as ADRs in `docs/adr`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm test` | unit tests (packages, cli, tools) |
| `pnpm test:conformance` | `PdfEngine` conformance suite (every engine implementation) |
| `pnpm test:interop` | oracle and golden-image tests |
| `pnpm test:e2e` | Playwright against the web build |
| `pnpm trace` | requirement ↔ test traceability matrix; fails on untested Release 1 requirements |
| `pnpm lint` / `pnpm check` | ESLint + dependency rules + Prettier / type-check |
| `pnpm fixtures:build` | write generated fixtures to `fixtures/generated` |
| `pnpm cli -- <cmd>` | `folio-cli` dev driver, e.g. `pnpm cli -- merge a.pdf b.pdf -o out.pdf` |
| `pnpm appimage` / `pnpm appimage:smoke` | build the AppImage / launch it under Xvfb and run the smoke scenario |

Toolchain lives in `~/.local/bin` (node, pnpm, pdfcpu) and `~/.cargo/bin`; make sure both are on `PATH`.

## Definition of Done (per feature)

Requirement IDs satisfied · unit + e2e tests · keyboard path · dark/light checked · i18n keys · a11y checks · docs updated · no new dependency without a licence check (`pnpm licenses`).

## Phase gates

Run `/gate <phase>`: tests green, coverage gates met (services/core ≥ 90 % lines, ≥ 80 % branches), `pnpm trace` complete for the phase, spec-guardian review, AppImage built and smoke-tested. Phases are listed in SPEC §16.6; progress is tracked in [docs/PROGRESS.md](docs/PROGRESS.md).
