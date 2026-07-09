---
description: Ad-hoc small task — minimal ceremony. Bug fix, config tweak, debug, tiny refactor.
argument-hint: [what to do]
---

# /quick — ad-hoc escape hatch

For one-offs that don't need a phase. Keep it light — no orchestrator, no waves, no queue ritual.

## Do this

- **Scope:** clarify if fuzzy, then go. If it maps to a `docs/QUEUE.md` task, note the ID; if it spawns follow-ups, drop them in QUEUE.
- **Libraries:** Context7 before writing code; never guess versions (`npm view <pkg> version`).
- **Conventions:** `.claude/rules/` still apply (auto-load on read).
- **Change it:** branch if non-trivial, commit atomically — conventional `fix|feat|chore(scope): …` (no ticket prefix).
- **CI gate** if code changed (`CLAUDE.md § Quality Gates`).
- **Wrap:** PR-worthy → push, `gh pr create`, run `/review`. Otherwise report files changed + any follow-ups.

Don't ceremony a two-line fix.
