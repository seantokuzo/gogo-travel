#!/usr/bin/env bash
# Hook: Stop — desktop/terminal notification when Claude finishes a turn.
# Best-effort and silent: never errors, always exits 0.
#
# Wiring (owner-agent):
#   "Stop": [{ "hooks": [{ "type": "command",
#     "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/post-response-notify.sh\"" }]}]

set -uo pipefail

# Project name for context (so multi-repo users know which session pinged).
INPUT="$(cat 2>/dev/null || true)"
CWD=""
if [ -n "$INPUT" ] && command -v jq >/dev/null 2>&1; then
  CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)"
fi
[ -z "$CWD" ] && CWD="${PWD:-}"
PROJECT="$(basename -- "${CWD:-Claude Code}" 2>/dev/null || printf 'Claude Code')"
PROJECT="${PROJECT//\"/}"; PROJECT="${PROJECT//\\/}"   # strip chars that break osascript

TITLE="Claude Code — $PROJECT"
MESSAGE="Finished — ready for you."

notify() {
  # 1) terminal-notifier (clickable) if installed.
  if command -v terminal-notifier >/dev/null 2>&1; then
    terminal-notifier -title "$TITLE" -message "$MESSAGE" -sound Glass >/dev/null 2>&1 && return 0
  fi
  # 2) macOS native.
  if [[ "${OSTYPE:-}" == darwin* ]] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\" sound name \"Glass\"" >/dev/null 2>&1 && return 0
  fi
  # 3) Linux.
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "$TITLE" "$MESSAGE" >/dev/null 2>&1 && return 0
  fi
  # 4) Terminal bell, last resort.
  printf '\a' 2>/dev/null || true
}
notify || true
exit 0
