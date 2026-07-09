# GoGo Travel — Project Instructions

> Extends global `~/.claude/CLAUDE.md`. Project-specific only; never contradicts
> global — EXCEPT: the global "PR Review Workflow" section's GitHub-app transport
> does not apply here. Reviews are **local in-session**
> ([ADR-003](docs/decisions/ADR-003-local-in-session-reviews.md)); the global
> section's decision logic (triage, skepticism, judge, caps, handoff) still governs.

## What this is

A mobile travel app: trips, itinerary/calendar, bookings (stay/travel/activities),
maps, budgeting + AI estimates, AI recommendations + tour guide, expense
splitting, photos pinned to places, deeplink-first integrations.
**Read before working:** `docs/STATE.md` (auto-injected) → `docs/QUEUE.md` →
`docs/PLANNING.md` for anything architectural. Specs live in `.specs/`.

## The Laws (violations = blocking review findings)

1. **Secrets never in git.** `.env` is gitignored; the security hook blocks reads.
2. **Money is integer cents (or `Decimal`) — never float.** All budgets, splits,
   balances.
3. **Privacy is a boundary.** Location, photos, and albums never cross a
   visibility level (private → shared → public) without an explicit check.
   Default private.
4. **Build-phase code traces to a spec.** During build phases (P-3+), behavior
   not covered by `.specs/` is an escalation (see Autonomy Contract), not an
   improvisation.
5. **No metered API spend.** Everything LLM runs in-session on Max. No
   `ANTHROPIC_API_KEY` in CI, no scheduled LLM jobs (ADR-003).
6. **Migration for every schema change** once a database exists. No ad-hoc drift.
7. **Verification is evidence, not assertion.** Tests/build output pasted, the
   feature exercised in the running app. Reviewers and judges never grade their
   own code.
8. **The feature ledger is append-only truth.** `passes` booleans flip only
   after verified testing. Removing or editing ledger entries is forbidden.

## Autonomy Contract

**Default: AUTONOMOUS.** Plan → build → test → review → judge → merge → next
task, without asking. Sean is planner/spec-maker/QA, not a babysitter.

**Stop and ask Sean (the ONLY escalation triggers):**

1. **Spec ambiguity** — the spec doesn't cover a case and the choice is
   user-visible (runtime twin of `[NEEDS CLARIFICATION]`).
2. **Architecture divergence** — the right implementation contradicts a locked
   ADR / PLANNING decision. Propose, don't improvise.
3. **New external dependency with real-world surface** — new paid service,
   account signup, API key, or anything that bills.
4. **Security-model changes** — auth flows, session handling, privacy-boundary
   semantics.
5. **Irreversible / outward-facing ops** — deploys, data deletions or
   destructive migrations, publishing, force-anything.
6. **Scope change** — a feature or behavior not in the approved spec set.
7. **Judge says `human-decides`** — or the 4-round review cap is hit.

**How to ask:** batch questions where possible; use structured options (2–4)
with a marked recommendation. Never block an active wave on a parkable
question — park it as a `blocked` QUEUE row + STATE note and continue other work.
Everything reversible AND in-spec runs without asking.

## Before you code

1. Read the relevant `.specs/` contract and `.agents/skills/` for the domain.
2. **Context7 for ALL library APIs** — never trust training data.
3. `npm view <package> version` before adding any dependency.
4. Read the role file in `.agents/agents/` for the work you're doing.

## Tech stack

**Pending ADR-004** (S-1 stack spike — PWA vs Expo/RN vs hybrid). T-1.4 pins
this section, the engineer personas, path-scoped rules, the formatter hook, and
the Quality Gate command once locked. Until then: no app scaffolding.

## Git conventions

- Atomic commits — `type(scope): description` (`feat`, `fix`, `refactor`,
  `docs`, `test`, `chore`).
- Branch naming — `P-N/T-M-slug` for tasks, `B-N/slug` for bugs, `S-N/slug`
  for spikes.
- Merge style `--merge` (never squash/rebase). CI green before merge unless
  labeled `expected-ci-fail`.

## Agent workflow

Thin orchestrator, fat workers — decompose into waves, spawn specialists in
parallel, pass **paths** not contents, no nesting, verify after each wave.
Full directive: `.agents/agents/orchestrator.md`.

| Agent | Role |
|-------|------|
| `orchestrator.md` | Decomposition, wave dispatch, verification |
| `researcher.md` | Read-only research, Context7-first, confidence-tagged |
| `reviewer.md` | Single-lane review specialist (spawned by the pipeline) |
| _engineers_ | Added by T-1.4 once the stack locks (TEMPLATE.md) |

## Planning convention

Stable IDs (`P-N` / `T-N.M` / `B-N` / `S-N`), canonical doc homes, append-only
ADRs/history, derived execution order. Canonical: [ADR-001](docs/decisions/ADR-001-naming-convention.md)
+ `.claude/rules/planning-doc-homes.md` (auto-fires on doc reads). Status enum:
[ADR-002](docs/decisions/ADR-002-status-enum-lock.md). Specs are three-artifact
(requirements w/ EARS criteria · design · tasks) in `.specs/<area>/`.

## Local review pipeline

Every functional PR: 5 parallel reviewer lanes → deterministic aggregation
(`.github/scripts/aggregate-verdict.mjs`) → triage every finding
(`fix-now`/`respond`/`defer`) → inline replies → fresh impartial judge →
`merge | re-review | human-decides`. Hard cap 4 rounds.
**Run it with `/review`; fix loop is `/address-comments`.**
Sentinel format: `.claude/rules/pr-review-files.md` (canonical — don't restate).
Sensitive paths + blocking criteria: `docs/PLANNING.md § Review Pipeline
Configuration`.

## Quality Gates (before any task counts as done)

1. Code compiles/builds; 2. tests green (new logic ⇒ new tests); 3. no
regressions; 4. conventions honored; 5. no secrets/PII in code or logs.
**CI gate command:** _TBD — pinned by T-1.4 after ADR-004_ (lint + typecheck +
test + build equivalent).

## Autonomous loop ("spec and walk away")

`bash scripts/run-loop.sh start|stop|status` — chains fresh sessions gated by
`.loop/` sentinels (`done`/`pivot`/`blocked`/`next-prompt.md`); Stop hook
enforces the contract; escalation triggers above still apply inside the loop
(write `.loop/pivot`). Discipline: `.agents/skills/autonomous-loop/SKILL.md`.

## What NOT to do

- Don't guess library APIs or package versions — verify.
- Don't nest subagents; don't paste file contents into spawn prompts.
- Don't skip the review pipeline on functional changes.
- Don't create new top-level `docs/*.md` outside the canonical homes.
- Don't add GitHub-app review workflows or any metered-API automation.

## Self-improvement

When Sean corrects behavior or a mistake ships: identify the missing/violated
rule, add it HERE (or the right rule/skill file) precisely — "Always X when Y",
with the why. Every correction makes future sessions better.
