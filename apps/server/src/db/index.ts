/**
 * Database client — Neon serverless over WebSocket for prod/dev.
 *
 * 🔴 Landmine #1 (backend-engineer.md): the Neon HTTP driver
 * (`drizzle-orm/neon-http`) has NO transactions — `.transaction()` throws at
 * runtime. This module deliberately uses the WebSocket `Pool` +
 * `drizzle-orm/neon-serverless`, which IS transaction-capable, so atomic
 * multi-writes (expense + shares, user + entitlements) work in prod exactly
 * like they do on the `postgres-js` test harness. Do not "optimize" this to
 * the HTTP driver.
 *
 * Tests use `postgres-js` against an ephemeral testcontainers Postgres
 * (ADR-004) — see `src/db/constraints.test.ts`.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { loadEnv } from "../env.js";
import * as schema from "./schema/index.js";

export type Db = NeonDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

/**
 * Lazily create (and memoize) the app database client. Throws if
 * `DATABASE_URL` is not configured — callers get a hard, early failure
 * instead of a hanging pool.
 */
export function getDb(): Db {
  if (db) return db;

  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured — cannot create a database client");
  }

  // Node has no global WebSocket wired into the Neon driver — inject `ws`.
  neonConfig.webSocketConstructor = ws;
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    // Fail fast on acquisition instead of queueing handlers forever when the
    // pool is saturated or the DB is unreachable (node-postgres default is
    // 0 = wait indefinitely — a request-hang footgun under load).
    connectionTimeoutMillis: 10_000,
  });
  db = drizzle({ client: pool, schema });
  return db;
}

/** Close the pool (graceful shutdown / test teardown). */
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

export { schema };
