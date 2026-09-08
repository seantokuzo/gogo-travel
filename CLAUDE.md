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
   Preserve the file's existing JSON escape style when flipping — an emitter
   re-encode defeats the append-only eyeball audit.

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
2. Read the role file in `.agents/agents/` for the work you're doing.

## Tech stack

Locked by [ADR-004](docs/decisions/ADR-004-stack-expo-rn-hono-drizzle.md); the
workspace manifests say what's installed. What they DON'T tell you:

- `apps/mobile` styling is `StyleSheet` + `@gogo/tokens` — **NO NativeWind**
  unless a deliberate migration ADR says so.
- `packages/shared` Zod schemas are the single source of truth; every wire
  type is a `z.infer`, never a hand-written interface.
- `apps/server` runs Neon in prod but `postgres-js` in tests — driver-class
  bugs are invisible to CI.
- iOS first (simulator-driven; XcodeBuildMCP available), Android verification
  pass pre-launch. Maps SDK + AI provider: S-2 research → ADR if non-obvious.

## Git conventions

- Atomic commits — `type(scope): description` (`feat`, `fix`, `refactor`,
  `docs`, `test`, `chore`).
- Branch naming — `P-N/T-M-slug` for tasks, `B-N/slug` for bugs, `S-N/slug`
  for spikes, `qa/<slug>` for multi-bug QA integration branches, `chore/<slug>`
  for ID-less hygiene batches (source QUEUE rows carry no stable ID).
- Merge style `--merge` (never squash/rebase). CI green before merge unless
  labeled `expected-ci-fail`.

## Agent workflow

**Pure orchestrator, fat workers** — the central agent only reads state,
decomposes, dispatches, tracks, and verifies wave gates; everything else
(research, specs, code, review lanes, fixes, judging, doc updates, merges,
handoffs) is delegated to subagents. Full directive + parallelism doctrine
(its canonical home): `.agents/agents/orchestrator.md`; the per-role files sit
beside it in `.agents/agents/`.

**Shared-worktree rule** (learned 2026-07-10, P-3): background agents share
the session's working tree — a checkout by either side moves HEAD for both.
While an engineer agent owns the tree on a feature branch, the orchestrator
FREEZES all git writes (no commits, no checkouts); doc updates queue until
the branch merges. Parallel review lanes: only ONE lane (correctness, which
runs the CI gate) may checkout; the rest review via `git diff`/`git show`.
Agents that mutate files in parallel get `isolation: "worktree"`.

## Planning convention

Stable IDs (`P-N` / `T-N.M` / `B-N` / `S-N`) — canonical:
[ADR-001](docs/decisions/ADR-001-naming-convention.md). Doc homes, the locked
status enum, and the three-artifact spec shape all live in
`.claude/rules/planning-doc-homes.md` (auto-fires on doc reads).

## Local review pipeline

Every functional PR gets one — **run `/review-loop`; the fix loop is
`/address-comments`.** (`/review` is a deprecated alias that redirects here.)
Review records are **local-only** (ADR-003): no verdict sticky, nothing about a
review posted to GitHub (CI stays; that's CI, not review). The panel is picked
from the diff, not fixed. Project brief — priorities, path → specialist map,
what NOT to flag: `.claude/rules/review.md`.

## Quality Gates (before any task counts as done)

**CI gate command:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
— new logic ⇒ new tests, happy path + error/edge.

## Autonomous loop ("spec and walk away")

`bash scripts/run-loop.sh start|stop|status`. The escalation triggers above
still apply inside the loop — write `.loop/pivot` to stop and ask. Sentinels,
Stop-hook contract, and discipline: `.agents/skills/autonomous-loop/SKILL.md`.

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
