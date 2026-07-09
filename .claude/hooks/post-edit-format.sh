#!/usr/bin/env bash
# Hook: PostToolUse (matcher: Write|Edit|MultiEdit)
# Formats the just-edited file with the repo's prettier (root prettier.config.mjs).
#
# Best-effort: ALWAYS exits 0. Never fails the tool, never reformats file types
# prettier can't handle, never hits the network.
#
# Wiring (owner-agent):
#   "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit",
#     "hooks": [{ "type": "command",
#       "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-format.sh\"" }]}]

set -uo pipefail

# Resolve repo root from this script's location (.claude/hooks -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd || printf '.')"

# --- Which file was edited? stdin JSON first, env var as fallback. ---
INPUT="$(cat 2>/dev/null || true)"
FILE_PATH=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    FILE_PATH="$(python3 -c '
import sys, json
try:
    d = json.loads(sys.argv[1])
except Exception:
    print(""); sys.exit(0)
ti = d.get("tool_input") or {}
print(ti.get("file_path") or ti.get("notebook_path") or "")
' "$INPUT" 2>/dev/null || true)"
  fi
fi
[ -z "$FILE_PATH" ] && FILE_PATH="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"
[ -z "$FILE_PATH" ] && exit 0
[ -f "$FILE_PATH" ] || exit 0

# --- Only run on file types prettier handles out of the box. ---
case "$FILE_PATH" in
  *.js|*.jsx|*.cjs|*.mjs|*.ts|*.tsx|*.cts|*.mts|*.json|*.jsonc|*.json5|*.css|*.scss|*.less|*.html|*.htm|*.md|*.mdx|*.yaml|*.yml|*.graphql|*.gql) ;;
  *) exit 0 ;;
esac

# --- Format. Prefer the repo-local prettier binary; fall back to pnpm exec. ---
if [ -x "$REPO_ROOT/node_modules/.bin/prettier" ]; then
  ( cd "$REPO_ROOT" && "$REPO_ROOT/node_modules/.bin/prettier" --write --log-level=warn "$FILE_PATH" ) >/dev/null 2>&1 || true
elif command -v pnpm >/dev/null 2>&1; then
  ( cd "$REPO_ROOT" && pnpm exec prettier --write --log-level=warn "$FILE_PATH" ) >/dev/null 2>&1 || true
fi

exit 0
