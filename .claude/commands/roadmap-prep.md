---
description: Plan the next phase — update PLANNING + QUEUE, optionally write specs. File-based, no tickets.
argument-hint: [phase or feature]
---

# /roadmap-prep — plan the next phase

Output is **files**: `docs/PLANNING.md` + `docs/QUEUE.md` (+ optional `.specs/`). No Jira, no Confluence. You plan here — you don't start building.

## Do this

1. **Read** `docs/STATE.md` (⚠️ CURRENT DIRECTION) → `docs/PLANNING.md` (roadmap + Open product questions) → `docs/QUEUE.md`.
2. **Method:** work file-first — PLANNING is the roadmap, QUEUE is the actionable breakdown, `.specs/` is the build contract. No separate planning skill required.
3. **Pick the next phase or spike.** Ambiguous? Ask before decomposing.
4. **Unknowns / new tech / scope forks** → spawn `researcher` (`.agents/agents/researcher.md`): options + a recommendation. Get buy-in before specs.
5. **Decompose → queue.** Add a phase block to PLANNING and rows to QUEUE with **stable IDs** (next free `P-N`/`T-N`/`B-N`/`S-N` — never renumber), priority, `depends_on`, and a source ref. Honor `.claude/rules/planning-doc-homes.md`.
6. **Specs (optional):** for a feature that needs a build contract, write `.specs/<area>/<name>.spec.md`.
7. **Present 2–4 options** with trade-offs + a _(recommended)_; **wait for buy-in.** Don't auto-roll into `/sprint-start`.
