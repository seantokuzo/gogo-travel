# PHASE-002 — Research + upfront spec suite (CLOSED 2026-07-10)

**Status:** Done
**Closed:** 2026-07-10
**PRs:** none — a spec/planning phase; deliverables landed as direct commits.

> **Written 2026-09-13, retroactively.** This phase closed 2026-07-10 but was
> never archived; its record lived only in `docs/STATE.md § P-2`. Created during
> a STATE rotation so the section could be reduced to a pointer without deleting
> the only copy. Append-only from here — corrections go in a later doc, per
> `docs/history/README.md`.

## Outcome

All three Sean approval gates passed (feature set → architecture/data model →
phase plan), which is what switched the project to autonomous-by-default. The
deliverable was specs complete enough to build against with minimal ambiguity:
**18 spec files, roughly 280 EARS requirements, zero `[NEEDS CLARIFICATION]`
markers left**. (`.specs/` has grown since — `.specs/testing/` and later
additions post-date this phase.)

Also produced: `feature-ledger.json`, the machine-checkable verification ledger
(118 features, F-001..F-118, each with verification steps and `passes: false`
until verified — Law #8, append-only), and the frozen phase roadmap P-3..P-14
that still drives `docs/PLANNING.md` § Phase Detail.

## Notable resolver calls (product rulings that specs now depend on)

- Editors may edit and delete only their OWN expenses.
- Sole-owner account deletion returns 409 — transfer ownership first. (Shipped
  in P-5's `DELETE /users/me`; see PHASE-005.)

## Port sources, for archaeology

The conventions in this repo were ported from Sean's sibling repos. When a rule
here looks arbitrary, the original is usually one of these:

- `../the-bach` — the in-session review pipeline (its ADR-002 is our ADR-003),
  plus the commands and hooks.
- `../get-sean-done` — the canonical GSD template: the doc system, the
  autonomous loop, the naming ADRs.
- `../bartling-bachelor` — product exemplar: mobile PWA, design system,
  itinerary UX.
- `../roi-gen` — STATE discipline.
- `../seantokuzo-mcp` — rules and hooks patterns.

## Linked context

- Roadmap rows: `docs/PLANNING.md` (phase table + § P-2 detail).
- Spikes: S-1 (stack → ADR-004), S-2 (product research → `.specs/research/`).
- `docs/STATE.md § P-2` rotated here 2026-09-13.
