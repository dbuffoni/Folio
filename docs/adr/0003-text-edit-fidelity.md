# 0003 — Line-level text editing (spike S3)

- **Status:** accepted · **Date:** 2026-10-11 · **Resolves:** SPEC §8.7 (text editing algorithm), risk R2

## Decision
- The editable unit is a line: adjacent runs on one baseline with equal font, size and colour (`groupLines` in core).
- **Font reuse rule.** A non-embedded font is reused when the edited text round-trips through the engine. An *embedded* font is treated as a possible subset whatever its name: it is reused only when every new character has already been drawn with that font in the document (the page itself, then up to 40 neighbouring pages). Otherwise the whole line is re-created in the nearest bundled Liberation family (metric-compatible with Arial/Times/Courier) and the result says so.
- The first text object of the line receives the whole new text; the line's other objects are removed from the content stream. Undo restores a snapshot, so the page bytes come back exactly.
- Overflow is measured against the next object on the same row or a 36 pt right margin; "shrink to fit" is offered up to 15 %.
- Rotated text and text inside form XObjects are not editable in Release 1 (clear message).

## Consequences
- Conservative for fully embedded fonts (may substitute where reuse was possible), never wrong the other way: no silently missing glyphs.
- A substituted line embeds a full Liberation face (≈ 400 KB per face). Subsetting is future work together with compression.

## Evidence
Conformance "page content objects", `packages/services/src/content.test.ts` (TextEditService), `packages/app/src/epics.test.ts` (E3) — text verified with `pdftotext`, fonts with `pdffonts`, page content with `qpdf --qdf`.
