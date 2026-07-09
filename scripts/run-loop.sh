#!/usr/bin/env bash
# run-loop.sh — autonomous-mode chain wrapper for gogo-travel.
#
# Invokes the `claude -p` non-interactive CLI in a loop, gated by sentinel files
# in `.loop/`. The presence of `.loop/state.json` is the master "autonomous mode
# is ON" switch — the Stop hook (`.claude/hooks/autonomous-handoff.sh`) also keys
# off this file.
#
# Sentinel protocol (full spec: .agents/skills/autonomous-loop/SKILL.md):
#   .loop/state.json     — schema; presence = autonomous mode ON
#   .loop/next-prompt.md — instructions for the next session in the chain
#   .loop/done           — chain complete, exit cleanly + cleanup
#   .loop/pivot          — need human direction, stop chain (state preserved)
#   .loop/blocked        — stuck, surface to human (state preserved)
#
# Commands: start [--prompt "..."] | stop | status | help
#
# Portability: bash 3.2+ (macOS default). `jq` is optional; we use it when
# available and fall back to a portable rewrite otherwise.

set -euo pipefail

LOOP_DIR=".loop"
STATE_FILE="$LOOP_DIR/state.json"
NEXT_PROMPT_FILE="$LOOP_DIR/next-prompt.md"
LOG_FILE="$LOOP_DIR/log.txt"
HOOK_PATH=".claude/hooks/autonomous-handoff.sh"
SETTINGS_FILE=".claude/settings.json"

DEFAULT_PROMPT='Read .agents/skills/autonomous-loop/SKILL.md, then read docs/QUEUE.md and CLAUDE.md. You are running in autonomous mode. Execute the next available work item per the sentinel discipline. Honor opt-out signals.'

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  local ts
  ts="$(now_iso)"
  printf '[%s] run-loop: %s\n' "$ts" "$1" | tee -a "$LOG_FILE" >&2
}

have_jq() {
  command -v jq >/dev/null 2>&1
}

# ---------- usage ----------

print_help() {
  cat <<'EOF'
run-loop.sh — autonomous-mode chain wrapper

USAGE
  scripts/run-loop.sh start [--prompt "<initial prompt>"]
      Bootstrap `.loop/` state and begin the chain. Refuses if already ON.

  scripts/run-loop.sh stop
      Tear down `.loop/`. Confirms interactively if stdin is a TTY.

  scripts/run-loop.sh status
      Print current loop state. Exits 0 either way.

  scripts/run-loop.sh help | -h | --help
      Show this message.

SENTINELS (Claude writes these from inside a session)
  .loop/done            chain complete — wrapper cleans up and exits 0
  .loop/pivot           need human direction — wrapper exits 0, state preserved
  .loop/blocked         stuck — wrapper exits 1, state preserved
  .loop/next-prompt.md  populated and non-empty → next iteration runs

SAFETY
  Hard cap: max_chain iterations (default 20). After that the wrapper stops
  with exit 2 even if work remains. Edit `max_chain` in `.loop/state.json` to
  raise — but consider whether the plan needs smaller tasks instead.

SETUP REQUIRED ONCE
  Add the Stop hook to `.claude/settings.json`. See:
    .agents/skills/autonomous-loop/SKILL.md  (section: "Required hook setup")
EOF
}

# ---------- hook verification ----------

ensure_hook_installed() {
  if [ ! -f "$SETTINGS_FILE" ]; then
    cat >&2 <<EOF
ERROR: $SETTINGS_FILE not found.

The autonomous-loop wrapper requires the Stop hook to be installed. Create
$SETTINGS_FILE with at minimum:

{
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "$HOOK_PATH"}]}
    ]
  }
}

Full setup instructions: .agents/skills/autonomous-loop/SKILL.md
EOF
    exit 1
  fi

  if ! grep -q "autonomous-handoff.sh" "$SETTINGS_FILE"; then
    cat >&2 <<EOF
ERROR: Stop hook not found in $SETTINGS_FILE.

Add this to your settings (merge with existing "hooks" block if present):

{
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "$HOOK_PATH"}]}
    ]
  }
}

Full setup instructions: .agents/skills/autonomous-loop/SKILL.md
EOF
    exit 1
  fi

  if [ ! -x "$HOOK_PATH" ]; then
    echo "ERROR: $HOOK_PATH is not executable. Run: chmod +x $HOOK_PATH" >&2
    exit 1
  fi
}

# ---------- state.json helpers ----------

# Write a fresh state.json. Used at start and as the portable fallback.
write_initial_state() {
  local started_at="$1"
  cat > "$STATE_FILE" <<EOF
{
  "active_phase": null,
  "active_task": null,
  "completed_this_session": [],
  "session_count": 0,
  "started_at": "$started_at",
  "last_update": "$started_at",
  "max_chain": 20
}
EOF
}

# Read max_chain from state.json. Prefer jq; fall back to grep.
# Hard-capped at 100 (T-4.5) so a buggy or hostile state.json edit (e.g.
# `"max_chain": 999999`) can't blow past the safety intent. If a phase
# legitimately needs more than 100 chained sessions, the plan needs
# smaller tasks — not a bigger cap.
MAX_CHAIN_CAP=100

read_max_chain() {
  local value
  if have_jq; then
    value="$(jq -r '.max_chain // 20' "$STATE_FILE")"
  else
    value="$(grep -E '"max_chain"' "$STATE_FILE" | sed -E 's/.*: *([0-9]+).*/\1/' | head -n1)"
  fi
  if [ -z "$value" ] || ! [[ "$value" =~ ^[0-9]+$ ]]; then
    value=20
  fi
  if [ "$value" -gt "$MAX_CHAIN_CAP" ]; then
    log "max_chain=$value in state.json exceeds hard cap ($MAX_CHAIN_CAP) — clamping"
    echo "⚠️  max_chain=$value clamped to $MAX_CHAIN_CAP (hard cap)." >&2
    value="$MAX_CHAIN_CAP"
  fi
  echo "$value"
}

# Bump session_count and last_update without clobbering other fields.
increment_session_count() {
  local ts
  ts="$(now_iso)"
  if have_jq; then
    local tmp
    tmp="$(mktemp)"
    jq --arg ts "$ts" '.session_count = (.session_count + 1) | .last_update = $ts' "$STATE_FILE" > "$tmp"
    mv "$tmp" "$STATE_FILE"
  else
    # Portable fallback: parse current values with grep+sed, then rewrite.
    local cur
    cur="$(grep -E '"session_count"' "$STATE_FILE" | sed -E 's/.*: *([0-9]+).*/\1/' | head -n1)"
    if ! [[ "$cur" =~ ^[0-9]+$ ]]; then cur=0; fi
    local next=$((cur + 1))
    # Update session_count line.
    sed -i.bak -E "s/(\"session_count\"[[:space:]]*:[[:space:]]*)[0-9]+/\1$next/" "$STATE_FILE"
    # Update last_update line.
    sed -i.bak -E "s/(\"last_update\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"/\1\"$ts\"/" "$STATE_FILE"
    rm -f "$STATE_FILE.bak"
  fi
}

# ---------- commands ----------

cmd_start() {
  local prompt="$DEFAULT_PROMPT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt)
        if [ $# -lt 2 ]; then
          echo "ERROR: --prompt requires a value." >&2
          exit 1
        fi
        prompt="$2"
        shift 2
        ;;
      *)
        echo "ERROR: unknown start argument: $1" >&2
        print_help >&2
        exit 1
        ;;
    esac
  done

  if [ -f "$STATE_FILE" ]; then
    echo "ERROR: Autonomous mode is already ON. Use 'stop' first." >&2
    exit 1
  fi

  ensure_hook_installed

  if ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: 'claude' CLI not found in PATH." >&2
    exit 1
  fi

  mkdir -p "$LOOP_DIR"
  local started_at
  started_at="$(now_iso)"
  write_initial_state "$started_at"
  printf '%s\n' "$prompt" > "$NEXT_PROMPT_FILE"
  : > "$LOG_FILE"
  log "started autonomous mode at $started_at"

  local max_chain
  max_chain="$(read_max_chain)"
  log "max_chain=$max_chain"

  local iteration=0
  while :; do
    iteration=$((iteration + 1))
    if [ "$iteration" -gt "$max_chain" ]; then
      echo "⛔ Hit max chain ($max_chain). Stopping for safety." >&2
      log "hit max chain ($max_chain) — aborting"
      exit 2
    fi

    # Whitespace-only content passes the bash `-s` size check (T-4.5 fix).
    # Also probe for at least one non-whitespace byte so an empty placeholder
    # left behind by a buggy session can't trigger a wasted iteration.
    if [ ! -s "$NEXT_PROMPT_FILE" ] || ! grep -q '[^[:space:]]' "$NEXT_PROMPT_FILE"; then
      log "next-prompt.md is empty or whitespace-only at iteration $iteration — nothing to do, stopping"
      echo "⚠️  next-prompt.md is empty or whitespace-only and no terminal sentinel set. Stopping." >&2
      exit 1
    fi

    local current_prompt
    current_prompt="$(cat "$NEXT_PROMPT_FILE")"
    # Truncate (don't delete) so the file stays present for the next session.
    : > "$NEXT_PROMPT_FILE"

    log "iteration $iteration — invoking claude -p"
    # Run claude. Don't let a non-zero exit kill the wrapper here — we want to
    # inspect sentinels and surface a meaningful message before exiting.
    set +e
    claude -p "$current_prompt" --output-format text
    local rc=$?
    set -e
    log "iteration $iteration — claude exited rc=$rc"

    increment_session_count

    # Check terminal sentinels in priority order: done > pivot > blocked.
    # Canonical spec: .agents/skills/autonomous-loop/SKILL.md § "Priority ordering".
    # Keep this order in sync with .claude/hooks/autonomous-handoff.sh.
    if [ -e "$LOOP_DIR/done" ]; then
      echo "✅ Loop complete."
      log "sentinel: done — cleaning up"
      rm -rf "$LOOP_DIR"
      exit 0
    fi

    if [ -e "$LOOP_DIR/pivot" ]; then
      echo "🔀 Pivot requested:"
      cat "$LOOP_DIR/pivot"
      log "sentinel: pivot — state preserved for inspection"
      exit 0
    fi

    if [ -e "$LOOP_DIR/blocked" ]; then
      echo "🚧 Blocked:" >&2
      cat "$LOOP_DIR/blocked" >&2
      log "sentinel: blocked — state preserved for inspection"
      exit 1
    fi

    # If claude exited non-zero AND no sentinel was set, surface that.
    if [ "$rc" -ne 0 ]; then
      echo "ERROR: claude -p exited with rc=$rc and no sentinel was set." >&2
      log "claude rc=$rc with no sentinel — bailing"
      exit "$rc"
    fi

    if [ ! -s "$NEXT_PROMPT_FILE" ] || ! grep -q '[^[:space:]]' "$NEXT_PROMPT_FILE"; then
      # No sentinel and no follow-up prompt (or only whitespace) — the
      # hook should have written blocked, but defend anyway (T-4.5).
      echo "ERROR: session ended without a sentinel and without queuing a non-empty next prompt." >&2
      log "no sentinel + empty/whitespace next-prompt — bailing"
      exit 1
    fi

    sleep 5
  done
}

cmd_stop() {
  if [ ! -d "$LOOP_DIR" ]; then
    echo "Autonomous mode is already OFF."
    exit 0
  fi

  if [ -t 0 ]; then
    printf "Remove .loop/ and turn autonomous mode OFF? [y/N] "
    read -r reply
    case "$reply" in
      y|Y|yes|YES) ;;
      *) echo "Aborted."; exit 0 ;;
    esac
  fi

  rm -rf "$LOOP_DIR"
  echo "Autonomous mode: OFF (removed .loop/)."
}

cmd_status() {
  if [ -f "$STATE_FILE" ]; then
    echo "Autonomous mode: ON"
    echo "--- $STATE_FILE ---"
    if have_jq; then
      jq . "$STATE_FILE"
    else
      cat "$STATE_FILE"
    fi
  else
    echo "Autonomous mode: OFF"
  fi
}

# ---------- dispatch ----------

main() {
  if [ $# -eq 0 ]; then
    print_help
    exit 0
  fi

  local cmd="$1"
  shift
  case "$cmd" in
    start)  cmd_start "$@" ;;
    stop)   cmd_stop "$@" ;;
    status) cmd_status "$@" ;;
    help|-h|--help) print_help ;;
    *)
      echo "ERROR: unknown command: $cmd" >&2
      print_help >&2
      exit 1
      ;;
  esac
}

main "$@"
