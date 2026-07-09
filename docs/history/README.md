# Phase History Archive

Completed-phase records — durable, append-only. When a phase (`P-N`) merges and
closes, its working notes don't belong in `STATE.md` (stays lean) or `PLANNING.md`
(stays forward-looking). They land here: outcomes, task list, locked decisions,
patterns worth repeating, surprises worth remembering, surviving follow-ups.

## Rules

- **File naming:** `PHASE-NNN-<kebab-slug>.md`, where `NNN` matches the phase's
  stable `P-N` ID (phase `P-1` → `PHASE-001-<slug>.md`). One file per phase.
- **Append-only / immutable.** Once archived, don't rewrite history. Corrections go
  in a new doc; a lesson that locks becomes a new ADR; a current/in-flux fact goes
  in STATE.md. The only permitted edit is fixing a broken link or a factual error
  that misrepresents what happened.
- **When to archive:** at phase close, as part of the post-merge handoff — create
  the file from `PHASE-template.md`, promote detailed notes out of STATE.md, flip
  the PLANNING.md row to `done` with a link here.
- **Not auto-loaded.** Archives are reference material; load them explicitly (a new
  phase that resembles an old one, an ADR codifying a lesson, a retrospective).

## Index

| ID | Title | Status |
|----|-------|--------|
| _(no phases closed yet)_ | | |

## See also

- `PHASE-template.md` — copy when archiving a phase
- [`../decisions/README.md`](../decisions/README.md) — ADRs (parallel append-only convention)
- [`../PLANNING.md`](../PLANNING.md) — phase index; links to these archives
