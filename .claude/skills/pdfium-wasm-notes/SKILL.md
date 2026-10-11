---
name: pdfium-wasm-notes
description: PDFium WASM cheat-sheet for packages/engine-pdfium — API groups, memory rules and pitfalls. Use when touching the engine adapter.
---
Engine build: `@embedpdf/pdfium` (MIT wrapper, PDFium BSD-3/Apache-2.0), pinned exactly. See `docs/adr/0001-pdf-engine-packaging.md`.

**Memory**
- Everything passed by pointer lives in the WASM heap: `malloc` → write → call → read → `free`. Use the helpers in `engine-pdfium/src/mem.ts` (`withBytes`, `utf16`, `readUtf16`, `outFloats`), never raw `HEAP*` arithmetic in feature code.
- The document buffer given to `FPDF_LoadMemDocument` must stay allocated until `FPDF_CloseDocument`.
- Close in reverse order: text page → page → form handle → document. Every `FPDF_LoadPage` needs `FPDF_ClosePage`; every `FPDFPage_GetAnnot` needs `FPDFPage_CloseAnnot`.
- Strings: PDFium takes UTF-16LE (`FPDF_WIDESTRING`) for text and returns UTF-16LE with a byte length that includes the terminator.

**API groups**
- Pages: `FPDF_GetPageCount`, `FPDFPage_New/Delete`, `FPDF_ImportPagesByIndex`, `FPDF_MovePages`, `FPDFPage_SetRotation`.
- Render: `FPDFBitmap_CreateEx` (BGRA) + `FPDF_RenderPageBitmap` (+ `FPDF_FFLDraw` for form widgets). Convert BGRA → RGBA once in the adapter.
- Text: `FPDFText_LoadPage`, `CountChars`, `GetUnicode`, `GetCharBox`, `GetFontInfo`, `GetTextObject`; search with `FPDFText_FindStart`.
- Objects: `FPDFPage_CountObjects/GetObject`, `FPDFPageObj_*`, `FPDFText_SetText`, `FPDFPage_RemoveObject` + `FPDFPageObj_Destroy`, then **`FPDFPage_GenerateContent`** or the change is lost on save.
- Annotations: `FPDFPage_CreateAnnot`, `FPDFAnnot_*`, `EPDFAnnot_GenerateAppearance` for the appearance stream.
- Forms: `FPDFDOC_InitFormFillEnvironment` with a zeroed `FPDF_FORMFILLINFO` (version 2); JavaScript is never executed (no `IJS` platform).
- Save: `FPDF_SaveAsCopy(doc, FPDF_FILEWRITE*, flags)` with a JS callback registered through `addFunction`; flag 1 = incremental, 2 = no incremental.

**Pitfalls**
- Subset fonts: `FPDFText_SetText` silently drops glyphs missing from the subset; check coverage first and substitute a bundled font.
- After any object edit, reload the text page before reading text again.
- `FPDF_ImportPages` copies widgets but not the AcroForm field tree names; collisions are handled in `MergeService`.
- PDFium cannot write encrypted files (Post-R1 anyway).
