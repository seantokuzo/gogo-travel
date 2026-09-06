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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      await client.end();
      const dropAdmin = postgres(adminUri, { max: 1, onnotice: () => undefined });
      try {
        // FORCE (PG13+): a suite's stray extra connection must not leak the
        // clone past the run.
        await dropAdmin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}
