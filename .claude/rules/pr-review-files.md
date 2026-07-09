---
paths: [".agents/skills/pr-review-pipeline/**", "**/aggregate-verdict*.mjs"]
---

# PR Review — File Conventions (IN-SESSION)

You're touching review-pipeline plumbing. Reviews run **in-session on Claude Code** (the main agent spawns specialist subagents). There is **NO GitHub Action, NO Copilot, NO API/console billing** — Max-plan only. Drift in the sentinel format breaks `aggregate-verdict.mjs`.

> **Canonical source for the sentinel + verdict format.** CLAUDE.md and the pipeline `SKILL.md` reference this file — don't restate the shapes elsewhere.

## Specialist lanes

`correctness` · `security` · `tests` · `performance` · `conventions`. Each gets an in-lane / not-lane charter + skepticism instruction (see the reviewer agent). Subagents are **read-only**: they emit findings, the main agent applies fixes. No Edit/Write from a reviewer.

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

## Verdict sticky (written by `aggregate-verdict.mjs` — deterministic, NOT an LLM)

The aggregator reads the lane sentinels and emits ONE sticky (updated in place each round), keyed by a marker + round/SHA comment lines, then a human-readable body:

```
<!-- GOGO-VERDICT-STICKY -->
<!-- VERDICT_ROUND: <N> -->
<!-- VERDICT_HEAD_SHA: <sha> -->
## 📋 Auto-Review Verdict — Round <N>
verdict: ship | fix-then-ship | rethink  ·  blocking: <total>  ·  advisory: <total>
<escalation / round-cap banners when applicable>
```

`verdict` = worst lane (any `rethink` → rethink; else any blocking → fix-then-ship; else ship; a degraded/missing lane downgrades ship → fix-then-ship). The sticky recommends a deep `/code-review ultra` when escalation criteria hit: verdict `rethink`, OR a `sensitive` lane with blocking>0, OR total blocking > 5, OR a large diff (>500 LOC). Round ≥ 4 is the final round; round > 4 forces `rethink`.

## File layout

Per round, specialists write `.tmp/review/round-<N>/<lane>.md` (findings + trailing sentinel). The aggregator scans that dir, parses sentinels, writes `.tmp/review/round-<N>/VERDICT.md`. `.tmp/` is git-ignored.

## Hard rules

- **4 rounds max.** Round > 4 forces `verdict: rethink` + human-decides; the aggregator enforces it.
- **CI green before merge** unless the PR carries `expected-ci-fail`.
- Merge with `--merge` only (no squash/rebase) unless the owner says otherwise.
