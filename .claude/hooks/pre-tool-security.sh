#!/usr/bin/env bash
# Hook: PreToolUse (matcher: Read|Write|Edit|MultiEdit|Bash)
# Fail-secure guard. Blocks reads/writes of secrets and catastrophic Bash.
#
# Block protocol: print a reason to STDERR and exit 2 — Claude Code denies the
# tool call and feeds the reason back to the model. Exit 0 = allow.
#
# Design rules:
#   - FAST: runs before every matched tool call.
#   - PRECISE: must not false-positive on normal work (e.g. `rm -rf ./build`,
#     `git push --force-with-lease feature`).
#   - ROBUST: prefers jq, falls back to python3, then to a raw catastrophic-only
#     scan. Never crashes the session.
#
# Wiring (owner-agent — DO NOT edit settings here):
#   "PreToolUse": [{ "matcher": "Read|Write|Edit|MultiEdit|Bash",
#     "hooks": [{ "type": "command",
#       "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/pre-tool-security.sh\"" }]}]

set -uo pipefail
set -f   # disable globbing: no token expansion when we word-split commands

INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && exit 0   # nothing to inspect -> allow

block() {
  printf 'BLOCKED by security hook: %s\n' "${1:-policy violation}" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# JSON parsing: jq preferred, python3 fallback, raw-scan last resort.
# ---------------------------------------------------------------------------
PARSER=""
if command -v jq >/dev/null 2>&1; then
  PARSER="jq"
elif command -v python3 >/dev/null 2>&1; then
  PARSER="python3"
fi

# No JSON parser at all (jq AND python3 both missing — practically never on
# macOS): don't brick the session. Scan the raw payload for only the most
# catastrophic substrings, then allow. This path is intentionally conservative.
if [ -z "$PARSER" ]; then
  case "$INPUT" in
    *"rm -rf /"*|*"rm -fr /"*|*"rm -rf ~"*|*"rm -fr ~"*|*"--no-preserve-root"*|*":(){"*|*"mkfs"*)
      block "catastrophic command detected (no JSON parser available; raw-scan match)" ;;
  esac
  exit 0
fi

jq_get() {  # $@ = key path -> prints string value or ""
  local f="" k
  for k in "$@"; do f="$f.$k"; done
  printf '%s' "$INPUT" | jq -r "$f // empty" 2>/dev/null || true
}
py_get() {  # $@ = key path -> prints string value or ""
  python3 -c '
import sys, json
try:
    d = json.loads(sys.argv[1])
except Exception:
    print(""); sys.exit(0)
cur = d
for k in sys.argv[2:]:
    cur = cur.get(k) if isinstance(cur, dict) else None
print(cur if isinstance(cur, str) else "")
' "$INPUT" "$@" 2>/dev/null || true
}
get() {
  case "$PARSER" in
    jq) jq_get "$@" ;;
    python3) py_get "$@" ;;
  esac
}

TOOL_NAME="$(get tool_name)"
[ -z "$TOOL_NAME" ] && exit 0

# ---------------------------------------------------------------------------
# File-access guard (Read / Write / Edit / MultiEdit / NotebookEdit).
# ---------------------------------------------------------------------------
check_file_path() {
  local p="${1:-}"
  [ -z "$p" ] && return 0
  local base; base="$(basename -- "$p" 2>/dev/null || printf '%s' "$p")"

  # Allow env/config TEMPLATES first — they hold placeholders, not secrets.
  case "$base" in
    *.example|*.sample|*.template|*.dist) return 0 ;;
  esac

  # Real env files.
  case "$base" in
    .env|.env.*|*.env) block "reading/writing env files is blocked (secrets). Use the .env.example template or a real env var." ;;
  esac

  # Key / certificate material.
  case "$p" in
    *.pem|*.key|*.p12|*.pfx|*.keystore|*.jks|*.asc|*.gpg|*.ppk)
      block "'$base' looks like private key / certificate material." ;;
  esac

  # Well-known credential files & locations.
  case "$base" in
    id_rsa|id_dsa|id_ecdsa|id_ed25519|.npmrc|.netrc|.pgpass|credentials|credentials.json|secrets.json|secrets.yaml|secrets.yml)
      block "'$base' looks like a credentials/secrets file." ;;
  esac
  case "$p" in
    */.ssh/*|*/.aws/credentials|*/.gnupg/*|*/secrets/*)
      block "'$p' is in a sensitive credentials/secrets location." ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Bash guard — catastrophic deletes + destructive git only. Precise on purpose.
# ---------------------------------------------------------------------------
is_recursive_rm() {
  local c="$1"
  [[ "$c" =~ (^|[[:space:]\;\&\|\(\{])rm([[:space:]]|$) ]] || return 1
  [[ "$c" =~ (^|[[:space:]])-[A-Za-z]*[rR] ]] || [[ "$c" =~ --recursive ]] || return 1
  return 0
}
target_is_root_or_home() {
  local c="$1"
  [[ "$c" =~ [[:space:]]\"?/\"?([[:space:]]|$) ]] && return 0   # " /"  ' "/" '
  [[ "$c" =~ [[:space:]]/\* ]] && return 0                      # " /*"
  [[ "$c" =~ [[:space:]]~/?([[:space:]]|$) ]] && return 0       # " ~"  " ~/"
  [[ "$c" =~ [[:space:]]\"?\$\{?HOME\}?\"? ]] && return 0       # $HOME ${HOME} "$HOME"
  return 1
}

check_bash() {
  local cmd="${1:-}" cwd="${2:-}"
  [ -z "$cmd" ] && return 0

  # --- Catastrophic filesystem ops ---
  if [[ "$cmd" =~ --no-preserve-root ]]; then
    block "rm --no-preserve-root targets the filesystem root."
  fi
  if is_recursive_rm "$cmd" && target_is_root_or_home "$cmd"; then
    block "recursive delete of root (/) or home (~) is forbidden."
  fi
  case "$cmd" in
    *":(){"*|*":() {"*) block "fork bomb pattern detected." ;;
  esac
  if [[ "$cmd" =~ (^|[[:space:]])dd([[:space:]].*)?of=/dev/ ]]; then
    block "dd writing to a raw device (/dev/...) can destroy disks."
  fi
  if [[ "$cmd" =~ (^|[[:space:]])mkfs ]]; then
    block "mkfs formats a filesystem — refusing."
  fi

  # --- Destructive git ---
  if [[ "$cmd" =~ (^|[[:space:]\;\&\|\(])git([[:space:]]|$) ]]; then

    # git reset --hard (discards work).
    if [[ "$cmd" =~ reset([[:space:]]|$) ]] && [[ "$cmd" =~ --hard ]]; then
      block "'git reset --hard' discards uncommitted work. Stash first, or run it yourself in a terminal."
    fi

    # History rewrites.
    case "$cmd" in
      *filter-branch*|*filter-repo*) block "history rewrite (filter-branch/filter-repo) is forbidden." ;;
      *"reflog expire"*)             block "'git reflog expire' destroys recovery history." ;;
      *"push --mirror"*|*"push --prune"*) block "mirror/prune push can delete remote refs." ;;
    esac
    if [[ "$cmd" =~ rebase([[:space:]].*)?(-i([[:space:]]|$)|--interactive) ]]; then
      block "interactive rebase isn't supported in this environment (history rewrite)."
    fi

    # Force-push to main/master (explicit ref) or bare force-push while ON main.
    if [[ "$cmd" =~ push ]] && { [[ "$cmd" =~ --force ]] || [[ "$cmd" =~ (^|[[:space:]])-f([[:space:]]|$) ]]; }; then
      # Parse positional args after the last 'push' (flags removed).
      local after="${cmd##*push}"
      local seen_remote=0 explicit_ref="" tok
      for tok in $after; do
        case "$tok" in
          -*) continue ;;
        esac
        if [ "$seen_remote" -eq 0 ]; then seen_remote=1; continue; fi
        explicit_ref="$tok"
        case "$tok" in
          main|master|*:main|*:master|main:*|master:*|HEAD:main|HEAD:master)
            block "force-pushing main/master is forbidden." ;;
        esac
      done
      if [ -z "$explicit_ref" ]; then
        # Bare push of the current branch — block only if HEAD is main/master.
        local br=""
        if [ -n "$cwd" ] && command -v git >/dev/null 2>&1; then
          br="$(git -C "$cwd" branch --show-current 2>/dev/null || true)"
        elif command -v git >/dev/null 2>&1; then
          br="$(git branch --show-current 2>/dev/null || true)"
        fi
        case "$br" in
          main|master) block "force-pushing the current branch ($br) is forbidden." ;;
        esac
      fi
    fi
  fi
  return 0
}

case "$TOOL_NAME" in
  Read|Write|Edit|MultiEdit|NotebookEdit)
    FILE_PATH="$(get tool_input file_path)"
    [ -z "$FILE_PATH" ] && FILE_PATH="$(get tool_input notebook_path)"
    check_file_path "$FILE_PATH"
    ;;
  Bash)
    COMMAND="$(get tool_input command)"
    CWD="$(get cwd)"
    check_bash "$COMMAND" "$CWD"
    ;;
esac

exit 0
