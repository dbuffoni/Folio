# 0002 — Annotation appearance streams (spike S2)

- **Status:** accepted · **Date:** 2026-10-11 · **Resolves:** SPEC §8.7 (annotations), risk R3

## Context
Annotations must be standard PDF objects with appearance streams so other viewers show them.

## Decision
- Highlight, underline, strikeout, squiggly, note, free text, square, circle, line (with endings), polyline and ink use the engine build's `EPDFAnnot_GenerateAppearance`.
- Stamps (signatures, built-in and custom stamps, dates, check/cross marks) are built from page objects appended to a Stamp annotation: image, vector paths, or framed text in a bundled font. Rotation is baked into the objects.
- The semantic stamp name is stored in `/Subj`; ids in `/NM` so undo/redo can recreate the same annotation.

## Consequences
- Every type renders the same in PDFium, poppler and MuPDF (checked in tests).
- Free text that sets a default appearance makes PDFium add an `/AcroForm` with `/DA` and `/DR` but no `/Fields`; poppler prints "Can't get Fields array", which is harmless and whitelisted in the validity matcher.
- The typed getter for a free-text font only recognises Helvetica, so the family is read from `/DA`.

## Evidence
`packages/engine-pdfium/spikes/s2-annots.ts`, conformance tests "annotations", `packages/services/src/content.test.ts`.
