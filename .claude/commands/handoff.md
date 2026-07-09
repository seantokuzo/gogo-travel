---
description: Write a session handoff — update STATE and a next-prompt "note to a competent stranger".
---

# /handoff — hand off the session

End every session clean so a cold context picks up without you. The Stop hook (`.claude/hooks/autonomous-handoff.sh`) enforces this when autonomous mode is on (`.loop/state.json` present) — but write the note by hand regardless.

## First, settle the work

Commit/push current work · flip the `docs/QUEUE.md` row · update `docs/STATE.md` if direction shifted.

## Update STATE

`docs/STATE.md` = the truthful current status. Real and verified, not aspirational — no fiction.

## Write the note (message to a competent stranger)

`.loop/next-prompt.md`-style, these sections:

- **JUST DID** — what landed (PR #, SHA).
- **NEXT** — the exact next task ID + first concrete step.
- **CONTEXT** — gotchas, decisions made, anything not yet in the docs.
- **RE-READ** — which docs/files to load first.
- **IF YOU FIND X → pivot** — the known fork/landmine and what to do about it.

## Where it goes

- **Autonomous** (`.loop/` present): write `.loop/next-prompt.md` (non-empty = the chain continues), or exactly one terminal sentinel (`done`/`pivot`/`blocked`). Canonical spec: `.agents/skills/autonomous-loop/SKILL.md` when present.
- **Interactive:** post the note in chat and leave STATE updated.

See `docs/SESSION-GUIDE.md` "Handoff between sessions".
