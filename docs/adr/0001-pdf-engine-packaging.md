# 0001 — PDF engine packaging (spike S1)

- **Status:** accepted · **Date:** 2026-10-11 · **Resolves:** SPEC §8.7, spike S1

## Context
The engine must be PDFium compiled to WebAssembly, identical on desktop and web, and usable headlessly in Node for tests.

## Options considered
1. Own Emscripten build of upstream PDFium — full control, heavy toolchain and maintenance.
2. `@embedpdf/pdfium` (MIT wrapper, PDFium BSD-3/Apache-2.0) — prebuilt, exports ~590 functions including object editing, annotations, form filling and extensions for appearance streams, bookmarks, metadata and flattening.

## Decision
Use `@embedpdf/pdfium` pinned to **2.15.1** behind `packages/engine-pdfium`. No PDFium type leaves that package.

## Consequences
- Same code path in Node (tests, CLI) and in a Web Worker. Init ≈ 20 ms, a Letter page renders in ≈ 2 ms at 72 dpi in Node.
- The UI talks to the worker through `rpc.ts`; the whole conformance suite also runs through that boundary.
- WebKitGTK (Tauri on Linux): the walking-skeleton AppImage runs under Xvfb with `WEBKIT_DISABLE_DMABUF_RENDERER=1`; rendering uses `ImageData` transfers, so `OffscreenCanvas` is not required.
- Upgrading the engine is a version bump plus `pnpm test:conformance`.

## Evidence
`tests/conformance/pdfium.test.ts`, `tests/conformance/pdfium-rpc.test.ts`, `packages/engine-pdfium/spikes/s1-node.ts`, `apps/desktop/scripts/smoke.mjs`.
