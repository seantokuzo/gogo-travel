---
paths: [".agents/skills/pr-review-pipeline/**", "**/aggregate-verdict*.mjs"]
---

# PR Review — File Conventions (IN-SESSION)

You're touching review-pipeline plumbing. Reviews run **in-session on Claude Code** (the main agent spawns specialist subagents). There is **NO GitHub Action, NO Copilot, NO API/console billing** — Max-plan only. Drift in the sentinel format breaks `aggregate-verdict.mjs`.

> **Canonical source for the sentinel + verdict format.** CLAUDE.md and the pipeline `SKILL.md` reference this file — don't restate the shapes elsewhere.

## Specialist lanes

`correctness` · `security` · `tests` · `performance` · `conventions`. Each gets an in-lane / not-lane charter + skepticism instruction (see the reviewer agent). Subagents are **read-only**: they emit findings, the main agent applies fixes. No Edit/Write from a reviewer.

🔴 **Mutation probes are the ONE exception — and they SERIALIZE the tree** (learned PR #17 R2, 2026-08-02). A lane that falsifies a pin by breaking prod code, or that runs the CI gate, is _writing to and reading from_ the checkout. **Never run two such agents against the same worktree concurrently** — one agent's revert clobbers the other's probe, and every test/gate result taken while a foreign mutation is live is garbage (a gate run came back a **false red** exactly this way). Concurrency rules: any number of pure-reading lanes may share a tree; **at most one mutating agent per worktree at a time** — give each additional one `isolation: "worktree"` (then check out the PR branch inside it), or dispatch them serially. Every mutating agent must confirm its probe actually applied (`git diff --stat`) before trusting a result — a `sed` that silently no-ops looks exactly like a passing falsification — and must leave the tree byte-clean. Runtime evidence collected under contention is re-run clean before it counts (Law #7).

## Lane sentinel — LINE format, NOT JSON

Each specialist ends its findings with exactly one sentinel block. Line format (no `{`/`}`, no quotes) so a sandboxed Bash validator can never choke on it:

```
<!-- GOGO-REVIEW-{CORRECTNESS|SECURITY|TESTS|PERFORMANCE|CONVENTIONS}
verdict: ship | fix-then-ship | rethink
blocking: <N>
advisory: <N>
sensitive: true | false
ci_failing: true | false      (correctness lane only; omit elsewhere)
-->
```

Required keys: `verdict`, `blocking`, `advisory`, `sensitive`. Don't rename keys, don't add a required key without updating the aggregator. One sentinel per lane per round.

## Verdict record (LOCAL-ONLY; written by `aggregate-verdict.mjs` — deterministic, NOT an LLM)

**As of 2026-08-01, review records never touch GitHub** (PR #13's sticky was the last). The aggregator's output lives ONLY in `.tmp/review*/round-<N>/VERDICT.md` for the run's duration; the durable record is the QUEUE "Recently done" row narrative (the richer record). No `gh api …/comments` sticky posting, no required PR-comment replies. CI (Guard/Verify) stays on GitHub — that's CI, not review.

The aggregator reads the lane sentinels and emits ONE record per round, keyed by a marker + round/SHA comment lines, then a human-readable body (marker names unchanged — the script's output format is stable):

```
<!-- GOGO-VERDICT-STICKY -->
<!-- VERDICT_ROUND: <N> -->
<!-- VERDICT_HEAD_SHA: <sha> -->
## 📋 Auto-Review Verdict — Round <N>
verdict: ship | fix-then-ship | rethink  ·  blocking: <total>  ·  advisory: <total>
<escalation / round-cap banners when applicable>
```

`verdict` = worst lane (any `rethink` → rethink; else any blocking → fix-then-ship; else ship; a degraded/missing lane downgrades ship → fix-then-ship). The record recommends a deep `/code-review ultra` when escalation criteria hit: verdict `rethink`, OR a `sensitive` lane with blocking>0, OR total blocking > 5, OR a large diff (>500 LOC). Round ≥ 4 is the final round; round > 4 forces `rethink`.

## File layout

Per round, specialists write `.tmp/review/round-<N>/<lane>.md` (findings + trailing sentinel); use `.tmp/review-<pr>/` when two PRs' rounds run concurrently. The aggregator scans that dir, parses sentinels, writes `round-<N>/VERDICT.md` alongside. `.tmp/` is git-ignored — these files are the review record for the run's duration only (durable home: QUEUE row narrative).

## Hard rules

- **4 rounds max.** Round > 4 forces `verdict: rethink` + human-decides; the aggregator enforces it.
- **CI green before merge** unless the PR carries `expected-ci-fail`.
- Merge with `--merge` only (no squash/rebase) unless the owner says otherwise.
