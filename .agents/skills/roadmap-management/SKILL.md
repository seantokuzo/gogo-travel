---
name: roadmap-management
description: Plan and manage P-N / T-N roadmaps. Use when planning new phases, reprioritizing work, managing depends_on between tasks, or deciding what to build next.
---

# Roadmap Management Skill

P-N / T-N roadmap planning for the GSD workflow. No sprints, no story points, no Jira. Phases (`P-N`) deliver observable user capabilities; tasks (`T-N`) are atomic units inside a phase. See CLAUDE.md § "Project Planning Convention" and `docs/decisions/ADR-001-naming-convention.md` for the full convention.

## Core Concept: Phases (`P-N`) and Tasks (`T-N`)

A **phase** (`P-N`) is a unit of work that delivers something the user can see, touch, or use. Each phase has:

- A **stable ID** (`P-1`, `P-2`, …) assigned once and never renumbered
- A **name/theme** (e.g., "Hello World", "Auth & Security", "Real-Time Dashboard")
- **Clear success criteria** — What can the user do after this phase ships?
- A list of **tasks** (`T-N`) — atomic units, one per PR

A **task** (`T-N`) is the atomic unit. Tasks bundle into PRs per the sizing rule; canonical source: [ADR-001 § PR sizing](../../../docs/decisions/ADR-001-naming-convention.md#pr-sizing) (default 30–500 lines, 2–15 files, with bug / spike / mass-refactor / phase-closing exceptions). Bugs (`B-N`) and spikes (`S-N`) are sibling item types — `B-N` always its own PR, `S-N` produces no PR (output is an ADR or STATE update).

**Waves are runtime only.** Within a phase, the orchestrator may dispatch tasks in parallel waves based on `depends_on`, but waves are NOT a structural label inside `docs/QUEUE.md`.

### Phase Structure (in `docs/QUEUE.md`)

Status values come from [ADR-002 § Decision](../../../docs/decisions/ADR-002-status-enum-lock.md): one of `queued`, `in-progress`, `blocked`, `done`, `deferred`, or `cancelled`. Pick exactly one — leaving the pipe-separated legend in a live doc breaks deterministic grep.

```markdown
## P-N: "Theme Name" — status: in-progress

### Success Criteria
- [ ] User can do X
- [ ] User can do Y
- [ ] System handles Z

### Tasks
- T-1 (frontend) — description — status: done — PR #12
- T-2 (backend) — description — status: in-progress — depends_on: []
- T-3 (frontend) — description — status: queued — depends_on: [T-2]
- T-4 (integration) — description — status: queued — depends_on: [T-1, T-2]

### Deferred
- Idea X — queued as T-N in P-(N+1), or filed as B-N if it's a bug
```

The orchestrator computes runtime waves at execution time from `status` + `depends_on` — independent queued tasks form Wave 1, tasks waiting on Wave 1 form Wave 2, etc.

## Planning a New Phase (`P-N`)

### 1. Identify the Goal

Ask: **"What can the user do after this phase that they can't do now?"**

The answer should be concrete and observable:
- "User can log in and see their dashboard" (good)
- "Improve the architecture" (bad — not user-observable)

### 2. Decompose into Tasks (`T-N`)

Break the goal into atomic tasks. Each task should:
- Touch ONE component/domain
- Be completable in one agent session
- Result in one atomic commit (one task = one commit). Canonical PR sizing rule: [ADR-001 § PR sizing](../../../docs/decisions/ADR-001-naming-convention.md#pr-sizing)
- Have clear success criteria
- Get a **stable ID** (`T-1`, `T-2`, …) — assigned once, never renumbered

### 3. Map Dependencies (`depends_on`)

```
T-1 ──┐
      ├──► T-4 (depends_on: [T-1, T-2])
T-2 ──┘
T-3 ────► T-5 (depends_on: [T-3])
```

Encode `depends_on` directly on each task in `docs/QUEUE.md`.

### 4. Runtime Waves (computed, not stored)

Waves are computed by the orchestrator at execution time, not stored in QUEUE.md:

- **Wave 1**: Tasks with `status: queued` and empty `depends_on` (run in parallel)
- **Wave 2**: Tasks whose `depends_on` are all `done` after Wave 1 (run in parallel)
- **Wave N**: Continue until all tasks are scheduled

### 5. Estimate Complexity

Not time — complexity:

| Size | Description | Agent Sessions |
|------|-------------|---------------|
| **S** | Single file, clear pattern | 1 session |
| **M** | Multiple files, some decisions | 1-2 sessions |
| **L** | Cross-cutting, architecture decisions | 2-3 sessions |
| **XL** | Should probably be split into smaller tasks | Split it |

## Prioritization

### Now / Next / Later

The simplest framework. Use this by default:

- **Now** (current phase): Committed. Building this.
- **Next** (next phase): Planned. Scoped but not started.
- **Later** (backlog): Directional. Will refine when closer.

### When Scope Creeps

During implementation, new work will be discovered. For each item:

1. **Is it blocking?** → Add a new task `T-(next)` to the current `P-N` in `docs/QUEUE.md`
2. **Is it important but not blocking?** → Queue as `T-N` in a later `P-N` (or as `B-N` if it's a bug); also file a GitHub Issue if external visibility helps
3. **Is it nice-to-have?** → Note in `docs/STATE.md` and create a GitHub Issue tagged backlog

Never expand the current phase's scope unless it's genuinely blocking.

## Tracking Progress

### In `docs/QUEUE.md`

This is the live work queue. Update task `status` as work moves:

```markdown
## P-1: "Hello World" — status: done
- T-1 (frontend) — landing page — status: done — PR #1
- T-2 (backend) — health check — status: done — PR #2
- T-3 (integration) — wire up — status: done — PR #3

## P-2: "Auth & Security" — status: in-progress
- T-4 (backend) — JWT issuer — status: done — PR #4
- T-5 (frontend) — login form — status: done — PR #5 — depends_on: [T-4]
- T-6 (backend) — session refresh — status: in-progress — depends_on: [T-4]
- T-7 (frontend) — protected routes — status: queued — depends_on: [T-5, T-6]
```

### In `docs/STATE.md`

Update session state after milestones:

```markdown
## Current
P-2 / T-6 in progress; T-7 queued behind it.

## Recent Decisions
- Chose JWT over session cookies (see ADR-NNN — placeholder; replace with real ADR ID when locked)
- Deferred OAuth to P-3 (queued as T-12)
```

When `P-N` fully merges, archive its STATE notes to `docs/history/P-NNN-<slug>.md` and trim STATE.md back to current/in-flight context.

### Deferred Work → Queued Tasks or GitHub Issues

All deferred items become either a queued `T-N`/`B-N` in `docs/QUEUE.md`, or a GitHub Issue (or both, when external visibility helps). Issue labels:

- `P-N` — Which phase it's targeted for (e.g. `P-3`)
- `deferred` — Came from scope management
- `tech-debt` — Technical debt items
- `enhancement` — Nice-to-have improvements

## Phase Completion Checklist

Before declaring a phase (`P-N`) complete:

- [ ] All success criteria met
- [ ] All `T-N` PRs in this phase merged to main
- [ ] `docs/QUEUE.md` updated — all `T-N` for this phase marked `done`, phase status flipped to `done`
- [ ] `docs/STATE.md` archived to `docs/history/P-NNN-<slug>.md`; STATE trimmed
- [ ] Locked decisions promoted to ADRs in `docs/decisions/`
- [ ] Deferred items queued as later-phase `T-N` / `B-N` (or filed as GitHub Issues)
- [ ] No known regressions introduced
