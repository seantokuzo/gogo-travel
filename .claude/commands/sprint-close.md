---
description: Close a work phase — update STATE, mark QUEUE done, archive to history, write the handoff.
---

# /sprint-close — close a phase

A phase (`P-N`) closes when **all its tasks are `done`**. File-based — no Confluence, no velocity vanity, no story points. Truth over narrative: sibling repos have shipped fictional "sprint complete" stories — don't generate one here.

## Do this

1. **Sync:** `git checkout main && git pull`.
2. **QUEUE** (`docs/QUEUE.md`): flip each finished row to `done` (+ PR #); unblock its dependents.
3. **STATE** (`docs/STATE.md`): rewrite the real status — only what actually works, verified. Trim if it grew past ~1 page.
4. **Archive:** append `docs/history/PHASE-NNN-<slug>.md` from `PHASE-template.md`; flip the `docs/PLANNING.md` phase row to `done` with a link.
5. **Locked a decision?** Write an ADR (`docs/decisions/`, append-only), drop the in-flight note from STATE, add a row to PLANNING's Decisions Log.
6. **Handoff:** run **`/handoff`** — note to a competent stranger.

Follow `docs/SESSION-GUIDE.md` "Post-merge". Then **report**: phase closed, what landed, what's next (announce the next phase, or surface options if there's no plan). Offer a QA checklist if the work is user-testable.
