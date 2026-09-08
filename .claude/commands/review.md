---
description: Deprecated alias — runs the canonical /review-loop review workflow on the current branch's PR.
argument-hint: [pr-number]
---

# /review — alias for `/review-loop`

**`/review-loop` is the canonical review workflow for this project** (2026-09-07).
This command exists so old muscle memory and older QUEUE rows still resolve.

## Do this

Invoke the `review-loop` skill with the same argument and follow it end-to-end.
Do not run the retired fixed 5-lane pipeline — `/review-loop` picks the panel
from the diff instead.

The project brief the skill asks for is `.claude/rules/review.md`: priorities,
the path → specialist map, what NOT to flag, and where records live.

## Which review surface?

| Use                       | When                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **`/review-loop`**        | **Default** gate for any real functional PR — diff-picked panel + judge + autonomous merge.                                  |
| `/code-review` (built-in) | Quick single-pass gut-check of the working diff pre-PR, or a trivial change. Max-billed.                                     |
| `/code-review ultra`      | Deep multi-agent **cloud** review. When the panel escalates, the PR is big/security-sensitive, or Sean asks. User-triggered. |
