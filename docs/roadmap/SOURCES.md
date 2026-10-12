# Roadmap research log

Research done on 2026-10-12 for `docs/roadmap/`. "Confirmed" means read from the source in this pass; "Open" means a claim in the roadmap that a spike must verify before work starts.

## Confirmed

| Topic | Source | What was taken from it |
|---|---|---|
| Pinned PDFium build exports encryption, redaction, form-field creation, bookmark, crop-box, N-up, page-label and ink functions | `node_modules/@embedpdf/pdfium` 2.15.1 typings (MIT) in this repository | Names of exported functions only. Behaviour is not verified. |
| `setOutline` already uses `EPDFBookmark_*` | `packages/engine-pdfium/src/document.ts` | Outline editor needs no new engine capability |
| PDFium page import / N-up / XObject API, experimental status | <https://pdfium.googlesource.com/pdfium/+/HEAD/public/fpdf_ppo.h> | R4 layout design |
| qpdf encryption: AES-256 R6, separate user/owner keys, permission bit mapping, restrictions are advisory | <https://qpdf.readthedocs.io/en/stable/encryption.html> | R3 permission model and UI copy |
| Tauri updater: signed artefacts, static JSON, per-OS artefacts, `createUpdaterArtifacts`, Windows `installMode` | <https://v2.tauri.app/plugin/updater/> | R2 update system |
| Tauri uses WebView2 (Windows), WKWebView (macOS), webkit2gtk (Linux) | <https://v2.tauri.app/reference/webview-versions/> | R2 platform risks |
| Tesseract.js: Apache-2.0, WASM, worker/scheduler API, language data fetched and cached, `tessdata_fast`/`best` | <https://github.com/naptha/tesseract.js> | R2 OCR adapter |
| jSquash codecs (MozJPEG, oxipng, libwebp, avif, jxl) for web/worker, wrapper Apache-2.0 | <https://github.com/jamsinclair/jSquash> | R3 recompression candidate |
| Redaction failure modes: cosmetic boxes keep data; metadata/OCR/attachments need separate cleanup | <https://www.lawnext.com/2019/10/the-1-reason-people-get-redaction-wrong.html>, <https://www.alnd.uscourts.gov/sites/alnd/files/Using_Redaction_in_Adobe_Acrobat_X_White_Paper.pdf> | R3 redaction scope and verification panel |
| `pdfium-render` Rust crate: runtime binding, WASM support, 0.9.x series, active in 2026 | <https://docs.rs/pdfium-render>, <https://github.com/ajrcarey/pdfium-render> | R6 native engine candidate |

## Open (to be verified by the named spike)

| Claim to verify | Spike | Release |
|---|---|---|
| Current tesseract.js version, per-language `tessdata_fast` file sizes, SIMD availability on WebKitGTK/WKWebView | S6 | R2 |
| Invisible-text layer with a glyphless font extracts correctly in `pdftotext`, `mutool`, Acrobat, Preview, Okular, Chrome, Firefox | S6 | R2 |
| Minimum macOS version supported by the pinned Tauri release; Windows code-signing option for an open-source project (e.g. SignPath Foundation, Azure Trusted Signing) | S7 / S8 | R2 |
| `EPDF_SetEncryption` writes AES-256 R6 readable by all oracles and viewers | S4 | R3 |
| `EPDFPage_ApplyRedactions` removes all data under marks (text, images, paths, annotations) with zero leftovers | S4 | R3 |
| MozJPEG / oxipng licences compatible with GPL-3.0-or-later; encoder gain over Canvas JPEG | S4 | R3 |
| Scaling/N-up through form XObjects keeps annotations and links correct | S9 | R4 |
| Inserting page objects *under* existing content; marked-content tags survive save | S11 | R5 |
| Ink appearance streams with variable width render in other viewers | S12 | R5 |
| `EPDFPage_CreateFormField` produces fields that fill correctly in all viewers | S14 | R6 |
| Native PDFium crate exposes (or can be built with) the EPDF extension functions; licence terms | S15 | R6 |
| Spell checking availability in WebKitGTK/WKWebView/WebView2 form fields | S16 | R6 |

## Not researched

- Market sizing or user interviews: priorities come from SPEC §3 personas and the spec's own commitments, not from new user research.
- Effort numbers are planning estimates by the author, not measured velocity.
