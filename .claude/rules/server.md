---
paths: ["apps/server/**"]
---

# apps/server — Hono/Drizzle Conventions

- Validate EVERY body/param/query at the boundary with `@gogo/shared` schemas via `@hono/zod-validator` — before any handler logic.
- Errors: shared `ApiError` envelope + `ErrorCode` enum, non-2xx. No bare `throw`, no stack traces on the wire. Success = documented schema directly; lists = `Paginated<T>`.
- **Money is integer cents** (Law #2). Expense + splits + settlements write atomically.
- 🔴 **Neon HTTP driver has NO transactions** — `.transaction()` throws in prod while `postgres-js` tests pass. Atomic multi-writes need the WebSocket `Pool` or `postgres-js`.
- 🔴 Trip-scoped authz on every endpoint — client identity is hostile; check membership on every trip/expense/photo resource. Privacy visibility checks are Law #3.
- 🟡 `const [row] = await db.select()…` is typed defined but runtime `undefined` — guard and 404.
- 🟡 Rate-limit auth surfaces; `X-Forwarded-For` is not a defense.
- Env: `loadEnv()` from `src/env.ts` is the ONLY `process.env` reader. Never log env values.
- ESM + NodeNext: relative imports need `.js` extensions. Responses shaped, not raw DB rows.
- No `console.log` (boot banner in `index.ts` is the lone exception). New logic ⇒ new vitest tests, happy path + error/edge.
- Migration for every schema change once the DB exists (Law #6).
- Done = root gate green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
