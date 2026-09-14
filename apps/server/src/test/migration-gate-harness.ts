/**
 * Migration-gate-only composition-root stand-in (B-28 round-2, R-test-3:
 * "the dev REFUSE path has no executed test").
 *
 * NOT `src/index.ts`. `getDb()` (`db/index.ts`) hardcodes the Neon
 * serverless WebSocket `Pool`, which speaks Neon's own proxy protocol and
 * cannot reach a vanilla Postgres (testcontainers included) without a
 * WS↔TCP proxy this repo doesn't run — documented at `migration-fixtures.ts`
 * and `boot-shape.test.ts`'s own header, and re-confirmed round-1: every
 * other DB suite in this repo works around the identical limitation by
 * injecting a `postgres-js` `db` directly instead of going through
 * `getDb()`. `boot-shape.test.ts`'s composition-root subprocess arms stay
 * DB-free for the same reason.
 *
 * This harness applies that SAME, already-established workaround to a
 * genuine SUBPROCESS boot instead of an in-process call, so the dev-refuse
 * decision gets one real, executed, out-of-process test against a REAL
 * database and a REAL on-disk journal — not a stub. It calls the EXACT same
 * production functions `src/index.ts` calls for its migration gate
 * (`checkMigrationState`, `decideBootMigrationAction`), with the same
 * "refuse ⇒ non-zero exit naming the tag + migrate command, else warn/ok"
 * branching — only the DB CLIENT differs (postgres-js here, Neon there).
 *
 * Inputs: `DATABASE_URL` (required) and `NODE_ENV` (defaults to
 * "development", matching `src/index.ts`'s own default posture) — nothing
 * else is read. Never calls drizzle's `migrate()` (same read-only contract
 * as `checkMigrationState` itself).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { decideBootMigrationAction } from "../boot-migration-check.js";
import { checkMigrationState } from "../db/migration-state.js";
import * as schema from "../db/schema/index.js";
import type { Env } from "../env.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[migration-gate-harness] DATABASE_URL is not configured");
  process.exit(2);
}

const nodeEnv = (process.env.NODE_ENV ?? "development") as Env["NODE_ENV"];

const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
try {
  const db = drizzle({ client, schema });
  const state = await checkMigrationState(db);
  const decision = decideBootMigrationAction(nodeEnv, state);
  if (decision.action === "refuse") {
    console.error(decision.message);
    process.exitCode = 1;
  } else {
    if (decision.action === "warn") console.warn(`[boot] ${decision.message}`);
    process.stdout.write("migration-gate-harness: booted\n");
  }
} finally {
  await client.end({ timeout: 1 });
}
