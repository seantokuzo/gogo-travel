---
name: pr-review-pipeline
description: In-session, multi-specialist PR review for GoGo Travel. The main agent spawns one subagent per lane (correctness/security/tests/performance/conventions), aggregates their line-format sentinels with a deterministic Node script, then drives the categorize → fix → reply → re-review → judge → merge loop. Runs on Sean's Max plan in-session — NOT a GitHub Action, no API billing. Invoke after creating a PR for any functional change.
---

# PR Review Pipeline (in-session, 5-lane)

The main Claude Code agent **spawns specialist subagents**, collects their verdicts, runs `.github/scripts/aggregate-verdict.mjs` **locally**, then drives fix/judge/merge. No `claude-code-review.yml`, no `gh workflow run`, no cloud API — all Max-billed, in-session. (Why: API/OAuth-in-CI billing is forbidden — see `CLAUDE.md` hard rules.)

This **specializes** the canonical autonomous loop in `~/.claude/CLAUDE.md` § "PR Review Workflow". It does not restate it — read that for the loop shape; read this for GoGo Travel's lanes, sentinels, aggregator, and tool wiring.

## When to invoke

- **After `gh pr create`** for any functional code change. This is the default PR gate.
- **Skip** for docs / `docs/` state / config-only PRs (review adds nothing).
- **Prereqs:** `gh auth status` green, checked out on the PR branch, CI gate runnable locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).

## Three review surfaces — pick by risk/size

| Surface              | What it is                                                                                   | Use when                                                                                       | Billing                |
| -------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| `/code-review`       | Built-in single-pass review of the working diff (low→high effort, `--fix`/`--comment`)       | Pre-PR gut-check, or a trivial/tiny functional change where 5 lanes is overkill                | In-session (Max)       |
| **this pipeline**    | 5-lane subagent fan-out + deterministic aggregator + impartial judge + autonomous merge loop | **Default** for any real functional PR                                                         | In-session (Max)       |
| `/code-review ultra` | Built-in **deep multi-agent review in the cloud**                                            | The aggregator/judge **escalates** (see below), or Sean asks, or a large/security-sensitive PR | Cloud (user-triggered) |

The aggregator's escalation banner literally recommends `/code-review ultra` — that's the bridge from this pipeline to the deep surface.

## The 5 lanes

Each lane is a subagent with a tight charter. Spawn all 5 in parallel round 1; re-run only the affected subset on later rounds.

| Lane (`KEY`)                | IN-lane                                                                                                                                                                                                                                                                               | NOT-lane                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Correctness (`CORRECTNESS`) | Logic bugs, control flow, unhandled promises/errors, null/undefined, race conditions, wrong API use, client/server contract drift, schema mismatch, migration correctness. **Owns the `ci_failing` flag** (runs/reads the CI gate). | Style, perf, test-coverage gaps, authz                           |
| Security (`SECURITY`)       | Authn/authz holes, IDOR on trip/expense/photo resources, injection (raw SQL), secret leakage, missing trust-boundary validation, expense/payment tampering, **privacy-boundary leaks** (location/photos crossing visibility levels). **Sets `sensitive: true`** when touching auth / payments-splitting / privacy / migrations / secrets.                           | General correctness, perf, style                                 |
| Tests (`TESTS`)             | Missing/weak tests for new logic, untested branches, no-assert tests, real behavior mocked away, missing coverage for new endpoints/hooks.                                                                                                                                     | Whether the code is correct (that's Correctness), perf           |
| Performance (`PERFORMANCE`) | N+1 / unbounded queries / missing indexes, re-render storms / missing memo+keys, unvirtualized long lists, offline-sync waste, map-render cost, bundle bloat.                                                                                               | Micro-opts with no measurable impact (be skeptical), correctness |
| Conventions (`CONVENTIONS`) | `CLAUDE.md` + `.claude/rules/` conventions, shared-package boundaries, schema-as-source-of-truth, import hygiene, error-handling + a11y patterns, dead code.                                                                                                | Subjective taste, anything another lane owns                     |

_Stack is locked (ADR-004: Expo/RN + Hono/Drizzle/Postgres) — lane charters get their stack-specific deep-cuts alongside the P-3 scaffold's path rules._

**Skepticism (every lane):** you have more context than a single lane. Only emit **blocking** for a real, in-scope defect. Nits → **advisory**. Push back (omit the finding) on: defensive code for cases that can't happen (framework guarantees, type-proven non-null, internal-only call sites), out-of-scope refactors, and conflicts with documented conventions. Bloated PRs come from lanes that fold on every theoretical.

## Sentinel format (each subagent emits exactly this)

A subagent's **last message** must contain one line-format block (no JSON — `{`/`"` can trip validators; `key: value` never does) plus a short findings list:

```html
<!-- GOGO-REVIEW-<LANE>
verdict: ship | fix-then-ship | rethink
blocking: <N>
advisory: <N>
sensitive: true | false
ci_failing: true | false      ← CORRECTNESS lane only
-->
```

`<LANE>` ∈ `CORRECTNESS | SECURITY | TESTS | PERFORMANCE | CONVENTIONS`. `ship` = mergeable. Canonical pin: **`.claude/rules/pr-review-files.md`** (shared truth, ported from seantokuzo-mcp) — if this block and that rule ever disagree, the rule wins.

Findings list (below the block, for the main agent to triage): one line each — `severity | path:line | problem → suggested fix`.

## The loop (per round)

### 1. Spawn the lane subagents (parallel)

One `Agent` call per lane, all in a single message. Pass each: the diff (`git diff main...HEAD` or `gh pr diff <PR>`), the changed-file list, its IN/NOT charter + skepticism rule from above, and the sentinel format. If a reviewer persona exists in `.agents/agents/`, use it as `subagent_type`; otherwise `general-purpose` with the charter inline. Round 2+: spawn only lanes whose code changed or that had unresolved blocking.

### 2. Run CI locally

Run the CI gate (`CLAUDE.md § Quality Gates`). Feed the result to the Correctness lane's `ci_failing` (true on any failure).

### 3. Aggregate

Save each subagent's sentinel block to `.tmp/review/round-<N>/<lane>.md`, then:

```bash
node .github/scripts/aggregate-verdict.mjs \
  --round <N> --head "$(git rev-parse HEAD)" \
  --additions <A> --deletions <D> \
  .tmp/review/round-<N>/*.md \
  > .tmp/review/round-<N>/VERDICT.md     # stdout = sticky body
# stderr = verdict=… round=… blocking=… degraded=… cap=… escalate=…
```

Verdict logic (deterministic): any lane `rethink` → `rethink`; else any blocking → `fix-then-ship`; else `ship`. A degraded lane (missing/malformed/invalid sentinel) can **never** yield `ship` — re-run that lane.

### 4. Post the verdict sticky

Post the captured body as a PR comment so each round is on the record (body via stdin so no shell parses it):

```bash
jq -Rs '{body: .}' .tmp/review/round-<N>/VERDICT.md \
  | gh api -X POST repos/seantokuzo/gogo-travel/issues/<PR>/comments --input -
```

(Update the same sticky on later rounds with `PATCH …/issues/comments/<id>` if you want one rolling comment.)

### 5. Triage every finding → fix / reply

Categorize each: **fix-now** (apply this PR), **respond** (no change — cite the framework/type/convention that makes it wrong), **defer** (valid, out of scope — file a follow-up issue, link it). Apply fix-now changes, commit (`fix(scope): address round N review`), push. Record each disposition — if you posted findings inline, reply in-thread (`gh api …/pulls/<PR>/comments/<id>/replies`); otherwise roll the dispositions into the round's sticky/summary. Fix replies cite the SHA.

### 6. Re-review decision

Re-run a lane (→ step 1) only when its code changed, it had unresolved blocking, you pushed back on a blocking finding and want a second look, or the diff grew meaningfully. **Everything addressed + under threshold + CI green → skip straight to the judge.** Don't re-run lanes to feel safe.

### 7. Impartial judge (fresh subagent)

After fixes settle, spawn an **impartial judge** — a fresh `general-purpose` subagent with no review history (prompt shape is canonical in `~/.claude/CLAUDE.md` § "Round-N decision"). Feed it: PR URL, round N, the latest sticky body, each lane's sentinel + findings, what you fixed (SHAs) and pushed back on (reasons), `gh pr diff <PR>`, and CI status. It returns strict JSON `{"decision":"merge|re-review|human-decides","confidence":"…","reasoning":"…"}`.

- `merge` → step 8
- `re-review` → step 1 (affected lanes)
- `human-decides` → stop, surface the reasoning, wait

### 8. Merge

CI green (unless `expected-ci-fail` label) AND judge says `merge`:

```bash
gh pr merge <PR> --merge --delete-branch
```

`--merge` only — never `--squash`/`--rebase`. Then run post-merge handoff (`~/.claude/CLAUDE.md` § "Post-merge handoff" + the `sprint-close` skill).

## Round cap + escalation

- **Hard cap: 4 rounds.** Round ≥4 = final (cap banner, escalation suppressed); the aggregator forces `rethink` past it. After round 4, escalate to **human-decides**.
- **Escalation recommendation** (banner only — no label, no auto-trigger) fires when verdict is `rethink`, OR `sensitive` + blocking>0, OR total blocking >5, OR diff >500 lines. The play: run **`/code-review ultra`** (deep cloud) or surface to Sean.

## Override: "wait for me"

If Sean says _wait for me_ (or pauses mid-flight), create the PR and **stop** — no spawning, aggregating, or merging until he signals. Canonical: `~/.claude/CLAUDE.md`.
