---
name: pdf-fixture-builder
description: Add a deterministic test PDF fixture. Use when a test needs a new kind of PDF.
---
- Builders live in `packages/testkit/src/fixtures/` and are plain async functions returning `Uint8Array`, built with pdf-lib (a test-only dependency, independent from the PDFium engine under test).
- Deterministic: fixed creation/modification dates, no random ids, seeded content. The same builder must return the same bytes on every run.
- Register the builder in `fixtures/index.ts` (`FIXTURES` map: name → builder + description + `expectValid`). `pnpm fixtures:build` writes them to `fixtures/generated/` and refreshes `fixtures/manifest.json` (name, sha256, size, pages).
- Intentionally broken fixtures set `expectValid: false` so the `qpdf --check` sweep skips them.
- Third-party corpora are never committed: add a URL + sha256 entry under `fetched` in `fixtures/manifest.json` and use `pnpm fixtures:fetch`.
- No real personal data. Use the personas from `fixtures/people.ts` (clearly fictional).
