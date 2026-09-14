/**
 * T-S3.3 (testing-overhaul spec §3.3, R-test-6) — per-suite database clones
 * off the shared container's migrated template (`src/test/global-setup.ts`).
 *
 * `createSuiteDb(name)` runs `CREATE DATABASE "<name>_<nonce>" TEMPLATE
 * gogo_template` through the container's admin database — a near-instant
 * file-level copy carrying the full migrated schema plus the drizzle
 * journal — and hands back the exact client/db shape every suite used to
 * build for itself (`postgres-js`, pool max 5, notices silenced, drizzle
 * over the full schema). `drop()` ends the pool and force-drops the clone.
 *
 * Isolation is HARD (separate databases, not rollback discipline — ADR-006
 * alternative 5), proven by `suite-db-isolation-{a,b}.db.test.ts`: two
 * parallel suites insert the same primary key and both succeed.
 *
 * Falsification (R-test-7): make `createSuiteDb` reuse one database name (or
 * return the template itself) and the isolation probes go red on a PK
 * collision; skip the template migration in global setup and every consumer
 * reds out on missing relations.
 *
 * QUEUE "Shared PG container afterAll teardown timeout under concurrent
 * gates" — `drop()` is bounded and tolerant: under heavy machine load (many
 * worktrees' gates running at once, Docker Desktop VM pegged) ending the
 * pool or dropping the clone can itself stall past a sane wait. Each step
 * below is raced against its own timeout; a step that doesn't finish in time
 * (or rejects) logs ONE warning and the drop still resolves — it never
 * throws and never hangs `afterAll` past vitest's `hookTimeout`
 * (`vitest.config.ts`). This is safe because the clone lives on a throwaway
 * testcontainers Postgres that global teardown (`global-setup.ts`) stops
 * outright at end of run: a clone that outlives one suite's drop is disk
 * noise on a box about to disappear, never a resource leak that persists.
 * Suite ISOLATION (separate databases per suite, proven by
 * `suite-db-isolation-{a,b}.db.test.ts`) is unaffected — isolation is
 * established at `CREATE DATABASE` time in `createSuiteDb`, not at drop
 * time; a slow/failed drop never lets two suites share a database.
 *
 * Falsification (this queue item): remove the bound from
 * `boundedTolerantTeardown` (just `await step()` with no race) and
 * `suite-db-teardown.test.ts`'s hung-`end()` pin goes RED — it stops
 * resolving within the test's own timeout instead of settling within the
 * configured bound.
 */
import { randomBytes } from "node:crypto";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { inject } from "vitest";
import * as schema from "../db/schema/index.js";

export interface SuiteDb {
  /** Connection URI of this suite's private clone. */
  uri: string;
  /** postgres-js pool on the clone — same options the suites always used. */
  client: postgres.Sql;
  /** Drizzle over the full app schema, on the same pool. */
  db: PostgresJsDatabase<typeof schema>;
  /** End the pool and force-drop the clone. Safe to call once in afterAll. */
  drop(): Promise<void>;
}

/** Postgres identifiers cap at 63 bytes; leave room for the `_<nonce>`. */
const MAX_NAME_LENGTH = 40;

/** SQLSTATE 55006 object_in_use — a concurrent clone briefly holds the template. */
const OBJECT_IN_USE = "55006";
const CREATE_RETRY_LIMIT = 20;
const CREATE_RETRY_DELAY_MS = 250;

// Bound + tolerance budgets for `drop()` (QUEUE "Shared PG container afterAll
// teardown timeout"). `postgres-js`'s own `end({ timeout })` is in SECONDS
// and, on expiry, destroys sockets rather than leaving them dangling — but
// we additionally race every step ourselves so a step that never calls back
// at all (the failure mode under extreme load) can't out-wait its budget.
const POOL_END_TIMEOUT_MS = 5_000;
const DROP_STATEMENT_TIMEOUT_MS = 5_000;
const ADMIN_POOL_END_TIMEOUT_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Race `step` against `timeoutMs`. Never throws and never hangs past the
 * bound: a step that times out or rejects logs exactly ONE warning
 * (`console.warn` — test-infra diagnostics, not the app-code ban in
 * `.claude/rules/server.md`) and `drop()` moves on. Exported so
 * `suite-db-teardown.test.ts` can pin the bound directly against a
 * never-settling promise without needing Docker.
 *
 * Falsification: replace the body with a bare `await step()` (no race) and
 * the teardown test's hung-`end()` pin goes RED — it stops resolving within
 * its own test timeout.
 */
export async function boundedTolerantTeardown(
  label: string,
  step: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
    timer.unref?.();
  });

  try {
    const raced = await Promise.race([step().then(() => false as const), timedOut]);
    if (raced === true) {
      console.warn(
        `createSuiteDb: ${label} exceeded ${timeoutMs}ms — continuing. ` +
          "The clone lives on a throwaway testcontainers Postgres that global " +
          "teardown stops outright at end of run, so an unfinished teardown " +
          "step here is disk noise on a box about to disappear, not a leak.",
      );
    }
  } catch (error) {
    console.warn(
      `createSuiteDb: ${label} failed — continuing. ` +
        `The clone lives on a throwaway testcontainers Postgres that global ` +
        `teardown stops outright at end of run. ${describeError(error)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_NAME_LENGTH);
  if (cleaned.length === 0) {
    throw new Error(`createSuiteDb: name ${JSON.stringify(name)} sanitizes to nothing`);
  }
  return /^[a-z]/.test(cleaned) ? cleaned : `db_${cleaned}`;
}

/**
 * Clone a private database off the migrated template and connect to it.
 * Call from `beforeAll` (guarded by `describe.skipIf(!inject("dbAvailable"))`)
 * and `await suiteDb.drop()` in `afterAll`.
 */
export async function createSuiteDb(name: string): Promise<SuiteDb> {
  const adminUri = inject("dbAdminUri");
  const templateName = inject("dbTemplateName");
  if (!inject("dbAvailable") || !adminUri || !templateName) {
    throw new Error(
      "createSuiteDb: no shared container this run (Docker unavailable). " +
        'Guard the suite with `describe.skipIf(!inject("dbAvailable"))` so it ' +
        "skips instead of reaching this.",
    );
  }

  // Nonce so watch-mode re-runs and duplicate suite names can never collide;
  // the sanitized prefix keeps `docker exec … psql \l` debuggable.
  const dbName = `${sanitizeName(name)}_${randomBytes(4).toString("hex")}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => undefined });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${templateName}"`);
        break;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === OBJECT_IN_USE && attempt < CREATE_RETRY_LIMIT) {
          await sleep(CREATE_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }
  } finally {
    await admin.end();
  }

  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  const uri = url.toString();

  const client = postgres(uri, { max: 5, onnotice: () => undefined });
  const db = drizzle({ client, schema });

  return {
    uri,
    client,
    db,
    drop: async () => {
      // Bounded + tolerant (see the constants/helper above): end the clone's
      // own pool first so it holds no connections against itself, then drop
      // it via a SEPARATE admin connection with a server-side
      // `statement_timeout` so a wedged DROP can't hang past our own race
      // either. Any step that stalls or fails logs once and we move on —
      // isolation is guaranteed at CREATE time, not here.
      await boundedTolerantTeardown(
        `pool close for suite db "${dbName}"`,
        () => client.end({ timeout: POOL_END_TIMEOUT_MS / 1000 }),
        POOL_END_TIMEOUT_MS,
      );

      const dropAdmin = postgres(adminUri, {
        max: 1,
        onnotice: () => undefined,
        // Server-side backstop: if the DROP itself wedges (e.g. FORCE can't
        // immediately terminate a backend under load), Postgres cancels the
        // statement rather than our client waiting on a socket forever.
        connection: { statement_timeout: DROP_STATEMENT_TIMEOUT_MS },
      });
      try {
        await boundedTolerantTeardown(
          `DROP DATABASE "${dbName}" WITH (FORCE)`,
          // FORCE (PG13+): a suite's stray extra connection must not leak the
          // clone past the run.
          () => dropAdmin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`),
          // Headroom over the server-side statement_timeout so that error
          // (not our own race) is normally what resolves this step.
          DROP_STATEMENT_TIMEOUT_MS + 2_000,
        );
      } finally {
        await boundedTolerantTeardown(
          `admin pool close after dropping "${dbName}"`,
          () => dropAdmin.end({ timeout: ADMIN_POOL_END_TIMEOUT_MS / 1000 }),
          ADMIN_POOL_END_TIMEOUT_MS,
        );
      }
    },
  };
}
