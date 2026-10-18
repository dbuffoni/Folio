# Branding checklist (release 0.1.3)

Source of truth: `assets/branding/` (symbol, tile, maskable, mono and tray SVGs, Freedesktop icons, with
the rules in its `README.md`). The task card names `branding/final`; no directory of that name exists in
the repository or on the build machine, so `assets/branding` is treated as the final set. If a different
set is supplied later, replace the SVGs there and run the export steps below once.

| Surface | Asset | State |
| --- | --- | --- |
| Desktop bundle, window icon | `apps/desktop/src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png`, `icon.icns`, `icon.ico` | exported from `folio-symbol.svg` / `app-icon-tile.svg` ✔ |
| AppImage | same icon set via `tauri.conf.json` `bundle.icon`; Freedesktop name `io.github.folio.Folio` | ✔ |
| Web favicon | `apps/web/static/favicon.svg`, `favicon.ico` | ✔ |
| Web manifest, PWA | `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `manifest.webmanifest` | ✔ |
| Apple touch icon | `apple-touch-icon.png` (from `app-icon-maskable.svg`) | ✔ |
| Title bar brand button | `Logo.svelte` → `folio-symbol{,-dark}.svg` copied to `static/brand/` at build time | placeholder "F" replaced in 0.1.3 ✔ |
| Splash screen | same component | placeholder "F" replaced in 0.1.3 ✔ |
| About dialog | same component | placeholder "F" replaced in 0.1.3 ✔ |
| Window title | "Folio" / "<document> — Folio" | ✔ |
| README header | `folio-logo-horizontal{,-dark}.svg` in a `<picture>` | ✔ |
| Repository social preview, Open Graph image | `docs/branding/social-preview.png` (1280×640), `og-image.png` (1200×630) | present ✔; GitHub's social preview must be uploaded by the owner in the repository settings (not scriptable) |
| Light and dark logo variants | `Logo.svelte` swaps with the theme (`data-theme` or system preference) | ✔ |
| System tray | `tray-mono.svg`, `tray/` | no tray in the app yet: nothing to apply; verify on Linux when a tray is added |

Export commands for a new set: render each SVG with `rsvg-convert` or `inkscape` to the PNG sizes above;
`icon.ico` and `icon.icns` via `pnpm --filter @folio/desktop exec tauri icon assets/branding/app-icon-tile.svg`.
