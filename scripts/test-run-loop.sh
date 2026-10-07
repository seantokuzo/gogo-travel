#!/usr/bin/env bash
# test-run-loop.sh — regression tests for scripts/run-loop.sh.
#
# Why this exists: three review rounds each found new defects in the chain
# wrapper, and every one was proven with a throwaway harness that shipped with
# nothing. The headline defect was two wrappers sharing one .loop/, running
# 23 sessions against a max_chain of 3, concurrently, in one worktree.
#
# NEVER exercises the real `claude` CLI — a stub on PATH stands in, driven by a
# scripted action queue. `sleep` is stubbed to collapse the inter-iteration
# wait. Everything runs in a temp dir; the real repo is never touched.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/run-loop.sh"
[ -r "$SRC" ] || { echo "cannot read $SRC" >&2; exit 1; }

pass=0; fail=0
ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); printf 'FAIL  %s\n       %s\n' "$1" "$2" >&2; }
check(){ # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok; else bad "$1" "want=[$2] got=[$3]"; fi
}

SB=""
sandbox() {            # fresh project with stubbed claude + sleep
  SB="$(mktemp -d)"
  mkdir -p "$SB/bin" "$SB/repo/scripts" "$SB/repo/.claude/hooks"
  cp "$SRC" "$SB/repo/scripts/run-loop.sh"
  printf '#!/bin/bash\nexit 0\n' > "$SB/repo/.claude/hooks/autonomous-handoff.sh"
  chmod +x "$SB/repo/.claude/hooks/autonomous-handoff.sh"
  printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"autonomous-handoff.sh"}]}]}}\n' \
    > "$SB/repo/.claude/settings.json"
  # stub claude: --help advertises both flags; -p pops one action off actions.txt
  cat > "$SB/bin/claude" <<'STUB'
#!/bin/bash
if [ "${1:-}" = "--help" ]; then
  echo '  --permission-mode <mode>  (choices: "acceptEdits", "auto", "plan")'
  echo '  --permission-prompts <target>'
  exit 0
fi
if [ "${1:-}" = "--version" ]; then echo "9.9.9 (stub)"; exit 0; fi
Q="$CLAUDE_STUB_ACTIONS"
act="$(head -n1 "$Q" 2>/dev/null || echo done)"
sed -i.bak '1d' "$Q" 2>/dev/null; rm -f "$Q.bak"
case "$act" in
  pivot:*)   printf '%s\n' "${act#pivot:}"   > .loop/pivot ;;
  blocked:*) printf '%s\n' "${act#blocked:}" > .loop/blocked ;;
  next:*)    printf '%s\n' "${act#next:}"    > .loop/next-prompt.md ;;
  slow:*)    printf '%s\n' "${act#slow:}" > .loop/pivot; /bin/sleep 3 ;;
  *)         : > .loop/done ;;
esac
exit 0
STUB
  chmod +x "$SB/bin/claude"
  printf '#!/bin/bash\nexit 0\n' > "$SB/bin/sleep"; chmod +x "$SB/bin/sleep"
  : > "$SB/actions.txt"
}
acts() { printf '%s\n' "$@" > "$SB/actions.txt"; }
rl()   { ( cd "$SB/repo" && PATH="$SB/bin:$PATH" CLAUDE_STUB_ACTIONS="$SB/actions.txt" \
           bash scripts/run-loop.sh "$@" >"$SB/out" 2>&1; echo $? ); }
state(){ grep -oE "\"$1\"[[:space:]]*:[[:space:]]*[0-9]+" "$SB/repo/.loop/state.json" 2>/dev/null \
           | head -n1 | grep -oE '[0-9]+$'; }
cleanup(){ [ -n "$SB" ] && rm -rf "$SB"; }

# --- D2: a live wrapper must block resume, and status must say so ----------
sandbox
acts "pivot:PIVOT BODY"
rl start --prompt "go" >/dev/null
# simulate a wrapper still alive: a real long-lived process named run-loop.sh
cp "$SRC" "$SB/bin/run-loop.sh"
( exec -a "bash $SB/bin/run-loop.sh" /bin/sleep 30 ) & live=$!
printf '%s\n' "$live" > "$SB/repo/.loop/wrapper.pid"
rc="$(rl resume --prompt "answer")"
check "D2 resume refuses while a wrapper is alive" "1" "$rc"
check "D2 pivot survives the refusal" "yes" "$([ -f "$SB/repo/.loop/pivot" ] && echo yes || echo no)"
check "D2 nothing archived" "no" "$([ -d "$SB/repo/.loop/archive" ] && echo yes || echo no)"
rl status >/dev/null; grep -q 'still alive' "$SB/out" && ok || bad "D2 status flags live wrapper" "$(head -3 "$SB/out")"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
cleanup

# --- D4 (pid recycling): a live NON-wrapper pid counts as dead -------------
sandbox
acts "pivot:P"
rl start --prompt "go" >/dev/null
/bin/sleep 30 & other=$!
printf '%s\n' "$other" > "$SB/repo/.loop/wrapper.pid"
rl status >/dev/null
grep -q 'still alive' "$SB/out" && bad "recycled pid must not read as a wrapper" "$(head -3 "$SB/out")" || ok
kill "$other" 2>/dev/null; wait "$other" 2>/dev/null
cleanup

# --- D1: every abort path must leave the sentinel resumable ---------------
for case_ in empty-prompt budget malformed non-object zero-byte; do
  sandbox
  acts "pivot:KEEP ME"
  rl start --prompt "go" >/dev/null
  rm -f "$SB/repo/.loop/wrapper.pid"
  case "$case_" in
    budget)     python3 - "$SB/repo/.loop/state.json" <<'P2'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["session_count"]=d["max_chain"]; json.dump(d,open(p,"w"))
P2
                rc="$(rl resume --prompt "a")" ;;
    malformed)  echo '{not json' > "$SB/repo/.loop/state.json"; rc="$(rl resume --prompt "a")" ;;
    non-object) echo '42'        > "$SB/repo/.loop/state.json"; rc="$(rl resume --prompt "a")" ;;
    zero-byte)  : >              "$SB/repo/.loop/state.json"; rc="$(rl resume --prompt "a")" ;;
    *)          rc="$(rl resume --prompt "   ")" ;;
  esac
  [ "$rc" != "0" ] && ok || bad "D1/$case_ should refuse" "rc=$rc"
  check "D1/$case_ sentinel survives"  "yes" "$([ -f "$SB/repo/.loop/pivot" ] && echo yes || echo no)"
  check "D1/$case_ nothing archived"   "no"  "$([ -d "$SB/repo/.loop/archive" ] && echo yes || echo no)"
  cleanup
done

# --- D3: compact single-line state.json must not cross-read fields --------
sandbox
mkdir -p "$SB/repo/.loop"
printf '{"session_count":3,"started_at":"x","last_update":"y","max_chain":20,"junk":54321}\n' \
  > "$SB/repo/.loop/state.json"
check "D3 session_count read correctly from one line" "3"  "$(state session_count)"
check "D3 max_chain read correctly from one line"     "20" "$(state max_chain)"
cleanup

# --- D4: resume must archive EVERY resumable sentinel ---------------------
sandbox
# NOTE: must NOT end on `done` — a clean finish deletes .loop/ and takes
# archive/ with it, so the assertion below would read 0 for the wrong reason.
acts "pivot:FIRST" "pivot:SECOND"
rl start --prompt "go" >/dev/null
rm -f "$SB/repo/.loop/wrapper.pid"
printf 'STALE BLOCKER\n' > "$SB/repo/.loop/blocked"
rc="$(rl resume --prompt "answer")"
check "D4 resume survives the stale sentinel instead of dying on it" "0" "$rc"
check "D4 both sentinels archived" "2" "$(ls "$SB"/repo/.loop/archive 2>/dev/null | wc -l | tr -d ' ')"
cleanup

# --- regressions ----------------------------------------------------------
sandbox; acts "done"; check "status OFF with no state" "0" "$(rl status)"
grep -q 'Autonomous mode: OFF' "$SB/out" && ok || bad "status prints OFF" "$(head -2 "$SB/out")"
cleanup
sandbox; acts "done"; check "clean start exits 0" "0" "$(rl start --prompt go)"
check "clean done removes .loop" "no" "$([ -d "$SB/repo/.loop" ] && echo yes || echo no)"
cleanup
sandbox
acts $(for i in $(seq 1 30); do echo "next:more"; done)
rc="$(rl start --prompt go)"
check "max_chain cap exits 2" "2" "$rc"
check "max_chain stops at 20" "20" "$(state session_count)"
cleanup

# --- skill paths: run-loop.sh may only name skill files that exist ----------
# Skills moved out of the old dot-agents dir into .claude/skills/ (2026-10). A
# stale path in DEFAULT_PROMPT sends every chained session to a missing file.
# Reads the REAL script and the REAL tree, not a sandbox. Guards:
#  - exactly one column-0 "DEFAULT_PROMPT=" line exists (a plain textual count: an
#    export/readonly/declare line, an indented reassignment inside a function, or a
#    "; DEFAULT_PROMPT=" on the same line is NOT counted, so none of those is caught);
#  - that line opens "Read <path>" where <path> (up to the first space or comma) is
#    exactly .claude/skills/autonomous-loop/SKILL.md, the skill run-loop exists to
#    load, so a real-but-wrong skill fails; and that file exists;
#  - the prompt bash actually runs (the last effective assignment) is checked
#    behaviourally by QS-T8 (PR-C), via the stub's prompt log, not here;
#  - every skill .md path run-loop.sh names is well-formed and exists;
#  - no .agents path.
# Not guarded: the rest of the prompt text (the amendment-1 STATE/QUEUE wording).
dp_n="$(grep -c '^DEFAULT_PROMPT=' "$SRC" || true)"
dp="$(sed -n "s/^DEFAULT_PROMPT='Read \([^ ,]*\)[ ,].*/\1/p" "$SRC")"
dp_ok="$([ -n "$dp" ] && [ -f "$ROOT/$dp" ] && echo yes || echo no)"
check "DEFAULT_PROMPT is assigned once, opens with the autonomous-loop skill path, and it exists" \
  "1 .claude/skills/autonomous-loop/SKILL.md yes" "$dp_n $dp $dp_ok"
# A bare "SKILL.md" is prose shorthand in comments ("SKILL.md section 5"), not a path.
refs="$(grep -oE '[A-Za-z0-9_./-]*[Ss][Kk][Ii][Ll][Ll][A-Za-z0-9_./-]*\.[Mm][Dd]' "$SRC" | grep -vx 'SKILL\.md' | sort -u)"
missing=""; for p in $refs; do printf '%s' "$p" | grep -qxE '\.claude/skills/[A-Za-z0-9_-]+/SKILL\.md' && [ -f "$ROOT/$p" ] || missing="$missing $p"; done
check "every skill .md path run-loop.sh names is well-formed and exists" "" "$missing"
check "run-loop.sh has no dot-agents path" "0" "$(grep -c '[.]agents/' "$SRC" || true)"

printf 'run-loop guard: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
