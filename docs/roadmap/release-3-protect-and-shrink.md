# Folio Release 3 — "Protect & Shrink" (v3.0)

| | |
|---|---|
| **Status** | Draft specification for review |
| **Date** | 2026-10-12 |
| **Builds on** | Release 2 (OCR, platforms, updater, i18n) |
| **Roadmap** | [ROADMAP.md](ROADMAP.md) |

## 1. Purpose and outcome

Everyone eventually has to **email a PDF that is too big** or **send one that must not leak**. Release 1 deliberately has none of that: no compression, no password, no redaction (SPEC §5.1 #19–21). Release 3 adds the three "outgoing document" features, plus the supporting hygiene tools, while keeping Folio's privacy promise: everything stays local.

**Success looks like:** Giulia drops a 38 MB scan-heavy invoice bundle on the Compress tile, picks "Balanced", sees "≈ 6.5 MB, text stays sharp", saves, and emails it. Paolo redacts a customer name and an IBAN, applies, and `pdftotext` on the result finds neither string anywhere.

### 1.1 In scope

| Track | Feature | IDs |
|---|---|---|
| A. Compress | Reduce file size with presets, preview of estimate, before/after | FR-OPT-01 (+ FR-OPT-07…11) |
| B. Passwords | Set and remove password, AES-256, owner password and permission flags | FR-SEC-01, FR-SEC-02 (+ FR-SEC-06…08) |
| C. Redaction | Secure redaction with true content removal and rasterise fallback, metadata scrub, hidden-data scan | FR-SEC-03 (+ FR-SEC-09…14) |
| D. Foundations | Verification of encryption/redaction/compression capabilities of the PDFium build, ADR, conformance tests | spike S4 |

### 1.2 Out of scope

Certificate-based encryption and digital signatures (SPEC §17.1/§17.4), DRM/rights management, **fully automatic** redaction that applies pattern matches without user review (manual areas, text-search-driven and *reviewed* pattern-driven redaction are in), full "sanitise document" wizard with every PDF feature class, PDF/A conversion (a compressor must not break PDF/A claims but does not create them), JBIG2/JPEG2000 encoding unless the spike proves it cheap.

## 2. Scenarios

| # | Scenario | Persona |
|---|---|---|
| S1 | Compress a 38 MB file: choose preset, see estimated size, apply, see result 6.4 MB; undo restores; text still searchable and sharp at 100 %. | Giulia |
| S2 | Compress 12 files at once (uses R4 batch queue when available; in R3 a simple multi-file dialog). | Marta |
| S3 | Protect a PDF with an open password and "no copy / no editing" permissions; open it again in Folio and in Okular, both prompt. | Marta |
| S4 | Remove the password from a file the user opened with the password. | Luca |
| S5 | Search "IBAN", select all results, "Redact all", review the boxes, Apply; verify with the "Check redaction" panel that no text remains. | Paolo |
| S6 | Draw two rectangles over a photo and a signature; Apply; the page areas are black and the data is gone from the file. | Paolo |
| S7 | Run "Remove hidden data" and see a list (metadata, attachments, comments, JavaScript, hidden layers) with per-item choice. | Paolo |

## 3. Functional requirements

### 3.1 Compression (SPEC FR-OPT-01 expanded)

| ID | Requirement | Pri |
|---|---|---|
| FR-OPT-01 | **Reduce file size** with presets **Light** (lossless clean-up only), **Balanced** (images > 200 DPI → 150 DPI, JPEG quality 75), **Strong** (→ 110 DPI, quality 60, grayscale detection), **Custom** (target DPI colour/gray/mono, JPEG quality, strip options). Shows estimate range before applying, then actual before/after. | P0 |
| FR-OPT-07 | **Lossless pass always on**: drop unreferenced objects, deduplicate identical streams and fonts, recompress Flate streams at max level, write object streams and compressed xref, remove unused resources, linearisation **off** by default (option "Fast web view"). | P0 |
| FR-OPT-08 | **Image analysis**: list images by size and effective DPI (sidebar "Images" with total saving potential); per-image skip and per-page limits ("keep page 3 as is"). Never upsample. Images with SMask/masks keep their alpha; monochrome scans stay 1-bit (CCITT G4 or Flate) and are downsampled only with antialiased resampling. | P1 |
| FR-OPT-09 | **Text sharpness guard**: text/vector content is never rasterised by compression; if the only way to hit the target would require rasterising text, the UI says "Target not reachable without rasterising; choose Strong or accept N MB". | P0 |
| FR-OPT-10 | **Fonts**: optional "subset all embedded fonts" (default on) and "remove unused embedded fonts"; never touches fonts on pages under a digital signature (see FR-OPT-11). | P1 |
| FR-OPT-11 | **Signed documents**: if the file has signatures, compress is blocked with the explanation that it would invalidate them; user may proceed on a copy (reuses FR-APP-11 messaging). | P0 |
| FR-OPT-12 | **Target size mode**: "Make it ≤ 10 MB" runs a bounded search over presets/DPI and stops at the first that fits or reports the minimum reached; cancelable with progress. | P1 |
| FR-OPT-13 | **Quality preview**: side-by-side before/after crop of a chosen page region at 100 %, per-image estimated savings. | P1 |

### 3.2 Passwords and permissions

| ID | Requirement | Pri |
|---|---|---|
| FR-SEC-01 | **Set password**: *open* (user) password; AES-256 (PDF 2.0, revision 6); strength meter and "show/hide"; confirmation field. Stored nowhere. Written on save through the engine. | P0 |
| FR-SEC-02 | **Remove password**: from a file that the user opened (password supplied) — produces an unencrypted copy/save. Explains that permissions are removed as well. | P0 |
| FR-SEC-06 | **Owner password and permission flags**: separate owner password; checkboxes for printing (none / low / high), copying text and images, modifying, annotating, filling forms, assembling, accessibility extraction (kept on by default). Labels state that restrictions are honoured by compliant software and are **not** security against determined users. | P1 |
| FR-SEC-07 | **Encryption status in the UI**: lock icon in tab, details in document properties (algorithm, key length, permissions). Opening an owner-restricted file in Folio: Folio **respects** restrictions (disables the relevant commands with an explanation) unless the user supplies the owner password. | P1 |
| FR-SEC-08 | **Change password** = remove + set in one step; "Save a protected copy" never touches the unprotected open document. Password never persisted, never logged, never put in recovery snapshots (recovery stores the *decrypted working copy* encrypted by the app's at-rest key or refuses to snapshot protected documents — see §5.4). | P0 |

### 3.3 Redaction and sanitising

| ID | Requirement | Pri |
|---|---|---|
| FR-SEC-03 | **Redaction**: mark areas (draw rectangles, select text, search results), review, **Apply**. Applying **removes** text, images, vector paths and annotations that intersect the marked areas from the page content (true removal), fills with an opaque colour, and records nothing about what was removed. Where true removal is not possible (e.g. content inside shading patterns, Type 3 fonts, annotations with unsupported appearance), the page is rasterised at the selected DPI (default 200) as fallback; the dialog tells which pages were rasterised. | P0 |
| FR-SEC-09 | **Mark first, apply later**: marks are `Redact` annotations (standard PDF subtype), editable, copyable, with overlay text and colour; persisted in the file until applied. Applying is a destructive, confirmed, undoable-within-session command (checkpoint) but irreversible in the saved file. | P0 |
| FR-SEC-10 | **Search and redact**: text search (case, whole word) → "Mark all results"; also **patterns** from a small built-in list (email, IBAN, phone, tax-ID shapes) selected by the user, each result reviewed. Fully automatic apply without review is not offered. | P1 |
| FR-SEC-11 | **Verification panel** after apply: re-extracts text of redacted pages, searches for the marked strings, lists images under areas, and reports "No remaining data found in N pages" or specific leftovers; one-click re-apply with rasterise fallback. | P0 |
| FR-SEC-12 | **Metadata scrub** (toggle during apply and as standalone): Info dictionary, XMP, document-level and page-level `PieceInfo`, thumbnails, embedded file names, JavaScript, named destinations pointing into removed areas, **OCR text layer inside redacted areas** (R2), form field values inside redacted areas. | P0 |
| FR-SEC-13 | **Hidden-data scan**: read-only report of what the file carries (metadata, attachments, annotations/comments, hidden text, JavaScript, link targets, form data, OCGs hidden by default, previous revisions in incremental updates) with per-category "Remove". Always writes a **full rewrite** (no incremental data surviving). | P1 |
| FR-SEC-14 | **Incremental-save guard**: applying redaction or scrub forces full rewrite and disables "preserve original data" (otherwise the removed bytes survive in older revisions). Tested explicitly. | P0 |

## 4. UX specification

### 4.1 Compress
- Entry: Home tile "Compress", File → Reduce size, command palette. Single dialog: preset segmented control, file list (single in R3.0; multi-file list included but processed sequentially), estimate line "≈ 6–8 MB (-80 %)", expandable "Details" (images count, fonts, savings by category), **Compare** button (opens before/after tab for the chosen page region).
- Always writes a **new file** by default (`name_compressed.pdf`); "Replace current document" is a secondary action creating one undo checkpoint.
- Progress by page with cancel; never blocks UI (worker). Result card: before, after, saved %, "Open", "Reveal".

### 4.2 Protect
- Entry: File → Protect…; lock icon in tab. Two tabs in one dialog: **Open password** and **Permissions**. Warning copy: *"Permissions are a courtesy: some programs ignore them. For confidentiality use an open password."*
- Removing: if the open document is encrypted, banner "This file is password-protected. [Remove protection…]".

### 4.3 Redact
- Dedicated **Redact mode** (tool group, shortcut `Shift+X`; Appendix A addition) with a distinct red-tinted chrome so users know the operation is destructive. Marks show as semi-transparent red boxes with the overlay colour preview (black default).
- Panel "Redactions": list with page, text snippet (hidden when "streamer mode" toggle is on), delete, "Apply all". Apply dialog explains in two sentences what will happen and requires typing nothing (a single clear button **Apply redactions permanently**).
- Cover & type/whiteout from R1 keep their label "cover only"; a hint links to Redact.

### 4.4 Accessibility and i18n
All dialogs keyboard-complete; strength meter has text, not only colour; every string through i18n including Italian (R2 framework).

## 5. Technical design

### 5.1 Capability verification (spike S4, first)

The PDFium build (`@embedpdf/pdfium` 2.15.1) already exports `EPDF_SetEncryption(doc, userPw, ownerPw, permissions)`, `EPDF_RemoveEncryption`, `EPDF_UnlockOwnerPermissions`, `EPDF_IsOwnerUnlocked`, `EPDFPage_ApplyRedactions`, `EPDFAnnot_ApplyRedaction`, `EPDFText_RedactInRect/Quads` and image helpers (`EPDFImageObj_SetJpeg/SetPng`). Spike S4 answers, with fixtures and independent oracles:

| Question | Pass criterion | Fallback |
|---|---|---|
| Does `EPDF_SetEncryption` write AES-256 R6 that `qpdf --show-encryption`, `pdfcpu`, mutool, Acrobat, Preview, Chrome open with the password and reject without? Are permission flags reflected? | All oracles agree; wrong password fails | **qpdf compiled to WASM** (Apache-2.0) behind `PdfEngine.encrypt` as SPEC §8.7 planned; `pdfstudio`-style third-party WASM packages are *not* adopted without audit |
| Does `ApplyRedactions` remove text objects, image data under the rectangle (cropping/ masking the image or replacing), vector paths, and annotations, and does the text no longer appear in `pdftotext`, `mutool`, or raw stream grep (including with the decryption of object streams)? | No leftover string in any oracle on a 30-document redaction corpus | Rasterise the page (`rasterizePage`) and replace content with the image (SPEC FR-SEC-03 original design) |
| Can unreferenced objects be dropped and object streams written by `FPDF_SaveAsCopy` flags, and does saving after redaction really drop old objects (no incremental)? | File size and `qpdf --show-object` confirm no orphan stream containing redacted text | Post-process with qpdf `--object-streams=generate --recompress-flate` and an own "garbage collect" pass |
| Image recompression: decode → resample → JPEG encode with which encoder? | ≥ 30 % smaller than Canvas JPEG at same SSIM | `@jsquash/jpeg` (MozJPEG WASM, Apache-2.0 wrapper; MozJPEG's own licence must be checked) or Canvas `convertToBlob` |

Spike deliverable: ADR 0011 "Encryption, redaction and recompression stack", conformance tests committed (`encrypt`, `redact`, `recompress`), licence report entries.

### 5.2 Ports

```ts
// engine.ts additions (all additive)
export interface EncryptOptions { userPassword: string; ownerPassword?: string; permissions?: PermissionFlags; algorithm?: 'AES-256'; }
export interface PermissionFlags { print: 'none'|'low'|'high'; copy: boolean; modify: boolean; annotate: boolean; fillForms: boolean; assemble: boolean; accessibility: boolean; }

interface PdfDocument {
  // security
  getEncryptionInfo(): Promise<{ encrypted: boolean; algorithm?: string; keyBits?: number; permissions?: PermissionFlags; ownerUnlocked: boolean }>;
  setEncryption(o: EncryptOptions): Promise<void>;       // applies on next save()
  removeEncryption(): Promise<void>;
  // redaction
  markRedaction(i: PageIndex, quads: Quad[], style: RedactStyle): Promise<AnnotId>;
  applyRedactions(pages?: PageIndex[], opts?: { rasterFallbackDpi?: number; scrubMetadata?: boolean }): Promise<RedactionReport>;
  scanHiddenData(): Promise<HiddenDataReport>;
  scrub(items: HiddenDataKind[]): Promise<void>;
  // optimisation
  analyzeImages(): Promise<ImageInfo[]>;
  optimize(plan: OptimizePlan, signal: AbortSignal, onProgress?: (p: number) => void): Promise<OptimizeReport>;
}
// platform.ts
export interface ImageRecompressor { // implemented in a worker; engine calls it through the service, not directly
  recompress(img: RasterImage, o: { maxDpi: number; sourceDpi: number; quality: number; grayscale?: boolean }): Promise<{ bytes: Uint8Array; filter: 'DCT'|'Flate'|'CCITT' }>;
}
```

`OptimizePlan` is a pure data object built by `CompressService` from the preset (testable without engine). `RedactionReport` lists per page: removed text objects, images modified, paths removed, rasterised yes/no, bytes removed.

### 5.3 Compression pipeline (`CompressService`)

1. `analyzeImages` → effective DPI per placement (image pixel size ÷ placed size in inches, max over placements), colour space, filters, mask presence.
2. Plan: per image decide `keep | downsample(dpi) | reencode(quality) | convert-gray`; images used several times are processed once (xobject id).
3. Execute in a worker pool; the engine replaces image streams via `replaceImage` (already in port, ADR 0006) preserving transforms.
4. Lossless pass and save with object streams (`save({objectStreams:true, compress:'max'})`, options already exist in the port) then verify (re-open, page count, render of first and largest page vs. reference SSIM ≥ 0.98 for Balanced).
5. Report. All steps cancel via `AbortSignal`; checkpoint before apply for undo.

Heuristics notes: JPEG→JPEG recompression at high quality can *grow* files; rule "only replace if result smaller by ≥ 5 %". CMYK JPEGs and ICC-based images keep their colour space unless "convert to sRGB" is enabled. Stamps/signatures from R1 are tiny PNGs; they are skipped below a 30 KB threshold.

### 5.4 Encryption lifecycle

- Opening already supports passwords (FR-APP-12). R3 keeps the *password in memory* only as long as the session (needed to re-save with the same encryption when the user chose "keep protection"). Policy: the **default** when saving an opened-encrypted file is "keep protection" with the same settings (re-encrypt with the session password); explicit "Remove protection" otherwise.
- **Recovery snapshots** (FR-APP-06): snapshots of encrypted documents are encrypted at rest with the existing `CryptoService` using a key from `SecretStore`; if no secure store exists (memory-only), snapshots for protected documents are disabled and the UI says so. Tested.
- `Platform.secrets` is **not** used to store document passwords.

### 5.5 Redaction design

- Marks are `Redact` annotations (PDF 1.7 subtype). Engine port exposes them in the `Annotation` union (new type `'redact'`; needs adapter appearance generation: red outline + overlay text).
- Apply algorithm per page (engine-side): intersect quads with page objects → text objects: split runs, remove glyphs whose boxes intersect (re-emit remaining glyphs with their positioning; needs the text-layer char boxes already used by text edit) → image objects: if fully covered, remove; if partial, rasterise-in-place (mask the image pixels and re-embed the image) → path objects: remove if bounding box intersects (conservative) → annotations/widgets intersecting: remove or flatten without the area → paint filled rect last.
- Anything the engine cannot prove removed ⇒ page falls back to rasterisation. The report is truthful.
- **Verification panel** is implemented by a service independent of the engine's apply (re-open saved bytes, extract text with the engine's text layer, plus raw scan of decoded streams for the marked strings) so a bug in apply cannot also hide itself in verification.
- Never executed on documents with active digital signatures without the FR-APP-11 flow.

### 5.6 Data model

Migration `0003_security.sql`: `settings` keys only (`compress.lastPreset`, `redact.defaultColor`, `redact.rasterDpi`, `protect.lastPermissions`). **No table stores passwords or redacted content.** `history_spill` already exists for checkpoints; add a flag `contains_secret` so spill files of protected docs are encrypted (see 5.4).

### 5.7 Security considerations

- Password handling: never logged (Logger redaction of any field named `password`), cleared from memory on session close, not exposed through CLI arguments in logs (CLI reads from a prompt or `--password-file`).
- Zip-bomb-like inflation: compression analysis streams images with size limits to avoid blowing the WASM heap (see NFR-06).
- Redaction must be tested adversarially: fixtures with text split across operators, text in Form XObjects reused on many pages, text in annotations' appearance streams, in Type 3 fonts, hidden in OCG layers, in embedded files, in XMP, in outlines/bookmark titles, in form field default values, and in incremental revisions.

## 6. Non-functional requirements (additions)

| ID | Requirement |
|---|---|
| NFR-R3-01 | Compress 100 pages / 50 MB scan in ≤ 60 s on reference laptop with a 3-worker pool; UI stays at ≥ 55 fps. |
| NFR-R3-02 | Output of Balanced preset on the compression corpus: median ≥ 40 % smaller for scan-heavy files; text-only files never grow by more than 0.5 %. |
| NFR-R3-03 | Redaction apply ≤ 3 s per page (true removal), ≤ 8 s per page with rasterise at 200 DPI. |
| NFR-R3-04 | Zero leftover strings in the redaction corpus (hard gate, 0 tolerance). |
| NFR-R3-05 | Encrypted output validated by two independent oracles (qpdf, pdfcpu/mutool) on every fixture. |

## 7. Testing strategy

| Level | What |
|---|---|
| Unit | Preset → plan, DPI calculation, target-size search, permission flag bit mapping (PDF 32000-1 Table 22 and 32000-2), password policy, redaction geometry, pattern matchers with fixtures (valid/invalid IBAN checksum, etc.) |
| Conformance | `encrypt/remove/unlock` round-trips; redaction corpus; `optimize` idempotence (second run saves < 1 %); open→save unchanged for non-selected pages |
| Oracle/interop | `qpdf --check`, `--show-encryption`; `pdfcpu validate`/`encrypt` compare; `mutool info`; `pdftotext` on redacted output must not contain secrets; `strings`/raw-stream grep after full inflate via `qpdf --qdf`; `pdftoppm` SSIM for compression quality |
| Property | Compression never changes page count, page boxes, annotations, form fields or outline; redaction never changes pages without marks |
| e2e | Compress dialog flow incl. cancel; protect→close→reopen prompts; redact search→apply→verify; keyboard-only |
| Manual | Open protected output in Acrobat Reader, Preview, Okular, Chrome, Firefox, Edge; screen reader on Redact panel |

New fixtures (testkit builders): `scanHeavy`, `mixedColorMono`, `cmykImages`, `maskedImages`, `type3Text`, `splitTextOperators`, `reusedFormXObject`, `incrementalWithSecret`, `encryptedAes128/256`, `ownerOnly`, `signed`.

## 8. Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| R3-1 | Built-in redaction leaves data in some constructs | Adversarial corpus is a hard gate; rasterise fallback; verification panel; label in UI of what is guaranteed |
| R3-2 | Quality complaints about recompression | Previews, Light preset default lossless, per-image skip, SSIM gates |
| R3-3 | PDFium encryption is an extension of a fork; upstream drift | Pin version, record in ADR; qpdf fallback isolated behind port |
| R3-4 | Users believe permissions are security | Plain-language copy, defaults favour open password |
| R3-5 | Memory use when recompressing big images in WASM | Stream per image, free after each, cap 12 MP per decode with tiling resample |
| R3-6 | Licence of encoders | Check MozJPEG/oxipng/libwebp licences in `pnpm licenses`; avoid GPL-incompatible or patent-encumbered codecs |

**Open questions**
1. Should "Replace current document" be allowed for compress (destructive), or always write a copy? (Proposed: copy by default.)
2. ~~Pattern-based redaction at R3?~~ **Decided 2026-10-12: yes.** FR-SEC-10 stays in R3 as P1 (built-in patterns, every result reviewed). SPEC §17.4 must be amended on adoption: it lists "pattern/regex based automatic redaction" as not planned. User-defined regex patterns remain a stretch item behind "Advanced".
3. Ship JBIG2/CCITT re-encoding of monochrome scans (large savings for document scans) or only Flate for 1-bit? Decide after spike.
4. Linearisation ("Fast web view") needed at all?

## 9. Delivery plan

| Phase | Goal | Exit gate |
|---|---|---|
| R3-P0 | Spike S4 and ADR 0011; fixtures; oracle wrappers extended (`qpdf --show-encryption`) | Go/no-go per track |
| R3-P1 | Ports, fakes, `OptimizePlan`, permission model, redaction model | Unit tests green |
| R3-P2 | Engine adapters: encrypt, redact, optimise (+ qpdf fallback if needed) | Conformance + interop + redaction corpus 0 leftovers |
| R3-P3 | Services: `CompressService`, `ProtectService`, `RedactService`, `SanitizeService`, recovery policy | FR-OPT-01/07…13, FR-SEC-01…14 headless tests green |
| R3-P4 | App layer view-models, CLI commands (`folio-cli compress|protect|redact`) | Epics E11–E13 headless green |
| R3-P5 | UI (Compress dialog, Protect dialog, Redact mode) + Italian strings | e2e + axe |
| R3-P6 | Hardening, docs, privacy page update, release | `tools/gate.sh R3` |

## 10. Horizon

Permission-aware batch protect (R4 batch), regex redaction with preview, redaction templates ("CV anonymiser"), certificate encryption (needs `SigningService`/X.509 port — SPEC §17.1), PDF/A-aware compression, "compare before/after" document diff.

## 11. Research notes and sources

- qpdf supports AES-256 only in R6/V5 as the non-deprecated mode; user and owner password are encrypted separately; empty owner password effectively disables restrictions and needs `--allow-insecure`; permission flags map to bits (print bit 3/12, modify 4, extract 5, annotate 6, form 9, assemble 11). <https://qpdf.readthedocs.io/en/stable/encryption.html>
- Restrictions are enforced by reader software, not cryptographically (same page); the UI copy in FR-SEC-06 follows from this.
- Common redaction failures: black boxes or highlights leave the text in the file; real redaction removes data from the document structure, and metadata, OCR layers, embedded files and annotations need their own cleanup step (e.g. Acrobat X workflow: apply → remove metadata and OCR text → save as new file). <https://www.lawnext.com/2019/10/the-1-reason-people-get-redaction-wrong.html>, <https://www.alnd.uscourts.gov/sites/alnd/files/Using_Redaction_in_Adobe_Acrobat_X_White_Paper.pdf>
- jSquash provides WASM codecs for MozJPEG, oxipng, libwebp, libavif, libjxl in web/worker environments (wrapper licence Apache-2.0; underlying licences to be checked). <https://github.com/jamsinclair/jSquash>
- PDFium build used by Folio (EmbedPDF) exposes the encryption and redaction extension functions listed in §5.1 (verified by inspecting the installed package typings in this repository; behaviour is **not yet verified**).
