# 0004 — Keeping form fields when pages move between documents

- **Status:** accepted · **Date:** 2026-10-11 · **Resolves:** FR-MRG-02, SPEC §8.7 (complementary libraries)

## Context
`FPDF_ImportPages` copies widget annotations but neither their parent field dictionaries nor the AcroForm entry: after saving, imported forms are no longer forms (and `/Parent` points at unrelated objects).

## Decision
When the source document has form fields, `importPages` goes through the structural helper: both documents are serialised, **pdf-lib** copies the pages (it deep-copies the field tree), and `formrepair.ts` rebuilds `/AcroForm /Fields` from the widgets present, prunes kids of pages that were not copied, and renames colliding root fields (`name`, `name_2`, …). The engine then reloads the result. There are never two writers on a live document.

Field values are written through PDFium's form filler (focus → edit → blur), the path a viewer uses, so values, widget states and appearance streams stay consistent. No JavaScript engine is attached.

## Consequences
- Merging, inserting, duplicating and extracting pages keep forms working; verified with pdfcpu.
- Costs a save/load of both documents, only for sources that have forms.
- Encrypted sources that pdf-lib cannot read fall back to the plain import (pages kept, fields static).

## Evidence
`packages/services/src/structure.test.ts` (MergeService), conformance "forms".
