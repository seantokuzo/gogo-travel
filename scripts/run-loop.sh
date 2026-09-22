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
# Commands: start [--prompt "..."] | resume --prompt "..." | stop | status | help
#
# Portability: bash 3.2+ (macOS default). `jq` is optional; we use it when
# available and fall back to a portable rewrite otherwise.

set -euo pipefail

LOOP_DIR=".loop"
STATE_FILE="$LOOP_DIR/state.json"
NEXT_PROMPT_FILE="$LOOP_DIR/next-prompt.md"
LOG_FILE="$LOOP_DIR/log.txt"
ARCHIVE_DIR="$LOOP_DIR/archive"
HOOK_PATH=".claude/hooks/autonomous-handoff.sh"
SETTINGS_FILE=".claude/settings.json"

# Permission flags for the chained `claude -p` invocation. Populated by
# probe_permission_flags() — never expand this before that has run; bash 3.2
# treats "${PERM_FLAGS[@]}" on a still-empty array as an unbound variable
# under `set -u`.
PERM_FLAGS=()

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
      Bootstrap `.loop/` state and begin the chain. Refuses if already ON —
      if halted on pivot/blocked, use `resume` instead of `stop` + `start`.

  scripts/run-loop.sh resume --prompt "<answer>"
      Answer a `pivot` or `blocked` sentinel and continue the SAME chain.
      Archives the sentinel to `.loop/archive/`, queues the answer as the
      next prompt, and resumes — session_count and started_at are preserved,
      so max_chain still bounds the whole run across resumes. Refuses if
      autonomous mode is OFF, or if no pivot/blocked sentinel is present
      (there is nothing to resume from; note `done` is never resumable).

  scripts/run-loop.sh stop
      Tear down `.loop/`. Confirms interactively if stdin is a TTY.

  scripts/run-loop.sh status
      Print current loop state: OFF (no state), HALTED (a sentinel is
      present — body printed inline), RUNNING (wrapper pid + session count),
      or INTERRUPTED (state exists but the wrapper process is gone and no
      sentinel was written). Exits 0 either way.

  scripts/run-loop.sh help | -h | --help
      Show this message.

SENTINELS (Claude writes these from inside a session)
  .loop/done            chain complete — wrapper cleans up and exits 0
  .loop/pivot           need human direction — wrapper exits 0, state preserved
  .loop/blocked         stuck — wrapper exits 1, state preserved
  .loop/next-prompt.md  populated and non-empty → next iteration runs
  .loop/archive/        pivot/blocked sentinels `resume` has answered — kept
                         for the record, never re-checked by the wrapper

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
  "max_chain": 20,
  "wrapper_pid": $$
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

# Read an integer top-level field from state.json. Portable fallback when jq
# isn't available (same grep+sed idiom as read_max_chain). Echoes an empty
# string — never errors — if the field is absent or not a plain integer;
# callers must check for that themselves.
read_state_field() {
  local field="$1"
  local value
  if have_jq; then
    value="$(jq -r --arg f "$field" '.[$f] // empty' "$STATE_FILE" 2>/dev/null || true)"
  else
    value="$(grep -E "\"$field\"" "$STATE_FILE" 2>/dev/null | sed -E 's/.*: *([0-9]+).*/\1/' | head -n1)"
  fi
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    value=""
  fi
  echo "$value"
}

# Stamp the CURRENT process's pid into state.json as wrapper_pid, bumping
# last_update. `start` doesn't need this — write_initial_state stamps its own
# pid directly at creation. `resume` does: it runs as a brand-new process, so
# the pid recorded by the run that halted on the sentinel is already dead and
# must be replaced before `status` can tell the resumed chain is alive.
update_wrapper_pid() {
  local pid="$1"
  local ts
  ts="$(now_iso)"
  if have_jq; then
    local tmp
    tmp="$(mktemp)"
    jq --argjson pid "$pid" --arg ts "$ts" '.wrapper_pid = $pid | .last_update = $ts' "$STATE_FILE" > "$tmp"
    mv "$tmp" "$STATE_FILE"
  else
    sed -i.bak -E "s/(\"wrapper_pid\"[[:space:]]*:[[:space:]]*)[0-9]+/\1$pid/" "$STATE_FILE"
    sed -i.bak -E "s/(\"last_update\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"/\1\"$ts\"/" "$STATE_FILE"
    rm -f "$STATE_FILE.bak"
  fi
}

# ---------- permission capability probe ----------

# Permission posture for unattended runs. `-p`'s built-in starting mode is
# Manual and a chained session has no TTY, so anything that would prompt must
# be DENIED and reported back rather than awaited. `--permission-prompts none`
# additionally tells Claude not to retry a denied request, so a single `ask`
# rule can't burn an iteration in retry loops.
#
# Capability is probed from --help, not a version string, and BEFORE any state
# is written: an unsupported choice is rejected at option-parse time, which
# would otherwise abort after `.loop/` exists and the operator's prompt has
# been truncated, leaving a stuck loop and a lost prompt. `auto` needs CLI
# >= 2.1.228, `--permission-prompts` >= 2.1.259.
#
# Sets the module-level PERM_FLAGS array (bash arrays don't survive being
# returned from a function, so this is set-as-side-effect rather than echoed).
probe_permission_flags() {
  local help_text
  help_text="$(claude --help 2>/dev/null || true)"
  if ! printf '%s' "$help_text" | grep -q -- '--permission-mode'; then
    echo "ERROR: this 'claude' CLI has no --permission-mode. A chained session" >&2
    echo "       has no TTY, so it would start in Manual and deny every prompt." >&2
    echo "       Upgrade to v2.1.259 or later." >&2
    exit 1
  fi
  if ! printf '%s' "$help_text" | grep -q '"auto"'; then
    echo "ERROR: this 'claude' CLI does not accept --permission-mode auto" >&2
    echo "       (added in v2.1.228). Every iteration would abort at" >&2
    echo "       option-parse time. Upgrade to v2.1.259 or later." >&2
    exit 1
  fi
  PERM_FLAGS=(--permission-mode auto)
  if printf '%s' "$help_text" | grep -q -- '--permission-prompts'; then
    PERM_FLAGS+=(--permission-prompts none)
  else
    echo "WARNING: this 'claude' CLI has no --permission-prompts (v2.1.259+)." >&2
    echo "         A denied permission may be retried instead of reported." >&2
    echo "         The chain will still run." >&2
  fi
}

# ---------- chain loop ----------

# Drive the chain: read next-prompt.md, invoke `claude -p`, check sentinels,
# repeat until a terminal sentinel fires, max_chain is hit, or an unrecovered
# error occurs. Requires PERM_FLAGS to already be populated (probe_permission_
# flags) and next-prompt.md to already hold the first prompt to run.
#
# The iteration counter seeds from the CURRENT session_count in state.json
# rather than 0, so that a resumed chain doesn't get a fresh max_chain budget
# — the cap bounds the whole run (across `start` + any `resume`s), not each
# process invocation. For a fresh `start` session_count is 0, so this is a
# no-op behaviourally: iteration numbering is unchanged from before.
run_chain() {
  local max_chain
  max_chain="$(read_max_chain)"
  log "max_chain=$max_chain"

  local iteration
  iteration="$(read_state_field session_count)"
  if [ -z "$iteration" ]; then
    iteration=0
  fi

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
    claude -p "$current_prompt" --output-format text "${PERM_FLAGS[@]}"
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
    if [ -e "$LOOP_DIR/pivot" ] || [ -e "$LOOP_DIR/blocked" ]; then
      echo "ERROR: Autonomous mode is already ON and halted on a sentinel." >&2
      echo "       Use 'resume --prompt \"<answer>\"' to continue, or 'stop' to tear down." >&2
    else
      echo "ERROR: Autonomous mode is already ON. Use 'stop' first." >&2
    fi
    exit 1
  fi

  ensure_hook_installed

  if ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: 'claude' CLI not found in PATH." >&2
    exit 1
  fi

  probe_permission_flags

  mkdir -p "$LOOP_DIR"
  local started_at
  started_at="$(now_iso)"
  write_initial_state "$started_at"
  printf '%s\n' "$prompt" > "$NEXT_PROMPT_FILE"
  : > "$LOG_FILE"
  log "started autonomous mode at $started_at"
  log "permission posture: ${PERM_FLAGS[*]}"

  run_chain
}

cmd_resume() {
  local prompt="" prompt_set=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt)
        if [ $# -lt 2 ]; then
          echo "ERROR: --prompt requires a value." >&2
          exit 1
        fi
        prompt="$2"
        prompt_set=1
        shift 2
        ;;
      *)
        echo "ERROR: unknown resume argument: $1" >&2
        print_help >&2
        exit 1
        ;;
    esac
  done

  if [ ! -f "$STATE_FILE" ]; then
    echo "ERROR: Autonomous mode is not ON. Use 'start' instead." >&2
    exit 1
  fi

  # `done` outranks pivot/blocked in the sentinel priority order (see SKILL.md
  # § "Priority ordering") — if it's present the chain is already finished,
  # regardless of what other lower-priority sentinel also happens to exist.
  # Never resumable; the wrapper would have torn `.loop/` down already on its
  # next check.
  if [ -e "$LOOP_DIR/done" ]; then
    echo "ERROR: chain already completed ('done' sentinel present) — nothing to resume." >&2
    echo "       Use 'stop' to clear state, or 'status' to inspect." >&2
    exit 1
  fi

  local sentinel=""
  if [ -e "$LOOP_DIR/pivot" ]; then
    sentinel="pivot"
  elif [ -e "$LOOP_DIR/blocked" ]; then
    sentinel="blocked"
  fi

  if [ -z "$sentinel" ]; then
    echo "ERROR: nothing to resume from — no 'pivot' or 'blocked' sentinel present." >&2
    echo "       Use 'status' to see the current loop state." >&2
    exit 1
  fi

  if [ "$prompt_set" -ne 1 ]; then
    echo "ERROR: 'resume' requires --prompt \"<answer to the $sentinel>\"." >&2
    exit 1
  fi

  ensure_hook_installed

  if ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: 'claude' CLI not found in PATH." >&2
    exit 1
  fi

  probe_permission_flags

  mkdir -p "$ARCHIVE_DIR"
  local archive_ts archive_path
  archive_ts="$(date -u +%Y%m%dT%H%M%SZ)"
  archive_path="$ARCHIVE_DIR/${sentinel}-${archive_ts}.md"
  mv "$LOOP_DIR/$sentinel" "$archive_path"

  printf '%s\n' "$prompt" > "$NEXT_PROMPT_FILE"
  update_wrapper_pid "$$"
  log "resumed autonomous mode (was: $sentinel, archived to $archive_path)"
  log "permission posture: ${PERM_FLAGS[*]}"

  run_chain
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
  if [ ! -f "$STATE_FILE" ]; then
    echo "Autonomous mode: OFF"
    return 0
  fi

  # Sentinel priority order: done > pivot > blocked (see SKILL.md § "Priority
  # ordering"). A halted chain reports the sentinel it halted on rather than
  # trying to infer liveness — that's the whole point of this command.
  local sentinel=""
  if [ -e "$LOOP_DIR/done" ]; then
    sentinel="done"
  elif [ -e "$LOOP_DIR/pivot" ]; then
    sentinel="pivot"
  elif [ -e "$LOOP_DIR/blocked" ]; then
    sentinel="blocked"
  fi

  if [ -n "$sentinel" ]; then
    echo "HALTED — $sentinel"
    cat "$LOOP_DIR/$sentinel"
  else
    # No sentinel — either the wrapper is still chained-looping, or it died
    # (machine slept, terminal closed, process killed) without getting a
    # chance to write one. Distinguish using the pid it stamped into
    # state.json at start/resume.
    local pid
    pid="$(read_state_field wrapper_pid)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      local session_count
      session_count="$(read_state_field session_count)"
      echo "RUNNING — wrapper pid $pid, session_count=${session_count:-0}"
    else
      echo "INTERRUPTED — wrapper gone, no sentinel written"
    fi
  fi

  echo "--- $STATE_FILE ---"
  if have_jq; then
    jq . "$STATE_FILE"
  else
    cat "$STATE_FILE"
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
    resume) cmd_resume "$@" ;;
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
