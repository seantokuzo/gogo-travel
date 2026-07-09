---
description: Drive the in-session review-comment loop — categorize, fix, reply inline, re-review, judge.
argument-hint: [pr-number]
---

# /address-comments — work the review feedback

The post-review fix loop. **In-session on Max — no Copilot, no GitHub Action** ([ADR-003](../../docs/decisions/ADR-003-local-in-session-reviews.md)). This is steps 5–8 of the pipeline.

## Do this

1. **Load** `.agents/skills/pr-review-pipeline/SKILL.md` and follow its triage → fix → reply → re-review → judge → merge loop.
2. **Pull comments** (`$ARGUMENTS` = PR #, else detect from the current branch): `gh api repos/seantokuzo/gogo-travel/pulls/<PR>/comments`.
3. **Categorize every comment** — apply skepticism, a reviewer is a tool not an oracle:
   - **fix-now** → apply, commit `fix(scope): address round N review`, reply in-thread citing the SHA.
   - **respond** → no change; reply citing the framework/type guarantee/convention that makes it wrong.
   - **defer** → valid but out of scope; add a `docs/QUEUE.md` row (`T-N`/`B-N`) and reply with the ID.
4. **Reply inline, in-thread** (`gh api …/pulls/<PR>/comments/<id>/replies`) — never one batched PR comment.
5. **After fixes:** CI green, re-run only affected lanes if needed, then spawn the **impartial judge** → `merge` / `re-review` / `human-decides`. 4-round cap.

"wait for me" → stop after replies, don't merge.
