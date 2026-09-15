#!/usr/bin/env bash
# test-hooks.sh — regression tests for .claude/hooks/pre-tool-security.sh
#
# Why this exists: check_bash once guarded only catastrophic deletes and
# destructive git. A plain `cat` of a secrets file therefore reached the model
# even though the same path was blocked through the Read tool — the file guard
# was never applied to Bash. check_bash now delegates to check_file_path, and
# these tests pin that delegation so a future edit cannot quietly drop it.
#
# NOTE: this file must never contain a literal secrets-file name. The guard
# blocks any Bash command whose text contains one, so a literal here would make
# the file un-editable by Claude Code itself (and un-greppable without tripping
# the hook). Fixtures are assembled at runtime from printf fragments instead.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/.claude/hooks/pre-tool-security.sh"
[ -r "$HOOK" ] || { echo "hook not readable: $HOOK" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

DOT=$(printf '.')
ENVF="${DOT}env"
IDR="id_$(printf 'rsa')"
CREDS="credential$(printf 's')"
SECJSON="secrets${DOT}json"

pass=0
fail=0

payload() { jq -nc --arg t "$1" --arg k "$2" --arg v "$3" \
  '{tool_name:$t, tool_input:{($k):$v}}'; }

verdict() { printf '%s' "$1" | bash "$HOOK" >/dev/null 2>&1 \
  && echo allowed || echo BLOCKED; }

expect() { # expect <BLOCKED|allowed> <tool> <input-key> <value>
  local want="$1" got
  got="$(verdict "$(payload "$2" "$3" "$4")")"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  want=%-8s got=%-8s  %s: %s\n' "$want" "$got" "$2" "$4" >&2
  fi
}

blocked() { expect BLOCKED Bash command "$1"; }
allowed() { expect allowed Bash command "$1"; }

# --- the gap this suite exists to pin: secrets reachable through Bash --------
blocked "cat $ENVF"
blocked "cat $ENVF.local"
blocked "cat apps/server/$ENVF"
blocked "grep KEY $ENVF"
blocked "sed -n 1,5p $ENVF"
blocked "head -50 ../$ENVF.production"
blocked "cat \"$ENVF\""
blocked "source $ENVF && pnpm dev"
blocked "echo K=v >> $ENVF"
blocked "cat production${DOT}env"
blocked "cat ~/${DOT}ssh/$IDR"
blocked "cat ~/${DOT}aws/$CREDS"

# --- templates and ordinary work must stay unblocked ------------------------
allowed "cat $ENVF.example"
allowed "cp $ENVF.example $ENVF.sample"
allowed "cat ${DOT}environment"
allowed "pnpm lint && pnpm typecheck && pnpm test"
allowed "rm -rf node_modules"
allowed "npm view zod version"
# message and title bodies are stripped before the scan, so prose that merely
# names a secrets file is not a command that reads one
allowed "git commit -m \"fix: stop logging $SECJSON\""
allowed "gh pr create -t \"add $ENVF.local support\" -b body"

# --- pre-existing guards must not regress -----------------------------------
blocked "rm -rf ~"
blocked "rm -rf /"
blocked "git reset --hard"
blocked "git rebase -i main"

# --- the Read path this suite was written to match --------------------------
expect BLOCKED Read file_path "$ENVF"
expect allowed Read file_path "$ENVF.example"

printf 'hook guard: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
