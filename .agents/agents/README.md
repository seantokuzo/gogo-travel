# Subagent Personas

Charters for the specialists the main agent (orchestrator) spawns. One file = one role. Read the one you're spawned as; ignore the rest.

## Philosophy: thin orchestrator, fat workers

The main agent **coordinates** — it decomposes work, spawns specialists, verifies results, keeps its own context lean. The specialists **do the heavy lifting** — read code, write code, run tests, review diffs.

- **Pass paths, not contents.** Spawn prompts carry file _paths_ and task IDs. Pasting file bodies into a spawn prompt bloats context and defeats the point. Workers read what they need.
- **No nesting.** Workers don't spawn workers. If a task is too big for one worker, it was decomposed wrong — kick it back to the orchestrator.
- **Reference, don't restate.** Conventions live in `.claude/rules/`, procedures in `.agents/skills/`, state in `docs/`. Personas point at those — they don't copy them.
- **Stay in your lane.** Each persona has a charter. Out-of-lane findings get noted in one line, not fixed.

## Roster

| Persona               | Owns                                                        | Spawn when                                                                               |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `orchestrator.md`     | Coordination, decomposition, waves, verification            | The session's driver. Not usually "spawned" — it's the main agent.                       |
| `backend-engineer.md` | `apps/server` (Hono · Drizzle/Neon · Socket.io · BullMQ)    | API routes, DB schema/queries, real-time, workers, auth                                  |
| `web-engineer.md`     | `apps/web` (React · TanStack Router/Query · Vite)           | Web UI, routes, data hooks, client auth                                                  |
| `mobile-engineer.md`  | `apps/mobile` (Expo · RN · expo-router · NativeWind · MMKV) | Mobile screens, native UI, offline/sync, push                                            |
| `reviewer.md`         | One review lane on a PR diff                                | After a PR is opened — one reviewer per lane, in parallel (see pr-review-pipeline skill) |
| `researcher.md`       | Read-only investigation, codebase mapping, feasibility      | A question must be answered _before_ implementation; spikes (`S-N`)                      |

`packages/shared` (Zod schemas/hooks/utils, `@gogo/shared`) has no dedicated engineer — whichever engineer needs a schema change owns it for that task, but **shared is the contract**: change it deliberately and check every consumer.

## Routing

- **One component, clear domain** → the matching engineer.
- **Spans components** (e.g. new endpoint + web consumer + mobile consumer) → decompose into per-component tasks, spawn engineers in parallel where independent, sequence where a contract must land first.
- **"Which approach / does X work / where does Y live"** → `researcher` before any engineer.
- **PR opened** → `reviewer` ×N lanes via the pr-review-pipeline skill.

## Pointers (the canonical homes — don't duplicate them here)

- Constitution & loop: `CLAUDE.md`
- State / plan / queue: `docs/STATE.md`, `docs/PLANNING.md`, `docs/QUEUE.md`
- Path-scoped conventions: `.claude/rules/{server,web,mobile}.md` (auto-load when you open matching files)
- Procedures: `.agents/skills/pr-review-pipeline`
- Library APIs: Context7 (never trust training data)
