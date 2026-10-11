# 0006 — Port and toolchain deviations from the SPEC text

- **Status:** accepted · **Date:** 2026-10-11 · **Resolves:** SPEC §8.4, §8.5, §7.8, §11

| Area | SPEC text | What was built | Why |
|---|---|---|---|
| Render result | `ImageBitmap` | `RasterImage` (RGBA bytes) | `ImageBitmap` does not exist in Node; services must be testable headlessly. The UI turns it into `ImageData`. |
| Engine port | no annotation z-order, no text rasteriser | `reorderAnnotations`, `flattenAnnotations(pages, types)`, `renameField`, `getImage`/`replaceImage`, `rasterizeText`, `listAttachments` | Needed by FR-ANN-06, FR-STM-08, FR-MRG-02, FR-EDT-07, FR-STM-02, FR-VIEW-02. `setCropBox`, `rasterizePage`, `encrypt` are Post-R1 and absent. |
| Platform port | — | `AppStorage`, `CryptoService`, `ImageCodec`, `Clock`, `Logger` added | Recovery files, at-rest encryption and image encoding need platform services; keeps core free of globals. |
| Secrets fallback | passphrase-encrypted file on desktop | in-memory for the session when no keyring daemon answers (UI says so); passphrase-encrypted store on the web | Honest and simple; a passphrase file can be added without touching features. |
| AI host allow-list | "user-configured AI base URL only" | the origin is stored by Rust and can only be changed after a **native confirmation dialog** | Page content cannot redirect requests (and the key) elsewhere. |
| i18n library | Paraglide JS / svelte-i18n candidates | small in-house formatter (`{name}` params and `{count, plural, one {…} other {…}}`) with `en.json` | Enough for Release 1 (English only), no runtime dependency; a later switch only touches `i18n/`. |
| Typed bindings | specta / tauri-specta | hand-written adapter (`platform/tauri.ts`) | Twenty commands; generated bindings would add a build step for little gain. |
| Tooling | SvelteKit 2, TypeScript 5 implied | SvelteKit 3 (config via the Vite plugin), Svelte 5, Vite 8, TypeScript 6, Vitest 5, Tailwind 4 | Current stable releases at project start. |
| Subagents | test-author / implementer agents per service | definitions are in `.claude/agents`; the first build was done in one session, test-first per service | Same recipe, one executor. |
| Merge option "unify page size" | P0 option, off by default | not implemented | Needs page scaling, which is Post-R1 (FR-ORG-14). Listed in PROGRESS as a gap. |
