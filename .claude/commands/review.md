---
description: Run the in-session 5-lane PR review pipeline on the current branch's PR.
argument-hint: [pr-number]
---

# /review — in-session PR review pipeline

GoGo Travel's **5-lane, in-session, Max-billed** review. Not a GitHub Action, no API billing ([ADR-003](../../docs/decisions/ADR-003-local-in-session-reviews.md)). Needs an open PR (`gh pr create` first if there's none); skip for docs/config-only PRs.

## Do this

Load and run `.agents/skills/pr-review-pipeline/SKILL.md` end-to-end:

1. Spawn the 5 lanes in parallel (`reviewer` persona ×5): **correctness · security · tests · performance · conventions**.
2. Run CI locally; aggregate the line-format sentinels with `aggregate-verdict.mjs`; post the verdict sticky.
3. Triage every finding (fix-now / respond / defer), apply fixes, reply inline.
4. Spawn the **impartial judge** → `merge` / `re-review` / `human-decides`. 4-round cap. Merge `--merge` only, CI green.

## Which review surface?

| Use | When |
|-----|------|
| **`/review`** (this) | **Default** gate for any real functional PR — 5 lanes + judge + autonomous merge. |
| `/code-review` (built-in) | Quick single-pass gut-check of the working diff pre-PR, or a trivial change. Max-billed. |
| `/code-review ultra` | Deep multi-agent **cloud** review. When the aggregator escalates, the PR is big/security-sensitive, or Sean asks. User-triggered. |
