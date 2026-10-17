# 0007 — Digital signatures in TypeScript, network only on request

- **Status:** accepted · **Date:** 2026-10-17 · **Resolves:** SPEC §6.12, §6.13 (Release 0.1.2), §17.1

## Decision

Certificate-based signing (PAdES), validation, timestamps and long-term validation data are implemented in
`packages/services/src/signing` in TypeScript, on WebCrypto, `pkijs` 3.4.1 and `asn1js` (BSD-3-Clause).
Desktop and web run the same code. The earlier plan of a Rust `SigningService` (OpenSSL, ring, PKCS#11) is not used.

| Topic | Choice | Why |
|---|---|---|
| Where it runs | TypeScript, shared by desktop and web | One implementation to test; no OpenSSL in the AppImage; the web build gets the feature. Rust stays limited to what a browser cannot do. |
| Writing the signature | Incremental update with a fixed-size hex `/Contents` placeholder; `/ByteRange` patched in place; larger CMS rebuilds with more room | Earlier bytes and signatures stay valid. Classic xref tables and xref streams are both handled. |
| Signature format | `adbe.pkcs7.detached`, SHA-256, signing-certificate-v2 (PAdES-B-B); RFC 3161 token as unsigned attribute (B-T); `/DSS` and `/VRI` (B-LT) | The common subset readers verify. Poppler `pdfsig` and `qpdf --check` are the oracles. |
| Keys | PKCS#12 import; RSA and ECDSA P-256/P-384 only | What WebCrypto can sign with. Other key types are refused with a reason. |
| Secrets | Database holds public data; the PKCS#12 and password go to the OS keychain; without a keychain they live in memory for the session | A private key never touches SQLite, logs or diagnostics. |
| Trust | No trust list ships; the user adds certificates | Folio cannot judge who the user should trust. "Trust this signer" shows the fingerprint first. |
| Network | OCSP/CRL, timestamp and validation data are opt-in settings; the TSA address is empty by default; transport is `Platform.network` | Each request tells a server something. NFR-14 (no traffic by default) holds. |
| Desktop transport | Rust `binary_request`: http(s), GET or POST, no credentials, no redirects, size limits, and a native dialog the first time a host is contacted | Page content cannot make Folio contact a server the user did not approve. |
| Web transport | `fetch` without credentials or referrer | Subject to CORS; many timestamp authorities do not allow browsers. The UI explains the feature needs a CORS-capable authority. |

## Consequences

- Smart cards and tokens (PKCS#11), qualified/eIDAS signatures, EU trusted lists, PAdES-LTA and certifying
  signatures stay in §17.1.
- Signing with a non-extractable hardware key would need a native port later; the `SigningIdentity` type is the seam.
- Validation checks integrity, chain and dates against the user's trusted certificates; it is not a legal verdict.

## Verification

Signed files are checked with `pdfsig` and `qpdf --check` for single and double signatures, RSA and ECDSA,
classic and xref-stream files, timestamps, OCSP/CRL and `/DSS`. The Rust request filter has a unit test.

## Bundle

pkijs, asn1js and the signing services add about 260 KB gzip. They are imported on demand (`@folio/services/signing`, loaded the first time a signature is read or made), so the initial JavaScript stays within the 600 KB budget of NFR-10; `tools/bundle-size.ts` reports the on-demand part apart.
