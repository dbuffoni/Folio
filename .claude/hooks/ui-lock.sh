#!/usr/bin/env bash
# PreToolUse(Edit|Write): block UI work until the services-complete gate has passed (SPEC §16.5.4).
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
[ -f "$root/.claude/state/ui-unlocked" ] && exit 0
path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
case "$path" in
  */apps/web/src/lib/ui/*|*/apps/web/src/routes/*|apps/web/src/lib/ui/*|apps/web/src/routes/*)
    echo "UI is locked until the services-complete gate passes (.claude/state/ui-unlocked missing). See SPEC §16.6." >&2
    exit 2 ;;
esac
exit 0
