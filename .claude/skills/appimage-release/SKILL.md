---
name: appimage-release
description: Build, smoke-test and release the Folio AppImage. Use for packaging, release work and AppImage bugs.
---
- Build: `pnpm appimage` (= `tauri build --bundles appimage` in `apps/desktop`). Release builds run on Ubuntu 22.04 for the glibc 2.31+/2.35 baseline; local builds on newer distros are for smoke tests only.
- Smoke: `pnpm appimage:smoke` runs the AppImage under Xvfb with a fixture PDF argument, drives it over WebDriver (`tauri-driver` + `WebKitWebDriver`), checks window title, page count over IPC, save-as-copy validity (`qpdf --check`) and exit code 0.
- No FUSE in containers: run with `--appimage-extract-and-run` (the smoke script does this automatically).
- WebKitGTK quirks: blank window or compositing glitches on some GPU/Wayland setups → `WEBKIT_DISABLE_DMABUF_RENDERER=1` (or `WEBKIT_DISABLE_COMPOSITING_MODE=1`). The "Safe graphics mode" desktop action sets the first one.
- Quality: `desktop-file-validate`, `appstreamcli validate`, executable bit, MIME `application/pdf`.
- Release: tag `vX.Y.Z` → `.github/workflows/release.yml` → AppImage, `.zsync`, SHA-256 sums, CycloneDX SBOM, detached signature; release notes list the requirement IDs.
