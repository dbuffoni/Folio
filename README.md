<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/folio-logo-horizontal-dark.svg">
    <img src="assets/branding/folio-logo-horizontal.svg" alt="Folio" width="320">
  </picture>
</p>

# Folio

Folio is an open-source editor for everyday PDF work: reorder, rotate and delete pages, merge and
split files, turn images into PDFs, highlight and comment, sign, fill forms (including ones that are
not fillable) and fix small text mistakes. Everything runs on your device; no file leaves it.

It ships as a Linux AppImage (Tauri 2) and as a web build of the same code.

> Status: Release 1 scope is implemented and tested. It has not yet been tried by people outside the
> project, and the release workflow has not run on GitHub. See [docs/PROGRESS.md](docs/PROGRESS.md).

## What it does

| Area | In Release 1 |
| --- | --- |
| Viewer | Continuous, single and two-page layouts, zoom, thumbnails, outline, search, tabs, dark/sepia page themes, print |
| Organise | Reorder by drag or keyboard, rotate, delete, duplicate, extract, insert blank or from file, replace |
| Merge and split | Merge PDFs and images with per-file page ranges and bookmarks; split by ranges, every N pages, single pages or cut points |
| Annotate | Highlight, underline, strikethrough, squiggly, notes, text boxes, shapes, comments list, flatten |
| Sign and stamp | Draw, type or import a signature; initials, date, check and cross marks, custom stamps |
| Forms | Fill AcroForms with Tab order and autocomplete from profiles; type on flat forms with detected areas |
| Smart Fill | Maps profile data to form fields on the device; optionally through an OpenAI-compatible service after a pre-flight review |
| Edit | Change a line of text in place (original font when its glyphs allow, otherwise a metric-compatible one), add text and images, whiteout |

Signatures are electronic (an image on the page), not certificate-based digital signatures.
Deferred features are listed in SPEC §17.0.

## Try it

```bash
pnpm install
pnpm dev                 # web build at http://localhost:5173
pnpm cli info some.pdf   # the same services from the command line
```

Building the AppImage, the system packages it needs and the test tools are described in
[docs/BUILDING.md](docs/BUILDING.md).

## How it is built

```
packages/ports           interfaces: PdfEngine, Platform, AiProvider (PDF user-space coordinates)
packages/core            errors, geometry, page ranges, undo history, settings
packages/engine-pdfium   PDFium (WASM) behind PdfEngine; runs in Node and in a Web Worker
packages/services        page, merge, split, annotations, forms, text edit, signatures, Smart Fill …
packages/db              SQLite schema and repositories (recent files, profiles, signatures)
packages/ai              OpenAI-compatible provider with strict schemas
packages/app             UI-less application layer: sessions, tools, wizards, commands, shortcuts
packages/testkit         fixture builders, external oracles, matchers
apps/cli                 folio-cli, the headless entry point
apps/web                 SvelteKit UI, bound to packages/app
apps/desktop             Tauri 2 shell (Rust): scoped files, keyring, SQLite, HTTP proxy
```

Services were built and tested before any screen existed; the UI only binds to view-models that
already pass their tests. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is a one-page map of the
code, [SPEC.md](SPEC.md) is the full specification and
[docs/adr](docs/adr) records the decisions that deviate from or refine it.

## Tests

| Command | What runs |
| --- | --- |
| `pnpm test` | unit tests of every package, including the epics as headless scenarios |
| `pnpm test:conformance` | the PdfEngine contract, directly and through the worker boundary |
| `pnpm test:interop` | output checked with qpdf, pdfcpu, poppler and MuPDF; golden images |
| `pnpm bench` | performance budgets that can be measured headlessly |
| `pnpm test:e2e` | Playwright on Chromium, Firefox and WebKit: epics, screens, axe, no-network |
| `pnpm appimage:smoke` | the built AppImage under Xvfb, driven over WebDriver |
| `pnpm trace` | requirement-to-test matrix ([docs/traceability.md](docs/traceability.md)) |
| `pnpm gate P9` | all of the above as one release gate |

## Privacy

No telemetry, no accounts, no network calls by default; an end-to-end test fails on any outbound
request. Smart Fill contacts a service only after you add a key, and shows what will be sent first.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture rules, test conventions and
definition of done.

## Licence

GPL-3.0-or-later. Third-party components are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); bundled fonts are under the SIL Open Font License.
