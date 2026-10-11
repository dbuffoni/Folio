#!/usr/bin/env bash
# Stop: run unit tests related to files changed since HEAD. Opt-in (FOLIO_STOP_TESTS=1) because it is slow.
[ "${FOLIO_STOP_TESTS:-0}" = "1" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$root" || exit 0
changed=$(git diff --name-only HEAD -- 'packages/**/*.ts' 'apps/cli/**/*.ts' 2>/dev/null | tr '\n' ' ')
[ -z "$changed" ] && exit 0
# shellcheck disable=SC2086
if ! out=$(node_modules/.bin/vitest related --run --project unit $changed 2>&1); then
  echo "$out" | tail -40 >&2
  exit 2
fi
exit 0
