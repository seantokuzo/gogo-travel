#!/usr/bin/env bash
# autonomous-handoff.sh — Stop hook enforcing the autonomous-loop handoff contract.
#
# No-ops unless autonomous mode is ON (`.loop/state.json` exists). When ON and a
# session ends WITHOUT a control sentinel or a non-empty next-prompt, it writes a
# `blocked` sentinel as a safety net so the loop never silently derails.
#
# The loop is OPT-IN: with no `.loop/` directory this hook does nothing, so
# interactive sessions are completely unaffected.
# Canonical spec (when present): .agents/skills/autonomous-loop/SKILL.md
#
# CONTRACT: ALWAYS exits 0 — never blocks Claude from stopping.

set -uo pipefail
trap 'exit 0' EXIT   # belt-and-suspenders: no path may exit non-zero

# Resolve repo root from this script's location (.claude/hooks -> repo root) so
# the right .loop/ is used even from a worktree or odd cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd || printf '.')"

LOOP_DIR="$REPO_ROOT/.loop"
STATE_FILE="$LOOP_DIR/state.json"
LOG_FILE="$LOOP_DIR/log.txt"

# Autonomous mode OFF (no .loop/state.json) -> bail silently.
[ -f "$STATE_FILE" ] || exit 0

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')"
  printf '[%s] autonomous-handoff: %s\n' "$ts" "${1:-}" >> "$LOG_FILE" 2>/dev/null || true
}

# Terminal sentinels, priority order: done > pivot > blocked. First match wins.
for sentinel in done pivot blocked; do
  if [ -e "$LOOP_DIR/$sentinel" ]; then
    log "session ended with sentinel: $sentinel"
    exit 0
  fi
done

# No control sentinel — accept a queued next-prompt only if it has REAL
# (non-whitespace) content, so an empty placeholder can't fool the hook.
if [ -s "$LOOP_DIR/next-prompt.md" ] && grep -q '[^[:space:]]' "$LOOP_DIR/next-prompt.md" 2>/dev/null; then
  log "session ended with next-prompt queued"
  exit 0
fi

# Neither sentinel nor queued prompt — auto-write blocked as a safety net.
printf '%s\n' "Session ended without writing a sentinel or queuing next prompt. Inspect .loop/log.txt and recent commits." \
  > "$LOOP_DIR/blocked" 2>/dev/null || true
log "missing sentinel — auto-wrote blocked"
exit 0
