/**
 * Real-Postgres fixtures for the B-28 migration-state suite
 * (`db/migration-state.db.test.ts`) — never a mock (ADR-006 rule 4).
 *
 * NOT wired through the real `src/index.ts` composition root as a
 * subprocess: `getDb()` (`db/index.ts`) always uses the Neon serverless
 * WebSocket `Pool`, which speaks Neon's proxy protocol and cannot reach a
 * vanilla Postgres (testcontainers included) without a WS↔TCP proxy this
 * repo doesn't run — the same reason every other DB suite (`fresh-install`,
 * the trips/places/etc. `.db.test.ts` files) drives `createApp` with an
 * in-process `postgres-js` `db` injected directly, never through
 * `src/index.ts`. `boot-shape.test.ts`'s composition-root arms stay
 * deliberately DB-free for the identical reason (its own header comment).
 * `checkMigrationState` itself is driver-agnostic (`DbClient =
 * PgDatabase<PgQueryResultHKT, ...>`), so exercising it here over
 * `postgres-js` is prod-shaped for the COMPARISON logic; the boot-time
 * refuse/warn DECISION is proven separately and exhaustively, with no I/O,
 * in `boot-migration-check.test.ts`.
 */
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { inject } from "vitest";
import * as schema from "../db/schema/index.js";

const REAL_DRIZZLE_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface RawDb {
  uri: string;
  db: PostgresJsDatabase<typeof schema>;
  client: postgres.Sql;
  drop(): Promise<void>;
}

/** A genuinely empty database (NOT `createSuiteDb`'s migrated `gogo_template`) — the "never migrated" shape. Mirrors `suite-db.ts`'s connection plumbing but skips `TEMPLATE`. */
export async function createRawDatabase(name: string): Promise<RawDb> {
  const adminUri = inject("dbAdminUri");
  const dbName = `${name}_${randomBytes(4).toString("hex")}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  const uri = url.toString();
  const client = postgres(uri, { max: 5, onnotice: () => undefined });
  return {
    uri,
    client,
    db: drizzle({ client, schema }),
    drop: async () => {
      await client.end({ timeout: 1 });
      const dropAdmin = postgres(adminUri, { max: 1, onnotice: () => undefined });
      try {
        await dropAdmin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}

export interface BehindDatabase extends RawDb {
  /** The one on-disk migration tag deliberately left unapplied. */
  pendingTag: string;
}

/**
 * A database migrated through every on-disk journal entry EXCEPT the last —
 * built by running the REAL `drizzle-orm` migrator against a scratch copy
 * of `drizzle/` whose journal has its last entry removed (the prescribed
 * "apply a prefix of the journal to a fresh DB" technique). Cleans up its
 * scratch dir itself; `drop()` still needs a separate call to drop the DB.
 */
export async function createDatabaseBehindByOne(name: string): Promise<BehindDatabase> {
  const raw = await createRawDatabase(name);
  const scratchDir = await mkdtemp(join(tmpdir(), "gogo-migrate-prefix-"));
  try {
    await cp(REAL_DRIZZLE_DIR, scratchDir, { recursive: true });
    const journalPath = join(scratchDir, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    if (journal.entries.length < 2) {
      throw new Error("createDatabaseBehindByOne: the on-disk journal needs at least 2 entries");
    }
    const lastEntry = journal.entries.at(-1);
    if (!lastEntry) throw new Error("unreachable — length checked above");
    journal.entries = journal.entries.slice(0, -1);
    await writeFile(journalPath, JSON.stringify(journal, null, 2), "utf8");

    await migrate(drizzle({ client: raw.client }), { migrationsFolder: scratchDir });

    return { ...raw, pendingTag: lastEntry.tag };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
