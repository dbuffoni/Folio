# 0008 — Update notice: tell, never install

- **Status:** accepted · **Date:** 2026-11-06 · **Resolves:** SPEC FR-APP-16 (Release 0.1.5), §17.0 "auto-update"

## Context

Folio promises no telemetry, no accounts and no network calls by default. Users of the AppImage still want to
learn that a fixed or improved version exists. The Tauri updater (`tauri-plugin-updater`) would download and
replace the application: it needs a signing key, an update server contract, and it changes the binary without the
user's say. It stays Post-R1.

## Options considered

1. **Updater plugin.** Complete, but a new dependency, a key to guard, and an install path the user did not choose.
2. **Generic HTTP from the page** to GitHub. Needs the page to reach an arbitrary origin, which the CSP and the
   AI allow-list (`AllowedOrigin`) exist to prevent.
3. **A dedicated Rust command** that performs one fixed GET and returns the text. Smallest surface.

## Decision

Option 3, notify only.

- Setting `updates.check`, **off by default**. With it off Folio makes no request at all (a test proves the feed
  is not called). Records `lastCheckAt` and `skippedVersion` beside it.
- The command `latest_release` (Rust, `http.rs`) takes **no argument**. It requests
  `https://api.github.com/repos/dbuffoni/Folio/releases/latest`: https only, 15 s timeout, no redirects, no cookies,
  1 MB cap, User-Agent `Folio/<version>`. The URL is a constant in the binary; it is not an origin the AI proxy or
  the OCR downloader will accept, and a unit test pins it.
- The TypeScript side (`checkUpdates` in `@folio/app`, `newerRelease` in `@folio/core`) compares semantic
  versions, ignores drafts and pre-releases (also if the tag has a pre-release suffix), and only ever links to
  `https://github.com/dbuffoni/Folio/releases/…`. The link is opened in the system browser; Folio downloads nothing.
- At most one **automatic** check a day, made after start-up so it never delays it. Automatic failures are silent;
  *Settings ▸ Privacy ▸ Check now* is manual, ignores the daily limit and the skipped version, and reports a failure.
- A dismissible banner offers *View release*, *Skip this version* (remembered) and close (this run only).
- Desktop only: the web build has no feed (`Platform.updates` is absent) and shows none of this.

## Consequences

- The Privacy pane and the first-run tutorial explain the one optional request.
- Auto-update stays Post-R1 (SPEC §17.0); nothing here prepares an install path.
- If the repository moves, the constant and `RELEASES_REPO` change together (tests fail if only one does).

## Evidence

`packages/core/src/updates.test.ts`, `packages/app/src/updates.test.ts`, `http.rs` unit test
`the_update_route_is_one_fixed_https_address`.
