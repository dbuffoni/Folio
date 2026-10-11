---
name: pdf-interop-check
description: Verify any PDF produced by Folio with independent tools. Use after changing anything that writes PDFs.
---
Wrappers are in `packages/testkit/src/oracles.ts`; matchers in `matchers.ts` (`toBeValidPdf`, `toHavePageCount`, `toRenderLike`, …).

| Check | Command | Read the result as |
|---|---|---|
| Structure | `qpdf --check out.pdf` | exit 0 = clean, 3 = warnings (treat as failure unless listed below), 2 = error |
| Validation | `pdfcpu validate out.pdf` | must print `validation ok` |
| Text | `pdftotext -layout out.pdf -` | compare with expected strings; also proves old glyphs are gone after a text edit |
| Render | `pdftoppm -r 72 -png out.pdf prefix` and `mutool draw -r 72 -o p%d.png out.pdf` | pixel-diff against the Folio render with tolerance |
| Annotations | `mutool show out.pdf trailer/Root/Pages/Kids/0/Annots` or `pdfcpu annotations list` | subtype, `/AP` present |
| Form fields | `pdfcpu form list out.pdf`, `mutool show` on `/AcroForm` | values and `/AP` |

Known harmless output: `pdfcpu` notes about missing optional `Info` entries; anti-aliasing differences under 2 % of pixels at 72 dpi between PDFium and poppler/mupdf.

Any other difference is a defect: report page, object and both renders.
