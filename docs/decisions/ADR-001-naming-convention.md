# ADR-001: Naming Convention (Phases, Tasks, Items, Plan Docs)

**Status:** Accepted
**Date:** 2026-05-04
**Supersedes:** none
**Superseded by:** none

## Context

Project planning across prior projects has consistently suffered from three compounding failures:

1. **Inconsistent phase naming.** Different projects (and sometimes different files in the same project) used "Phase A", "Phase 3", "Phase ✨", "Milestone 2.1", and bare titles like "the auth one". Cross-project references became impossible. Scripts couldn't grep deterministically. New contributors couldn't tell whether "Phase 2" was a phase, a sprint, or a sub-milestone.

2. **Insertion-driven renumbering pain.** When ordinal numbering was used ("Phase 1, Phase 2, Phase 3"), inserting a new phase between 2 and 3 forced either a rename cascade ("Phase 3 becomes Phase 4, Phase 4 becomes Phase 5...") or a hack ("Phase 2.5", then "Phase 2.5a"). The cascade broke branch names, PR titles, commit messages, and external references. The hack accumulated until the namespace was unreadable.

3. **Plan-doc proliferation.** Every project drifted toward random `docs/*.md` files — `ROADMAP.md`, `BACKLOG.md`, `IDEAS.md`, `TODO.md`, `NEXT-STEPS.md`, `THOUGHTS.md` — that conflicted with each other, fell out of sync, and made "where does this go?" a recurring question with different answers each week.

These failures interact: bad IDs make grep useless, which makes plan-doc sprawl harder to audit, which encourages more sprawl. A single locked convention solves all three.

This ADR is intentionally exhaustive. Other documents reference it as the source of truth for the naming convention, so it must be complete on its own.

## Decision

We will adopt a Jira-lite stable-ID convention with a strictly bounded set of plan-doc homes. The full spec follows.

### Hierarchy (2 levels)

- **Phase (`P-N`)** — a ship-able, user-observable capability. A phase is "done" when something a user (or the system itself) couldn't do before is now possible. Phases close with merged PRs and an archived history file.
- **Task (`T-N`)** — an atomic implementation unit, part of a phase. **A PR contains 1+ tasks** that share a coherent purpose (see PR sizing) — one-task-per-PR is the wrong default; it produces tiny PRs that burn auto-review tokens for marginal value. Tasks reference their parent phase explicitly.

**Wave is NOT a hierarchy level.** "Wave" is a runtime concept — a parallel-dispatch grouping of tasks the orchestrator runs concurrently. Waves are emergent, not stored. A task's wave changes with execution context; its task ID does not.

### Item types and ID prefixes

| Prefix | Type | Notes |
|--------|------|-------|
| `P-N` | Phase | Ship-able capability. Has a history file on completion. |
| `T-N` | Task | Atomic implementation. Belongs to a phase. Bundles with sibling tasks into a reviewable-unit PR (see PR sizing). |
| `B-N` | Bug | Gets its own PR regardless of size. Tracked separately so they don't get buried in phase backlogs. |
| `S-N` | Spike | Research / investigation. **No ship-able code, no PR.** Output is an ADR or a STATE update. |

Tasks within a phase use a dotted form for clarity in cross-references: `T-001.3` reads as "task 3 of phase 1". The dotted form is display sugar — the canonical task ID is still `T-N` and is unique across the whole project. Use whichever form is clearer in context; they refer to the same item.

### Stable IDs

- IDs are **assigned once at creation and never renumbered**.
- Insertion never shifts existing IDs. New work gets the next available number.
- Deletion / cancellation does not free the number for reuse — it stays burned, with `Status: Cancelled`.
- Display position is **derived** from `status + priority + depends_on` at render time, not stored on the item.

This is the key property: a phase's ID survives forever, so branches, commits, PR titles, ADR links, and external references stay valid no matter how the roadmap is reshuffled.

### Execution order is derived

The order in which work happens is **derived** from three fields, not from the ID:

1. **Status** — open / in-progress / blocked / done / cancelled
2. **Priority** — relative ordering within open work
3. **`depends_on`** — explicit dependency edges

The orchestrator computes a topological order at dispatch time. IDs do not encode order.

### PR sizing

Default target: **30–500 lines, 2–15 files** per PR.

Exceptions:

- **Bug (`B-N`)** — own PR regardless of size. A 5-line bug fix still ships alone so it can be reverted independently.
- **Spike (`S-N`)** — no PR. Output is an ADR (if a decision locked) or a STATE update (if directional but not yet locked).
- **Mass refactor** — one PR even if it crosses the line ceiling. Splitting a mechanical rename across PRs creates worse review surface, not better.
- **Phase-closing integration** — OK to be < 30 lines if it's the wiring that flips the phase from "tasks done" to "capability shipped".

Above the upper bound, split. Below the lower bound, consider whether it should fold into an adjacent task.

### Plan-doc homes (strict 6 places)

There are exactly six places where planning content lives. Anything outside this list is a smell:

| Path | Purpose | Mutability |
|------|---------|------------|
| `docs/PLANNING.md` | Current roadmap: phase list with stable IDs, links, summary status | Mutable, lean |
| `docs/QUEUE.md` | Active task queue: open / in-progress tasks with priority + depends_on | Mutable, churn-heavy |
| `docs/STATE.md` | In-flux decisions, current focus, open questions; loose advisory cap ~800–1000 lines | Mutable, archive when heavy |
| `docs/decisions/ADR-NNN-<slug>.md` | Locked decisions | **Append-only / immutable** |
| `docs/history/P-NNN-<slug>.md` | Completed phase archives | **Append-only / immutable** |
| `docs/SESSION-GUIDE.md` | How to run a working session in this repo | Mutable, low churn |

No other planning files. No `ROADMAP.md`, no `TODO.md`, no `NOTES.md`, no `IDEAS.md`. If a thought needs a home and none of these six fit, it doesn't have a home yet — drop it in STATE.md until it earns one.

### Rotation rules

Content moves between the six homes according to these rules:

- **Phase merged → archive notes to history.** When a phase's final PR merges, the post-merge handoff promotes detailed notes from STATE.md into a new `docs/history/P-NNN-<slug>.md`. PLANNING.md retains the phase row + a link to the history file.
- **Decision locks → promote to ADR.** When a directional choice in STATE.md becomes a committed decision, it graduates to a new `ADR-NNN-<slug>.md`. STATE.md keeps a one-line pointer.
- **STATE heavy → flag in post-merge handoff.** When STATE.md crosses the loose ~800–1000 line advisory cap, the post-merge handoff surfaces it as a cleanup candidate. Stale "in-flux" entries get either locked into an ADR, archived into a phase history, or deleted.

These rotations happen at natural seams (phase merge, decision lock, post-merge handoff) — not on a schedule. The goal is steady-state leanness in the mutable docs and durable detail in the immutable ones.

## Alternatives considered

### A. Ordinal numbering with renumber-on-insert

Use bare ordinals — Phase 1, 2, 3 — and shift everything down when inserting a phase between 2 and 3.

**Rejected because** it breaks branch names, PR titles, commit messages, and external references. Anywhere the old number was written down — Slack threads, design docs, customer-facing changelogs — becomes a lie. The rename cascade is also surprisingly expensive: every PR in flight needs a rebase + branch rename, every comment referencing "Phase 4" silently means something different. The hack avoidance ("Phase 2.5", "Phase 2.5a", "Phase 2.5a-prime") is what we're trying to escape, not a workaround we tolerate.

The trade-off ordinal numbering offers — "the number tells you the order" — is a false win because order changes constantly and the number is the most painful place to encode something that changes. Stable IDs + derived order is the correct factoring.

### B. Flat work-item namespace with type tags only

A single namespace for everything (`#1`, `#2`, `#3`...) with type tags as metadata (`type: phase`, `type: task`, `type: bug`).

**Rejected because** grep clarity matters more than namespace elegance. Searching for "P-014" deterministically finds the phase. Searching for "#14" finds 14 instances of "#14" across phases, tasks, bugs, spikes, and unrelated GitHub issue refs. The prefix is doing real work — it lets every script, regex, and human eye categorize at a glance.

The cost is small (4 prefixes to remember: `P-`, `T-`, `B-`, `S-`); the win is large (deterministic categorization in any text). This is the same reason language designers don't reuse `int` and `string` for variable names — disambiguation pays for itself.

### C. Loose plan-doc rules with a master index

Allow any `docs/*.md` planning file, but maintain a `docs/INDEX.md` that lists them all and explains what each one is for.

**Rejected because** indexes always lie. The index file gets stale within weeks of the policy being adopted: someone adds `THOUGHTS.md`, doesn't update INDEX.md, and now the index actively misleads. Worse, "loose rules + index" provides a permission slip for sprawl ("we have an index, so adding one more file is fine"). The strict 6-home rule is enforceable by a pre-commit hook and a path-scoped rule; "loose + index" is enforceable only by vigilance, which doesn't scale.

The trade-off this option offers — flexibility for project-specific needs — is mostly imaginary. After several projects, the same six homes recur. Codifying them up front saves the bikeshed every project starts over.

## Consequences

### Positive

- **Clean insertion.** New phases / tasks / bugs / spikes get the next number. Nothing else moves. Branch names, PR titles, commit messages, and external references survive any roadmap reshuffle.
- **Deterministic grep.** `rg "P-014"` finds the phase and only the phase. `rg "T-027"` finds the task and only the task. Tooling, scripts, and humans agree on what an ID means.
- **Less rot.** Six plan-doc homes, each with a clear rotation rule, prevents the slow sprawl that historically buried planning under noise. Mutable docs stay lean; immutable docs preserve detail.
- **Cross-project portability.** Other projects in the same family use the same convention, so context-switching between repos doesn't require re-learning a naming system.
- **Append-only ADRs are auditable.** "Why did we do it this way?" has a permanent answer that cannot be silently rewritten.

### Negative

- **Display position must be derived, not stored.** Tooling (PLANNING.md renderers, QUEUE.md sorters) must compute current order from `status + priority + depends_on` rather than reading it off the ID. This is slight tooling overhead — a sort function instead of a static list — but it must be consistently applied.
- **ID gaps look messy at a glance.** When P-007 is cancelled and P-008 is in progress, the gap between P-006 and P-008 is visible. Cosmetic only — but readers used to dense ordinals may find it odd at first.
- **Stricter than ad-hoc.** Contributors used to "just drop a `NOTES.md` in there" need to internalize the 6-home rule. Mild upfront friction.

### Neutral

- **Cultural discipline required around the 6 plan-doc homes.** A pre-commit hook can flag new top-level `docs/*.md` files outside the allowed set, and a path-scoped rule in `.claude/rules/` can warn when an agent tries to create one — but neither fully enforces. The convention works because the team agrees to it, not because the tooling is bulletproof.
- **The dotted task form (`T-001.3`) is sugar.** Some readers will prefer always using the canonical `T-N`; others will prefer the dotted form everywhere. Both are valid; pick what reads clearest in context.
- **Spikes don't ship code.** This is a feature, not a bug — it forces investigation work to produce a durable artifact (an ADR or a STATE update) rather than evaporating into chat history. But it does mean spike effort doesn't show up in PR metrics.

## Links

- [`ADR-template.md`](./ADR-template.md) — copy this when writing a new ADR
- [`../decisions/README.md`](./README.md) — ADR directory conventions and index
- [`../history/README.md`](../history/README.md) — phase archive directory (parallel append-only convention for completed phases)
- `~/.claude/CLAUDE.md` — global instructions; references the stable-ID convention defined here
- Sibling reference repos — the same convention applies across the project family; cross-repo references stay valid because IDs are scoped per-repo and prefixed by repo name when external (e.g. `repo-name#P-014`)
