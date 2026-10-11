#!/usr/bin/env bash
# Phase exit gates (SPEC §16.6). Usage: tools/gate.sh <P0..P9|services-complete> [--skip-appimage]
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
phase="${1:-}"; skip_appimage="${2:-}"
[ -z "$phase" ] && { echo "usage: tools/gate.sh <phase> [--skip-appimage]"; exit 2; }
fail=0
step() { # name, command…
  local name="$1"; shift
  if out=$("$@" 2>&1); then echo "PASS  $name"; else echo "FAIL  $name"; echo "$out" | tail -25 | sed 's/^/      /'; fail=1; fi
}
step "lint (eslint, dependency rules, migrations in sync)" pnpm -s lint
step "type-check (packages, tools, tests)" npx tsc -p tsconfig.json
step "unit + conformance tests with coverage gates (lines ≥ 90 %, branches ≥ 80 %)" npx vitest run --project unit --project conformance --coverage
case "$phase" in
  P0|P1|P2) step "traceability tool runs" npx tsx tools/trace.ts --no-write --phase P2 ;;
  P3|P4|P5|P6) step "traceability for $phase" npx tsx tools/trace.ts --no-write --phase "$phase" ;;
  *) step "traceability: every Release 1 requirement has a test" npx tsx tools/trace.ts ;;
esac
case "$phase" in
  P0|P7|P8|P9|services-complete)
    step "Rust: clippy -D warnings" bash -c 'cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings'
    step "Rust: unit tests" bash -c 'cd apps/desktop/src-tauri && cargo test'
    step "web adapters and worker type-check (svelte-check)" pnpm -s --filter @folio/web check ;;
esac
if [ "$skip_appimage" != "--skip-appimage" ]; then
  if ls apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage >/dev/null 2>&1 && [ "${FOLIO_REBUILD_APPIMAGE:-0}" != "1" ]; then
    echo "INFO  using the existing AppImage (set FOLIO_REBUILD_APPIMAGE=1 to rebuild)"
  else
    step "AppImage builds" pnpm -s appimage
  fi
  step "AppImage smoke test under Xvfb" bash apps/desktop/scripts/smoke.sh
fi
if [ "$fail" -eq 0 ]; then
  echo "GATE $phase: PASS"
  if [ "$phase" = "services-complete" ]; then
    mkdir -p .claude/state && date -u +"%Y-%m-%dT%H:%M:%SZ services-complete gate passed" > .claude/state/ui-unlocked
    echo "UI unlocked: .claude/state/ui-unlocked created"
  fi
else
  echo "GATE $phase: FAIL"
fi
exit "$fail"
