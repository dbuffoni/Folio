#!/usr/bin/env bash
# Runs the AppImage smoke test under Xvfb with its own D-Bus session.
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
for tool in xvfb-run dbus-run-session tauri-driver WebKitWebDriver qpdf; do
  command -v "$tool" >/dev/null || { echo "missing: $tool (see docs/BUILDING.md)"; exit 2; }
done
exec xvfb-run -a dbus-run-session -- node apps/desktop/scripts/smoke.mjs
