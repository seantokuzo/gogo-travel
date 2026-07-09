# GoGo Travel — Session Guide

> How a session works. Sean is the architect/planner/QA; Claude is the
> engineering team. Planning is file-based (no Jira/Confluence); reviews run
> in-session on Max ([ADR-003](decisions/ADR-003-local-in-session-reviews.md)).

---

## Docs topology

| Doc | What | Read when |
|-----|------|-----------|
| [`STATE.md`](STATE.md) | Current truth + `CURRENT DIRECTION` (auto-injected, ~1 page) | every session start |
| [`QUEUE.md`](QUEUE.md) | Work queue — IDs, status, deps | every session start |
| [`PLANNING.md`](PLANNING.md) | Roadmap + phase narrative + open questions | planning a phase |
| [`SECURITY.md`](SECURITY.md) | Security findings + fix order | security work |
| [`decisions/`](decisions/) | ADRs — locked, append-only | "why did we do X?" |
| [`history/`](history/) | Completed-phase archives, append-only | post-mortems |
| `.specs/` | Feature/impl specs — build contracts | before building the thing |
| `CLAUDE.md` | Lean constitution: laws, autonomy contract, loop | always (auto) |

One canonical home per concept. Cross-reference, never duplicate.

---

## Session-start ritual (every session, in order)

1. Confirm cwd + `git log --oneline -5` + `git status`.
2. Read `docs/STATE.md` (auto-injected) + `docs/QUEUE.md`.
3. Pull the highest-priority `queued` item whose `depends_on` are all `done`.
4. Work **one task at a time**; atomic commit per task; leave the repo clean.
5. Before ending: update QUEUE row, update STATE if direction shifted, write
   the handoff.

## Kickoff prompts

**Continue (the usual):**
```
Read CLAUDE.md, docs/STATE.md, docs/QUEUE.md. We're in P-N.
Pull the top of the queue and keep going.
```

**Plan a phase:**
```
Read CLAUDE.md, docs/PLANNING.md, docs/QUEUE.md. Plan P-N — decompose into
tasks, queue them, surface decisions. Wait for buy-in before building.
```

**A spike:**
```
Run S-N — research, present options + a recommendation, output an ADR.
```

---

## The in-session review flow

1. Claude opens the PR (full description, labels, test notes).
2. Spawns 5 reviewer subagents in parallel — **correctness · security · tests ·
   performance · conventions** (charters in `.agents/agents/reviewer.md`).
3. Verdicts aggregate deterministically (`.github/scripts/aggregate-verdict.mjs`),
   sticky posted to the PR.
4. Every finding categorized `fix-now` / `respond` / `defer`; fixes applied;
   inline replies with fix SHA.
5. **Impartial judge** (fresh subagent, no review history) decides
   `merge` / `re-review` / `human-decides`. Hard cap 4 rounds.
6. CI gate green before merge (command pinned in CLAUDE.md after ADR-004).
7. Merge `--merge`, delete branch, post-merge handoff.

`/review` runs the pipeline; `/address-comments` runs the fix loop;
`/code-review` (built-in) is available as a complement.

---

## Autonomy + escalation (summary — canonical in CLAUDE.md)

Default is **autonomous**: build, test, review, judge, merge without asking.
Claude stops for the enumerated escalation triggers only (spec ambiguity,
architecture divergence, new external services/spend, security-model changes,
irreversible ops, scope changes, judge `human-decides`). Questions come batched
via structured options with a recommendation, and never block an active wave —
parkable questions get parked in QUEUE/STATE with a `blocked` row.

---

## Handoff between sessions

A good handoff is "a note to a competent stranger":

- **Just did** — what landed (PR #, SHA).
- **Next** — exact next task ID + first step.
- **Context** — gotchas, decisions made, **failed approaches**, anything not
  yet in the docs.
- **Re-read** — which docs/files to load first.

## Context discipline

| Metric | Target | Split signal |
|--------|--------|--------------|
| Files per task | 5–8 | 15+ → spawn a subagent |
| Tasks per session | 2–3 | 5+ → parallelize / fresh session |
| Context feel | light | heavy → finish task, hand off, fresh session |

Thin orchestrator: pass **paths** to subagents, not contents. Context-exhaustion
signals (forgetting decisions, repeating searches, quality dropping) → finish the
current task, write the handoff, suggest a fresh session.

## Post-merge

1. `git checkout main && git pull`.
2. Flip the QUEUE row to `done` (+ PR #); unblock dependents.
3. Phase closed → archive notes to `docs/history/PHASE-NNN-<slug>.md`, flip the
   PLANNING row, trim STATE.
4. Decision locked → new ADR + PLANNING Decisions Log row; remove from STATE.
5. Offer a QA checklist if the merged work is user-testable.
6. Announce the next move (next planned phase starts autonomously) or surface
   options if there's no plan.

## Autonomous chain mode ("spec and walk away")

`bash scripts/run-loop.sh start` — chains fresh `claude -p` sessions gated by
`.loop/` sentinels (`done` / `pivot` / `blocked` / `next-prompt.md`). Discipline
doc: `.agents/skills/autonomous-loop/SKILL.md`. The Stop hook enforces sentinel
hygiene. Use for well-specced phase execution; don't use for planning/spikes.
