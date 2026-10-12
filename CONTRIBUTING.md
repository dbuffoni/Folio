# Contributing to Folio

Thanks for your interest. Folio is licensed under GPL-3.0-or-later; by contributing you agree that
your work is released under the same licence.

## Before you start

- Read [SPEC.md](SPEC.md). The Release 1 scope is fixed in §5 and the deferred features are listed
  in §17.0. A change that needs a `Post-R1` feature will not be accepted; open an issue to discuss
  it instead.
- Skim [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the packages fit together.
- Set up the toolchain as described in [docs/BUILDING.md](docs/BUILDING.md).
- For anything larger than a bug fix, open an issue first so the approach can be agreed.

## Architecture rules

These are enforced by `pnpm lint` (dependency-cruiser and ESLint).

- Business logic depends on the interfaces in `packages/ports`.
- `packages/core`, `packages/services` and `packages/app` never import Tauri, DOM APIs, Node
  built-ins or anything under `apps/*`.
- `packages/engine-pdfium` is the only place that knows PDFium; no PDFium type leaves it.
- Port coordinates are PDF user space (points, origin bottom-left, y up, before page rotation).
  Convert with the `@folio/core` geometry helpers.
- Every document change is a `Command` run through the session's command bus, so undo/redo and
  recovery keep working.
- Rust (`apps/desktop/src-tauri`) only does what a browser cannot: file I/O, keyring, HTTP proxy,
  OS integration.

## Workflow

1. **Services first, UI last.** Logic goes into `packages/*` with tests; screens in `apps/web`
   only bind to view-models that already pass their tests.
2. **Test first.** Tag each test title with the requirement IDs it proves, for example
   `it('rotates pages @FR-ORG-04', …)`. `pnpm trace` fails if a Release 1 requirement has no test.
3. **Verify PDF output with independent tools** (`qpdf --check`, `pdfcpu validate`, `mutool`,
   `pdftoppm`, `pdftotext`) rather than only with Folio's own engine. The `testkit` oracles wrap
   these.
4. **Fixtures are generated**, not committed. Add a builder in `packages/testkit`; no binary
   fixture over 200 KB goes into git.
5. **No skipped tests** without a linked issue.
6. **Record decisions** that deviate from or refine the spec as an ADR in
   [docs/adr](docs/adr) (start from `0000-template.md`).

## Definition of done

A feature is done when it has:

- the requirement IDs it satisfies, named in the tests;
- unit tests and an end-to-end test;
- a keyboard path;
- dark and light themes checked;
- every user-facing string in `apps/web/src/lib/i18n/messages/en.json` (English only; no literals
  in components);
- accessibility checks passing (axe runs in the e2e suite);
- updated documentation;
- no new dependency without a licence check (`pnpm run licenses`) and an entry in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Before opening a pull request

```bash
pnpm lint && pnpm check
pnpm test
pnpm test:conformance
pnpm test:interop      # when you touched anything that writes PDFs
pnpm test:e2e          # when you touched the UI
pnpm trace
```

Coverage gates for `packages/services` and `packages/core` are 90 % lines and 80 % branches
(`pnpm coverage`).

Keep pull requests focused: one change, tests included, a description that says what and why.

## Reporting bugs and security issues

Open an issue with the steps to reproduce and, if possible, a minimal PDF. Do not attach documents
containing personal data. For security-sensitive reports, contact the maintainer privately rather
than opening a public issue.
