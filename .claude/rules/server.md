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
- 🔴 **Validate/parse every secret at BOOT, awaited** (keys via `importPKCS8`, AES keys, etc.). A parse Promise stored unawaited in a factory (perf "hoist") defers rejection to first use — where an error-swallowing catch turns a bad-config boot into a silent per-request failure. Mirror the pattern: `await` the parse in `buildAuthDepsFromEnv`/wire so malformed config fails LOUD at startup (T-5.2 ultrareview bug_001).
- 🟡 **Never embed raw control bytes in test string literals** — use `\uNNNN` escapes. A literal NUL/BEL flags the file binary to git, breaking grep/review tooling (caught T-5.1 in `user.test.ts`, re-caught T-5.2 in `sign-in.test.ts`). The `\p{Cc}`-strip tests are the usual offender.
- ESM + NodeNext: relative imports need `.js` extensions. Responses shaped, not raw DB rows.
- No `console.log` (boot banner in `index.ts` is the lone exception). New logic ⇒ new vitest tests, happy path + error/edge.
- Migration for every schema change once the DB exists (Law #6).
- Done = root gate green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
