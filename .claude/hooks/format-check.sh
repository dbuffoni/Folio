#!/usr/bin/env bash
# PostToolUse(Edit|Write): format the changed file. Never blocks.
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
case "$path" in
  *.ts|*.js|*.cjs|*.svelte|*.json|*.css)
    [ -x "$root/node_modules/.bin/prettier" ] && (cd "$root" && node_modules/.bin/prettier --write --log-level silent --ignore-unknown "$path" 2>/dev/null) ;;
esac
exit 0
