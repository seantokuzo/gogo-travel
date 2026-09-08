---
paths:
  [
    ".agents/skills/pr-review-pipeline/**",
    ".claude/commands/review.md",
    "**/aggregate-verdict*.mjs",
  ]
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

Sentinel + verdict format: `.claude/rules/pr-review-files.md` (canonical — don't restate).

## The aggregator stays (decision, 2026-09-07)

Switching to the diff-picked panel retires the fixed 5-lane roster, **not** the
deterministic aggregation. Every specialist still emits a line-format sentinel;
the orchestrator still runs `.github/scripts/aggregate-verdict.mjs` into
`.tmp/review*/round-<N>/VERDICT.md` before spawning the judge.

Why: the aggregator is mechanically tested (its falsification suite runs in the CI
guard job via `node --test .github/scripts/*.test.mjs`), and it is the one step
between reviewer output and the judge that doesn't rest on model judgment. A
reviewer whose sentinel counts disagree with its own findings gets caught here.
Dropping it would orphan a working, verified check and its CI coverage to gain
nothing. Law #7 argues the same way.

So: **panel selection is new, sentinel discipline is unchanged.**

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
