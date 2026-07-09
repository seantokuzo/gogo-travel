# ADR-002: Status Enum Lock (Phases, Tasks, Bugs, Spikes)

**Status:** Accepted
**Date:** 2026-05-15
**Supersedes:** none (clarifies the status-value list in [ADR-001](./ADR-001-naming-convention.md) § "Execution order is derived")
**Superseded by:** none

## Context

[ADR-001](./ADR-001-naming-convention.md) locked the stable-ID convention and the 6-home plan-doc layout. It also declared that execution order is **derived** from three fields: `status + priority + depends_on`. But ADR-001's listing of status values — `open / in-progress / blocked / done / cancelled` — turned out not to match what the other surfaces actually use:

| Surface | Status values shipped |
|---------|----------------------|
| `docs/decisions/ADR-001-naming-convention.md` § "Execution order is derived" | `open / in-progress / blocked / done / cancelled` |
| `docs/PLANNING.md` § "Phase Roadmap" legend | `backlog · active · done · deferred` |
| `.agents/skills/roadmap-management/SKILL.md` (status comment + examples) | `in-progress / queued / done` |

Three surfaces, three different sets. Any tooling that greps for `status: done` works everywhere — every set has `done` — but tooling that greps for `status: queued`, `status: deferred`, or `status: blocked` returns inconsistent results depending on which doc the project followed. A consumer cloning the template doesn't know which list is canonical.

The autonomous-loop `state.json` uses fields named `active_phase` / `active_task` — these are item-identifier references, NOT status values; they are out of scope for this ADR.

The template audit (`.agents/skills/template-audit/last-report.md`, Theme A) flagged this as a high-leverage cleanup. T-4.4 promotes the audit's recommendation into a locked decision.

## Decision

We will adopt a **single canonical status enum** for all plan items (Phase / Task / Bug / Spike), defined here:

```
queued | in-progress | blocked | done | deferred | cancelled
```

Semantics:

| Status | Means | Typical transition out |
|--------|-------|------------------------|
| `queued` | Not started. Dependencies may or may not be met (tracked separately in `depends_on`). | `in-progress` (start work) or `cancelled` (won't ship) |
| `in-progress` | Active work in flight. A branch / PR exists or is imminent. | `done` (merged) or `blocked` (external blocker hit) |
| `blocked` | External blocker — not just an unmet `depends_on`. Examples: waiting on customer decision, third-party API change, infra access. | `in-progress` (blocker cleared) or `cancelled` |
| `done` | Merged and verified. Terminal. | none |
| `deferred` | Valid work, intentionally pushed to a later phase. Keeps its stable ID; not auto-requeued. | `queued` (re-pulled in a later phase) |
| `cancelled` | Abandoned; will not ship. Terminal. Stable ID stays burned (never reused). | none |

`backlog` (from the prior PLANNING.md set) and `open` (from the prior ADR-001 set) both collapse into `queued`. Distinguishing them produced no value — both meant "not started" and the actual dependency information lives in `depends_on`.

`active` (from prior PLANNING.md) collapses into `in-progress`.

### Migration mapping

| Prior value | New canonical value |
|-------------|---------------------|
| `open` (ADR-001) | `queued` |
| `backlog` (PLANNING.md) | `queued` |
| `queued` (roadmap-management) | `queued` |
| `in-progress` (ADR-001, roadmap-management) | `in-progress` |
| `active` (PLANNING.md) | `in-progress` |
| `blocked` (ADR-001) | `blocked` |
| `done` (all surfaces) | `done` |
| `deferred` (PLANNING.md) | `deferred` |
| `cancelled` (ADR-001) | `cancelled` |

### Surfaces updated in the T-4.4 PR that lands this ADR

- `docs/PLANNING.md` § "Phase Roadmap" legend — status-enum line updated to the union, with a link to this ADR.
- `.agents/skills/roadmap-management/SKILL.md` — format comment line + example task rows updated to use the union, with a link to this ADR.

ADR-001 is **not** edited. ADRs are append-only by spec (see `.claude/rules/planning-doc-homes.md`). ADR-001's original status list remains intact — this ADR-002 is the canonical source going forward; readers who encounter ADR-001's prior list should follow the link to ADR-002 for the current values.

### Scope: enum values only

This ADR does NOT change:

- The field name (`status` stays `status`)
- Where the field is stored (each plan-doc owns its own rows; no global registry)
- How execution order is derived (`status + priority + depends_on` per ADR-001)
- The 6-home rule
- Stable-ID rules

This ADR only freezes the **set of legal values** for `status`.

## Alternatives considered

### A. Pick one of the existing sets verbatim

Use ADR-001's set, or PLANNING's set, or roadmap-management's set — declare one canonical and update the others to match.

**Rejected because** none of the three was clearly better. ADR-001's `open` is technically clearer than `queued` for "not started", but `queued` better conveys "in line for execution". ADR-001 lacks `deferred`, which PLANNING uses meaningfully for "pushed to later phase". roadmap-management's set is the smallest but lacks `blocked` and `deferred`. The union covers every meaningful state without redundancy. Forcing one of the three existing sets would either lose meaning (drop `deferred`) or keep redundancy (`open` and `queued` both meaning "not started").

### B. Add a 7th state: `in-review`

Some teams distinguish "PR open, awaiting review" from "actively coding". This would add `in-review` between `in-progress` and `done`.

**Rejected because** the PR review pipeline is its own surface. PR state (`open`, `draft`, `ready_for_review`, `merged`) is readable directly via `gh pr view`. Re-encoding it in the plan-doc `status` field creates two sources of truth (the plan doc vs `gh`) that can drift. Within the plan doc, a task's `status` should mean "where is the WORK", not "where is the PR" — and the answer to "where is the work" while the PR is open is `in-progress`.

If a project later finds it needs to distinguish PR-pending from active coding, a follow-up ADR can split `in-progress` into `coding` and `in-review`. The current union is the floor, not the ceiling.

### C. Keep three sets, document the equivalences

Leave each surface using its own values and add an equivalence table that maps them to a canonical set.

**Rejected because** equivalence tables are a memory tax that compounds with every contributor and every fresh session. Claude reading PLANNING.md would see `active` and have to remember "that means `in-progress` in ADR-001 terms and `in-progress` in roadmap-management terms" — every grep, every report, every cross-reference becomes a translation. Direct unification removes the translation entirely.

## Consequences

### Positive

- **Deterministic grep across all surfaces.** `rg "status: done"` works everywhere; `rg "status: deferred"` returns the expected results regardless of which doc you grep.
- **Single mental model.** Contributors and Claude sessions learn one enum, not three.
- **Consumer-friendly.** A fresh consumer cloning the template sees one status set in every doc — no "which is canonical?" question.
- **Foundation for tooling.** Future scripts (a status-summary CLI, a phase-progress report) can hard-code the enum without branching per surface.

### Negative

- **One-time migration of two mutable surfaces.** PLANNING.md and roadmap-management SKILL are updated to the union with a link to this ADR. ADR-001 is left intact (ADRs are append-only) — readers who hit ADR-001's prior status list should follow the link from there to ADR-002 for the canonical set.
- **`backlog` distinction lost.** Some readers may miss the "backlog" semantic (vs "queued"). The argument that they're meaningfully distinct didn't survive review — `depends_on` already tells you whether work is pullable.

### Neutral

- **The enum is closed.** Adding a 7th state requires a new ADR. Mild friction is the price for stability — loose enums drift; locked enums stay aligned.
- **`active_phase` / `active_task` in `state.json` are not part of this enum.** Those fields hold item identifiers (e.g. `"P-3"`, `"T-3.2"`), not statuses. They remain unchanged.

## Links

- [ADR-001 — Planning Convention](./ADR-001-naming-convention.md) — sets the field shape; this ADR locks the value list.
- [Template audit Theme A](../../.agents/skills/template-audit/last-report.md) — the audit finding that motivated this lock.
