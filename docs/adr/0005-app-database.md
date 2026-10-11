# 0005 — Application database (spike S5)

- **Status:** accepted · **Date:** 2026-10-11 · **Resolves:** SPEC §9, §11.1, spike S5

## Decision
- One set of migrations (`packages/db/src/migrations/*.sql`, embedded by `tools/sync-migrations.ts`) and repositories that only use the `Database` port.
- **Desktop:** `rusqlite` (bundled SQLite) behind two commands, `db_execute` and `db_select`, on a single connection — instead of `tauri-plugin-sql`. The plugin uses a connection pool, so the SAVEPOINT-based transactions the repositories issue from the frontend could run on different connections.
- **Web:** SQLite WASM in memory, persisted as a whole file to OPFS after writes. This needs neither a worker nor cross-origin isolation, and app data is small.
- **Binary columns** (signature PNGs, thumbnails) hold base64 text so every driver, including JSON-based IPC, round-trips them identically.

## Consequences
The same repository test-suite passes on Node's SQLite and on SQLite WASM. Deviation from the SPEC's suggested plugin is confined to the Tauri adapter and the Rust crate.

## Evidence
`packages/db/src/db.test.ts` (runs every test on both drivers), Rust tests in `apps/desktop/src-tauri/src/db.rs`.
