---
paths: [".claude/commands/review.md", ".agents/agents/reviewer.md"]
---

# Review brief — GoGo Travel

The project half of the `review-loop` skill (its canonical home). Extends that
skill, never contradicts it. Reviewers get this file as a **path**, not contents.

## Records are LOCAL — nothing is posted to GitHub

**As of 2026-08-01 ([ADR-003](../../docs/decisions/ADR-003-local-in-session-reviews.md)):
no verdict sticky, no `gh api …/comments` posting, no required PR-comment replies.**
PR #13's sticky was the last one. The aggregator's output lives ONLY in
`.tmp/review*/round-<N>/VERDICT.md` for the run's duration; the durable record is
the QUEUE "Recently done" row narrative. CI (Guard/Verify) stays on GitHub —
that's CI, not review.

## The aggregator is RETIRED (decision, 2026-09-07 — reverses an earlier call)

The diff-picked panel retires **both** the fixed 5-lane roster and
`aggregate-verdict.mjs`. No sentinels. Specialists return findings plus a
one-line verdict (`ship` / `fix-then-ship` / `rethink`) in prose; the
**`merge-judge`** subagent — fresh each round, no review history, no stake — is
the final unrelated judgment. That is the role the aggregator was standing in for.

Why the reversal (an earlier version of this file said the aggregator stays):

- **It verified nothing.** It parsed the counts each reviewer wrote about itself
  and summed them. The old charter said so outright: "the aggregation trusts the
  sentinel." Deterministic arithmetic over model-authored numbers is not a check.
- **Its unique jobs are already covered.** Round cap (4) and CI-green-before-merge
  live in the `review-loop` skill; the merge decision is the judge's.
- **Its lane math is hostile to a variable panel.** It hardcoded five lanes and
  scored any lane with no sentinel as _degraded_, downgrading `ship` →
  `fix-then-ship`. A 2-specialist panel tripped a false downgrade every round.
- Keeping it meant either editing a CI-gated script or always spawning five
  lanes — the fixed panel again. The tail was wagging the dog.

The one rule worth saving from it, now the **judge's** to apply:

> Recommend a deep `/code-review ultra` when any of: verdict `rethink` · a
> sensitive-path finding that is blocking · more than 5 blocking findings total ·
> diff over 500 LOC.

`.github/scripts/aggregate-verdict.mjs` and its test file are now unreferenced.
They still sit in the tree and the CI guard job still runs their suite; deleting
them is a loose end, not a blocker (QUEUE row).

## Findings go in `.tmp/`

Per round, each specialist writes `.tmp/review/round-<N>/<specialist>.md`; use
`.tmp/review-<pr>/` when two PRs' rounds run concurrently. `.tmp/` is gitignored —
these are the record for the run's duration only. The durable record is the QUEUE
"Recently done" row narrative.

## 🔴 Mutation probes SERIALIZE the tree (PR #17 R2, 2026-08-02)

A specialist that falsifies a pin by breaking prod code, or that runs the CI gate,
is _writing to and reading from_ the checkout. **Never run two such agents against
the same worktree concurrently** — one agent's revert clobbers the other's probe,
and any test or gate result taken while a foreign mutation is live is garbage (a
gate run came back a **false red** exactly this way). Any number of pure-reading
specialists may share a tree; **at most one mutating agent per worktree** — give
each additional one `isolation: "worktree"` and check out the PR branch inside it,
or dispatch them serially. Every mutating agent confirms its probe actually applied
(`git add -N . && git diff --stat`) before trusting a result, and leaves the tree
byte-clean. Evidence collected under contention is re-run clean before it counts
(Law #7).

## Priorities, in order

1. **The Laws** (CLAUDE.md) — money in integer cents, privacy as a boundary,
   build-phase code traces to a spec, append-only feature ledger. A Law violation
   is blocking, full stop.
2. **Verification is evidence, not assertion** — a PR body claiming a green build
   or a fixed bug without pasted output is a finding in itself.
3. Correctness and concurrency over style.

## Path → specialist map

| Diff touches                                                            | Spawn                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| auth, invites/tokens, trip membership, visibility gates, rate limits    | `reviewer-security`                                         |
| async lifecycle, caching + invalidation, optimistic writes, RNTL act    | `reviewer-correctness`                                      |
| new modules, layering, `@gogo/shared` contract surface                  | `reviewer-architecture`                                     |
| a PR body making empirical claims — "verified", benchmarks, root causes | `adversarial-verifier`                                      |
| **any new or changed test** (always — this repo's defects live here)    | `reviewer-correctness` briefed as the **test-quality lane** |

Sensitive paths (auth, migrations, secrets, release) get `adversarial-verifier`
on round 1. Full list + blocking criteria: `docs/PLANNING.md § Review Pipeline
Configuration`.

### The test-quality lane's brief (this project's highest-frequency defect class)

A green test proves nothing until you know it can go red. Hunt these, by name:

- **Vacuous pins** — a test that passes with the production guard reverted. Mutation-verify
  every pin claiming to prove a fix: ungate ONE thing, expect RED. A pin you can't turn red
  isn't a pin (T-7.6 R2, T-7.9).
- **Asserting on a `disabled` element** — RNTL won't fire the handler, so "assert nothing
  happened" holds whether or not the guard exists. Spy the guarded handler instead (T-7.6).
- **Already-settled promises** — optimistic write + rollback flush in ONE notify batch, so
  mid-mutation assertions never see the in-flight state. Hold the request genuinely in
  flight with a deferred promise; release in `finally`, and collect resolvers in an ARRAY
  when the request can fire twice (T-7.9).
- **Floating act()** — un-awaited `render`/`fireEvent`/`renderHook`/`act` under RNTL v14.
  Green locally, red only under CI's 2-core contention. Gate: act-warnings must be 0
  (`.claude/rules/mobile.md`).
- **Wholesale module mocks** hiding render-time crashes in the mocked module (T-5.7).
- **Probes on new files** — `git diff --stat` is blind to added files; `git add -N .` first,
  or a no-op mutation is indistinguishable from a real one (T-7.9).

Landmine details live in `.claude/rules/mobile.md`; hand the reviewer that path.

## What NOT to flag

- Style a formatter or lint rule already owns — `prettier` and `expo lint` run in CI.
- Defensive code for cases the Zod boundary or TS strict mode already rules out.
- Test placement, naming, or structure that matches the rules files.
- Out-of-scope refactors. File a QUEUE row instead.
