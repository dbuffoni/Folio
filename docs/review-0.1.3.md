# Code review of releases 0.1.1 and 0.1.2

Notion card: *Code review of releases 0.1.1 and 0.1.2* (release 0.1.3).

## Scope

Everything merged between tag `v0.1.0` and `origin/main` (`git diff v0.1.0..origin/main`, 229 files, about 17,000 added lines). The review covered these packages: `packages/services` (signing included), `packages/engine-pdfium`, `packages/ai`, `packages/app`, `packages/ocr-tesseract`, `packages/core`, `packages/db` migrations, `apps/web` platform adapters, `apps/desktop/src-tauri` and `apps/cli`. Work in progress on `release/0.1.3` (FR-SEC-07, FR-SEC-12, branding) is out of scope. It appears below only where the review touched it.

## Method

- Every package was read by hand, looking for correctness, error handling and the architecture rules in CLAUDE.md.
- Two agents reviewed in parallel:
  - `security-reviewer`: signing, AI, Tauri configuration and commands.
  - `spec-guardian`: 0.1.1/0.1.2 against SPEC scope, requirement coverage and i18n.
- Every finding was checked against the code before it went in this note.
- Each fixed finding has a test tagged with its requirement ID. The test failed before the fix and passes after it.
- These checks were run after the fixes:
  - `pnpm test`: 540 tests pass.
  - `pnpm test:conformance`: 173 tests pass.
  - `pnpm check`: the `tsc` step is clean.
  - `pnpm lint`: clean for the files changed here. The failures that remain are in files the lead is editing (`apps/web/tests/gaps.spec.ts`, and svelte-check in `apps/web`).

## Findings

| Id | Severity | Where | Description | Status |
|---|---|---|---|---|
| R1 | serious | packages/services/src/compress.ts:131 (`images`) | Images were grouped as "the same stored image" by width × height, stored length and filters. Two different uncompressed images of the same size always match on all three. Reduce file size then wrote the first picture over the second (data loss in the copy). | fixed: a group is now formed only when the pixels are equal. Test `two different images with the same size…` @FR-OPT-01 |
| R2 | serious | packages/services/src/signing/validate.ts:235 | The time in an embedded timestamp token was used to judge certificate expiry, even when the token did not verify or came from an authority the user does not trust. Anyone can make such a token, so an expired certificate could show as Valid. | fixed: only a verified token from a trusted authority moves the validation time. New test @FR-SIG-07 @FR-SIG-05; the existing test now trusts the TSA root |
| R3 | serious | packages/app/src/features.ts (`CompressModel.run`) | Compressing an encrypted file failed with "password required". The service reopens the saved copy with a password, but the model never passed one, and the session does not keep it (FR-APP-12). FR-OPT-11 says encrypted files keep their protection in the copy. | fixed: the model asks for the password once more; cancelling writes nothing. Test @FR-OPT-11 @FR-APP-12 |
| R4 | serious | packages/services/src/tables.ts:87 (`extractAi`) | On a rotated page, the area sent to the vision model was cut from the rotated render as if the page were not rotated. The model received the wrong part of the page, or a squashed strip. | fixed: the area is mapped with `pageToViewMatrix`. Test @FR-OPT-12 |
| R5 | minor | packages/services/src/form-author.ts:104 (`rename`) | Renaming a field inside a group (`addr.city` → `zip`) checked whether `zip` was free instead of `addr.zip`. That allowed duplicate full names and refused names that were actually free. | fixed. Test @FR-FRM-11 |
| R6 | serious | packages/app/src/signing.ts:378, packages/services/src/signing/sign.ts:316 | FR-SIG-06: with revocation checking on, signing with a revoked certificate must be refused. The check runs only when "Embed validation data" (FR-SIG-08) is also on, and the `revocationCheck` setting is never read on the signing path. | fixed (revocationCheck option) |
| R7 | minor | packages/engine-pdfium/src/fieldedit.ts:22 (`load`) | Any pdf-lib parse failure is reported as `formEditEncrypted`, so the user is told the file is encrypted. `rewriteForms` already refuses encrypted files before this point, so the message is always wrong here. | fixed (own error message) |
| R8 | minor | packages/services/src/signing/{sign,incremental,dss,validate}.ts | The signing services parse and write PDFs with pdf-lib directly, outside the `PdfEngine` port. ADR 0004 confines pdf-lib to engine-pdfium, and ADR 0007 does not record the exception. | card (amend ADR 0007) |
| R9 | minor | SPEC.md:1328, :267, :317, §11.1/§11.2 | The SPEC record is stale: 0.1.1 is still "Candidate"; §6.6 says certificate signatures are out of scope; FR-EDT-08 says OCR arrives in Release 2. The new Rust commands `binary_request` and `download_file` are not listed. | fixed (SPEC brought up to date) |
| R10 | minor | packages/ai/src/debug-log.ts, `AiDebugModel` | The hidden AI debug window has no requirement. It can copy the full request, document text included, and its tests borrow @FR-AIF-04. | card |

| R11 | blocker | packages/services/src/signing/cms.ts:107-114 | When the signer identifier is a key identifier, `verifyDetached` reports `certificates[0]` as the signer. pkijs verifies with the certificate the identifier actually names. Someone can sign with their own key, embed a copy of Alice's public certificate first, and get "valid, trusted, signed by Alice". "Trust this signer" would then trust Alice's certificate. | fixed (signer matched by identifier) |
| R12 | serious | packages/services/src/signing/timestamp.ts:155-176 | Same pattern for timestamp tokens: the authority is taken as `certs[0]`, and it counts as trusted when only its subject and serial match a trusted certificate. A forged token can still move the validation time (this weakens the R2 fix). | fixed (verified authority, timeStamping EKU) |
| R13 | serious | packages/services/src/signing/validate.ts:197-210 | Nothing checks that the ByteRange gap holds exactly that signature's `<hex /Contents>`. Unsigned bytes can be hidden in the padding of the placeholder ("signature wrapping"), and integrity still reports ok. | fixed (gap must equal /Contents) |
| R14 | serious | packages/services/src/signing/validate.ts:121-148 | The chain builder ignores basicConstraints `cA`, `keyCertSign` and `pathLenConstraint`. An end-entity certificate the user trusted can issue a "trusted" certificate for any name. | fixed (cA, keyCertSign, pathLen) |
| R15 | serious | packages/core/src/util.ts:101, apps/desktop/src-tauri/src/secrets.rs:83 | `folio.cert.<64 hex>` is 75 characters, but Rust `check_key` allows at most 64. Identities never reach the OS keychain (they are kept for the session only), and removing an identity shows an "invalid secret name" error. `wipe_app_data` does not remove `folio.cert.*` entries. | fixed (Rust key limit 80, wipe removes identity keys) |
| R16 | serious | apps/desktop/src-tauri/src/http.rs:244-277, 164, 201 | Network approval is per host, not per scheme, host and port. OCSP/CRL addresses come from the document and can point at loopback or private addresses, and the dialog gives no warning. The size cap is checked only after the whole body has been buffered. | card |
| R17 | minor | packages/services/src/signing/revocation.ts:95-119 | No freshness check on OCSP `thisUpdate`/`nextUpdate` or CRL `nextUpdate`, so an old "good" answer can be replayed. | card |
| R18 | minor | packages/services/src/signing/validate.ts:261 | With revocation checking on, an `unknown` result still shows plain "Valid" with no message. | fixed (downgraded status and note) |
| R19 | minor | packages/ai/src/openai.ts:100 | After switching to a local-server preset, the stored OpenAI key is still sent as Bearer to localhost. The native dialog discloses this. | card |

## Not a problem but worth knowing

- FR-SEC-07 and FR-SEC-12 were added to SPEC.md on this branch (§17.4 still excludes a hidden-data *report*; removal is FR-SEC-12).
- `OcrLanguageRepo.isInstalled` hashes each downloaded pack (several MB) on every `list()` call. This is correct, but costs time when the languages pane opens.
- `CompressService.images` now decodes images only when two of them share size, stored length and filters. A logo repeated on every page is decoded once per page, but only at analysis time.
- Signing and compress "Replace this file" write the file and reopen the tab instead of running a `Command`. The open document is not edited, so this does not break the command-bus rule.
- `packages/services/src/smartfill.ts` has two JSDoc blocks stacked above `signFields`. The first belongs to `apply`. This is cosmetic.
- The CLI `tables` command does not validate `--area`/`--page` numbers. A bad value ends in an engine error, not a usage message.
- No TODO, FIXME or `console.log` was added in the reviewed code. No Tauri, DOM or Node import was found in `packages/core|services|app`, and no PDFium type was found outside `engine-pdfium`.
