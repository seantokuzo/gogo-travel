# Path-Scoped Rules

Convention files auto-loaded by Claude Code when it reads a file matching the `paths` glob in that rule's frontmatter. They encode _how we build here_ + the landmines a review already caught, so the next model can't re-step them.

## How it works

1. A `.md` file here declares `paths: [...]` (globs) in YAML frontmatter — that line is its "applies to" header.
2. When Claude reads a file matching any glob, that rule loads into context.
3. Rules fire on **reads, not writes** (known limitation). Read before you edit.

This README is the index — it has no `paths`, so it doesn't auto-load.

## The leanness contract

- ≤ ~60 lines each. Every line costs tokens on every matching read.
- Blunt bullets, not essays. No "in this section we will…".
- **One canonical home per concept.** Don't restate CLAUDE.md or another rule — link it.
  - Exception: a landmine relevant in N independently-loaded scopes lives in each (money-in-cents is in server/web/shared because you rarely read all three in one pass).
- Guardrails, not docs. If it's not a rule or a landmine, it doesn't belong.

## Files

| Rule                    | Scopes                   | Purpose                                              |
| ----------------------- | ------------------------ | ---------------------------------------------------- |
| `planning-doc-homes.md` | `docs/**`, `.specs/**`   | What goes where; one home per doc                    |
| `pr-review-files.md`    | pr-review-pipeline skill | In-session review sentinel/verdict spec              |
| `ci.md`                 | `.github/workflows/**`   | No cron / no LLM in CI (guard-enforced); gate command; prod-parity landmine |
| `server.md`             | `apps/server/**`         | Hono/Drizzle + landmines                             |
| `mobile.md`             | `apps/mobile/**`         | Expo/RN + landmines                                  |
| `shared.md`             | `packages/**`            | Zod SoT, money, DI, vitest pin                       |
