# Folio branding

Symbol: a stack of three pages with an "F" on the front one. Wordmark: "Folio" set in Inter SemiBold
(SIL OFL 1.1), converted to outlines, so no font is needed to render the logo.

| File | Use |
|---|---|
| `folio-symbol.svg` | Master symbol, 1024×1024, transparent. Source of every app icon. |
| `folio-symbol-dark.svg` | Symbol for dark backgrounds. |
| `folio-symbol-mono.svg` | One-colour symbol (black, gaps by mask). |
| `folio-logo-horizontal{,-dark,-mono}.svg` | Symbol + wordmark; minimum width 96 px, clear space = half the "F" height. |
| `app-icon-tile.svg` | Symbol on a rounded tile (macOS `icon.icns`). |
| `app-icon-maskable.svg` | Full-bleed variant with safe zone (apple-touch icon, PWA maskable icon). |
| `tray-mono.svg`, `tray/` | Simplified silhouette for system trays (not used by the app yet). |
| `linux/` | Freedesktop icon names `io.github.folio.Folio{,-symbolic}.svg`. |

Raster icons in `apps/desktop/src-tauri/icons/`, `apps/web/static/` and `docs/branding/` are exported
from these SVGs. Colours: accent `#2563eb` (light UI), `#6b9bff` (dark UI).

## Licence

The logo and icons in this directory are released under CC BY-SA 4.0. The name "Folio" and the logo
identify the official project; forks should use their own name and logo.
