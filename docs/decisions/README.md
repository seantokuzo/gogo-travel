# Architecture Decision Records (ADRs)

Locked decisions for GoGo Travel. Each ADR is an immutable record of one decision —
the context, the choice, the alternatives, the trade-offs. This is the project's
long-term memory: six months from now, "why the hell did we do it this way?" is
answered here.

## Rules

- **File naming:** `ADR-NNN-<kebab-slug>.md`. `NNN` is a zero-padded sequential
  number, assigned at creation, **never reused**.
- **Append-only.** Never edit a merged ADR except to update its `Status:` /
  `Superseded by:` header. To change a locked decision, write a new ADR that
  supersedes the old one (old gets `Status: Superseded by ADR-MMM`; new gets
  `Supersedes: ADR-YYY`).
- **When to write one:** the decision is locked, it crosses more than one phase (or
  outlives the phase that produced it), and future-you would ask "why?". A spike
  (`S-N`) concluding with a directional choice is the typical trigger.
- **When NOT to:** in-flux thinking (keep it in [`STATE.md`](../STATE.md) until it
  locks), phase-local implementation choices (PLANNING.md phase detail), reversible
  config tweaks. When unsure, lean toward NOT writing one — premature ADRs are noise.
- **How:** copy `ADR-template.md` → next number, fill every section (Alternatives
  must list ≥2 rejected options), land it with the work, update the index below.

## Index

| ID | Title | Status |
|----|-------|--------|
| [ADR-001](ADR-001-naming-convention.md) | Stable IDs (P/T/B/S) + canonical plan-doc homes | Accepted |
| [ADR-002](ADR-002-status-enum-lock.md) | Status enum lock (`queued/in-progress/blocked/done/deferred/cancelled`) | Accepted |
| [ADR-003](ADR-003-local-in-session-reviews.md) | PR reviews run local in-session on Max, not in CI | Accepted |
| [ADR-004](ADR-004-stack-expo-rn-hono-drizzle.md) | Expo/RN + Hono + Drizzle/Postgres monorepo, iOS-first | Accepted |
| [ADR-005](ADR-005-free-v1-entitlement-seams.md) | Free v1 + entitlement seams; offline/collab/splitting free forever | Accepted |

## See also

- `ADR-template.md` — copy when starting a new ADR
- [`../history/README.md`](../history/README.md) — completed-phase archives (parallel append-only convention)
- [`../PLANNING.md`](../PLANNING.md) — roadmap; Decisions Log links here
- [`../STATE.md`](../STATE.md) — in-flux decisions live here until they lock
