# ADR-003: PR reviews run local in-session on Max, not in CI

**Status:** Accepted
**Date:** 2026-07-09
**Supersedes:** none
**Superseded by:** none

## Context

Sean's other repos carry two review systems: a GitHub-Actions Claude review
pipeline (`claude-code-review.yml` + deep-review + verdict aggregation) and an
in-session port of the same intelligence (the-bach). Sean is on a **Max
subscription** and wants no metered API spend; he also explicitly asked this
project to **ignore the GitHub-Claude-app workflows and use local reviews**.

The-bach's ADR-002 verified the underlying facts: `anthropics/claude-code-action`
prefers an API key when both credentials are set (pay-per-use), OAuth/Max tokens
in CI are unsupported/ToS-restricted and can silently bill as API usage — so
there is **no supported way to bill GitHub-Action PR reviews to a Max plan.**
Meanwhile the review *intelligence* (multi-specialist fan-out → deterministic
verdict aggregation → fix loop → impartial judge) runs fine in-session, billed
to Max.

## Decision

**The PR-review pipeline runs in the Claude Code session — never as a GitHub
Action.** No `claude-code-review.yml` / `claude.yml` workflows, no
`ANTHROPIC_API_KEY` in CI, no scheduled LLM jobs.

Mechanics (ported from the-bach, markers renamed to `GOGO-*`):

- `.agents/skills/pr-review-pipeline/SKILL.md` — the main agent spawns 5
  read-only specialist subagents in parallel (correctness / security / tests /
  performance / conventions; charters in `.agents/agents/reviewer.md`), each
  emitting a line-format sentinel.
- `.github/scripts/aggregate-verdict.mjs` — deterministic (non-LLM) verdict:
  any `rethink` → rethink; else any blocking → fix-then-ship; else ship. Posts
  one `GOGO-VERDICT-STICKY` sticky per PR, updated per round.
- Categorize every finding `fix-now` / `respond` / `defer`; inline replies;
  fresh **impartial judge** subagent decides `merge | re-review | human-decides`.
- Hard cap 4 rounds; CI (deterministic checks only) green before merge;
  `--merge` only.

CI keeps the cheap deterministic gate only (lint/typecheck/test/build — command
pinned after ADR-004). No LLM in CI.

## Alternatives considered

1. **GitHub-Action review via `ANTHROPIC_API_KEY`.** Rejected: metered spend +
   Sean explicitly excluded the GitHub-app workflows.
2. **OAuth/Max token in CI.** Rejected: unsupported, ToS-restricted, silent-
   billing foot-gun.
3. **Built-in `/code-review` only.** Kept as a complement; loses the
   deterministic multi-lane verdict + judge rigor as the primary mechanism.

## Consequences

- Same rigor as the CI version at zero API cost; no CI secret/billing foot-guns.
- Reviews fire when Claude runs the pipeline in-session — fine for a
  Sean-driven repo; revisit if outside contributors arrive.
- The aggregator + tests live in-repo (`.github/scripts/`) but are invoked
  locally, not by a workflow.

## Links

- `.agents/skills/pr-review-pipeline/SKILL.md` · `.claude/rules/pr-review-files.md`
- the-bach `docs/decisions/ADR-002-in-session-reviews.md` (source of the
  billing-facts research)
