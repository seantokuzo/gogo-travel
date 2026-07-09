---
description: Begin a work phase — pull the next ready task(s) from the queue and dispatch the right engineer(s).
argument-hint: [task or phase id]
---

# /sprint-start — start a work phase

"Sprint" here = a **work phase from `docs/PLANNING.md`** (`P-N`). No Jira, no board, no transitions. You are the **orchestrator** — thin coordinator, fat workers.

## Do this

1. **Read** in order: `docs/STATE.md` (⚠️ CURRENT DIRECTION) → `docs/QUEUE.md` → the relevant `docs/PLANNING.md` phase slice. (CLAUDE.md is already loaded.)
2. **Pick the next ready task(s).** Order is **derived**, not ID order: highest-priority `todo` whose `depends_on` are all `done`. If `$ARGUMENTS` names a task/phase, start there instead.
3. **Become the orchestrator** — `.agents/agents/orchestrator.md`. Decompose, group independent tasks into a wave, spawn them in parallel.
4. **Route** per the orchestrator table: `backend-engineer` / `web-engineer` / `mobile-engineer` / `researcher`. Pass **paths, not contents**. A spike (`S-N`) → researcher, output an ADR.
5. **Per task:** `.claude/rules/` auto-load on read — honor them. Context7 for every library API. One atomic commit. CI gate green locally (`CLAUDE.md § Quality Gates`) before a task counts as done.
6. **Verify each wave** before the next (orchestrator's hard gate). Beware false green — sibling repos have shipped "passing" code that was broken in prod.
7. **PR-ready** → push, `gh pr create`, then run **`/review`**. Flip the `QUEUE.md` row as work lands.

Pull the queue and go — interrupt-driven, not approval-driven.
