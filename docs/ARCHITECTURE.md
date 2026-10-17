# Architecture

A one-page map of how Folio is put together. The full specification is [SPEC.md](../SPEC.md) §8;
where the code differs from it, the reason is in [docs/adr](adr) (notably
[0006](adr/0006-port-and-toolchain-deviations.md)).

## In one paragraph

One SvelteKit app (static SPA) runs unchanged in a Tauri 2 shell and as a website. All PDF work is
done by PDFium compiled to WebAssembly in a Web Worker. Business logic is plain TypeScript that
depends only on interfaces ("ports"); the browser and the desktop supply the implementations
("adapters"). Rust does only what a browser cannot do.

## Layers

```
apps/web  ─ Svelte UI (lib/ui, routes) · adapters: engine worker, platform/web, platform/tauri
   │
packages/app      view-models: AppModel, DocumentSession, ToolController, dialogs, command registry
   │
packages/services one service per area: document, page, merge, split, annotation, form, …
   │
packages/core     command bus + history, geometry, events, settings, errors, ranges, text layer
   │
packages/ports    interfaces only: PdfEngine, FileService, Database, SecretStore, HttpClient, …

adapters (implement ports)
  packages/engine-pdfium   PdfEngine over PDFium WASM, plus the worker RPC
  packages/db              migrations and repositories over the Database port
  packages/ai              OpenAI-compatible provider for Smart Fill
  apps/web/src/lib/platform  web.ts (File System Access, OPFS, SQLite WASM) and tauri.ts
  apps/desktop/src-tauri     Rust: scoped file I/O, keyring, HTTP proxy, SQLite, OS integration
```

| Package | Role | May import |
|---|---|---|
| `ports` | Types and interfaces; no code with side effects | nothing |
| `core` | Pure logic shared by everything | `ports` |
| `services` | PDF operations expressed as commands | `core`, `ports` |
| `app` | State the UI binds to; no DOM, no Svelte | `services`, `core`, `ports`, `db`, `ai` |
| `engine-pdfium` | The only code that knows PDFium; no PDFium type leaves it | `core`, `ports` |
| `db`, `ai` | Persistence and AI adapters | `core`, `ports` |
| `testkit` | Fixture builders, fakes and oracles for tests only | anything |
| `apps/web` | Svelte components and platform wiring | packages; Tauri only in `platform/tauri.ts` |
| `apps/cli` | `folio-cli`, a headless driver over the same services | packages |

The arrows are enforced by `pnpm lint` (`.dependency-cruiser.cjs` plus ESLint): packages never import
`apps/*`, logic packages never import Node built-ins or `@tauri-apps/*`, `app` never sees the engine
except through the port, and cycles are errors.

## Conventions that hold the design together

- **Coordinates** at every port are PDF user space: points, origin bottom-left, y up, before page
  rotation. Conversion to screen space happens only in `@folio/core` geometry helpers.
- **Every document change is a `Command`** run through the session's command bus
  (`core/history.ts`). A command declares what it invalidated, so views re-render only that. Undo is
  either a real inverse or a checkpoint snapshot; the same snapshots back crash recovery
  (`services/recovery.ts`).
- **Errors** are typed `FolioError` subclasses with a stable code; the UI maps them to messages in
  `apps/web/src/lib/i18n/messages/en.json`. No user-facing string lives outside that file.
- **Models emit `changed`**; `apps/web/src/lib/live.svelte.ts` turns that into Svelte reactivity so
  models stay framework-free and testable in Node.

## How a user action flows

```
click / shortcut / palette entry
  → CommandRegistry (app/registry.ts) finds the AppCommand, checks `when`
  → ToolController or a feature model (app/tools.ts, app/features.ts)
  → service builds a Command (services/*.ts)
  → DocumentSession.run → History.apply → PdfEngine (RPC to the worker)
  → Command reports an Invalidation → models emit `changed` → Svelte re-renders
```

## The PDF engine

`PdfEngine` (`ports/engine.ts`) is the contract; `engine-pdfium` implements it on
`@embedpdf/pdfium`. In the app it runs inside a Web Worker and the UI holds a proxy created by
`connectEngine` over the typed RPC in `engine-pdfium/src/rpc.ts`; in tests and the CLI the same code
runs directly in Node. Rendering returns RGBA bytes (`RasterImage`) so services stay testable headlessly; behind the worker
boundary the RPC layer turns them into an `ImageBitmap` so the UI thread draws without copying. Details: [ADR 0001](adr/0001-pdf-engine-packaging.md),
[0002](adr/0002-annotation-appearance-streams.md), [0003](adr/0003-text-edit-fidelity.md).

## Platform and storage

`createPlatform()` (`apps/web/src/lib/platform/index.ts`) picks the adapter set once at start-up and
imports the Tauri module dynamically, so the website bundle contains no Tauri code.

| Concern | Web | Desktop (Tauri) |
|---|---|---|
| Files | File System Access API, with input/download fallback | Rust commands inside a dynamic scope: only paths the user handed over |
| App database | SQLite WASM in memory, persisted to OPFS | `rusqlite` behind `db_execute` / `db_select` |
| Secrets | Passphrase-encrypted store or memory | OS keyring, memory if no daemon |
| AI requests | Direct `fetch` to the configured endpoint | Rust HTTP proxy with a confirmed host |
| Recovery files | OPFS, else IndexedDB | App data directory |

Database schema and migrations: `packages/db/src/migrations`, decisions in
[ADR 0005](adr/0005-app-database.md). Nothing leaves the device unless the user switches on Smart
Fill with their own key (SPEC §12).

## UI structure

`apps/web/src/lib/ui` holds components only: title bar and tabs, mode bar (View, Organise, Annotate,
Fill & Sign, Edit), toolbar per mode, sidebar (thumbnails, outline, annotations, attachments,
search), inspector, canvas and page views, status bar, dialogs, command palette. They read models
through `live()` and call model methods; they hold no business rules.

## Testing and verification

| Suite | Command | What it proves |
|---|---|---|
| Unit | `pnpm test` | services, models, core, db against the real engine in Node |
| Conformance | `pnpm test:conformance` | every `PdfEngine` implementation, also through the RPC boundary |
| Interop | `pnpm test:interop` | output checked by qpdf, pdfcpu, mutool, poppler; golden images |
| E2E | `pnpm test:e2e` | Playwright against the web build, three browsers, axe, visual baselines |
| Traceability | `pnpm trace` | every Release 1 requirement has a test ([matrix](traceability.md)) |

Fixtures are generated by `packages/testkit` builders, not stored as binaries.

## Where to start

| To change… | Look at |
|---|---|
| What an operation does to the PDF | `packages/services/src/<area>.ts` |
| What the UI can do and in which order | `packages/app/src/{tools,features,registry}.ts` |
| How something looks | `apps/web/src/lib/ui/*.svelte`, `apps/web/src/app.css` |
| A new platform capability | add to `ports/platform.ts`, implement in `platform/web.ts` and `platform/tauri.ts` (+ Rust command) |
| A deviation from the spec | write an ADR from `docs/adr/0000-template.md` |
