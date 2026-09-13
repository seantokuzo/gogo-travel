/**
 * `checkMigrationState` against real Postgres shapes (B-28, testing-overhaul
 * ADR-006 rule 4 — "run against something prod-shaped"). Uses the shared
 * container from `src/test/global-setup.ts` (Docker-less local = loud skip,
 * CI = hard fail — unchanged posture); DB shapes come from
 * `src/test/migration-fixtures.ts`. NOT driven through the real
 * `src/index.ts` composition root — see that file's docblock for why
 * (`getDb()`'s Neon WebSocket driver can't reach a vanilla Postgres). The
 * boot-time refuse/warn DECISION is proven separately, with no I/O, in
 * `boot-migration-check.test.ts`.
 *
 * Three shapes, each a real database, none mocked:
 *  - `current` — a fully-migrated clone (`createSuiteDb`'s template).
 *  - `never migrated` — a brand-new database with no `drizzle` schema at
 *    all, exercising the undefined-relation catch path for REAL (not just
 *    the journal-side unit tests in `migration-state.test.ts`).
 *  - `behind by one` — see `migration-fixtures.ts`'s `createDatabaseBehindByOne`.
 *
 * Falsification (R-test-7) stated per test.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, inject, it } from "vitest";
import { checkMigrationState } from "./migration-state.js";
import {
  createDatabaseBehindByOne,
  createRawDatabase,
  type BehindDatabase,
  type RawDb,
} from "../test/migration-fixtures.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

const dockerAvailable = inject("dbAvailable");
const REAL_JOURNAL_URL = new URL("../../drizzle/meta/_journal.json", import.meta.url);

describe.skipIf(!dockerAvailable)("checkMigrationState — real Postgres shapes (B-28)", () => {
  let suiteDb: SuiteDb | undefined;
  let rawDb: RawDb | BehindDatabase | undefined;

  afterEach(async () => {
    await suiteDb?.drop();
    suiteDb = undefined;
    await rawDb?.drop();
    rawDb = undefined;
  });

  it("current: a fully-migrated clone reports zero pending, applied === onDisk", async () => {
    suiteDb = await createSuiteDb("migration_state_current");
    const state = await checkMigrationState(suiteDb.db);

    const realJournal = JSON.parse(await readFile(fileURLToPath(REAL_JOURNAL_URL), "utf8")) as {
      entries: unknown[];
    };
    expect(state.onDisk).toBe(realJournal.entries.length);
    expect(state.applied).toBe(realJournal.entries.length);
    expect(state.pending).toEqual([]);
  }, 60_000);

  it("never migrated: a brand-new database with no `drizzle` schema at all — applied 0, EVERY on-disk migration pending (the undefined-relation catch path)", async () => {
    rawDb = await createRawDatabase("migration_state_never");
    const state = await checkMigrationState(rawDb.db);

    // Falsification: removing the undefined-relation (42P01/3F000) catch
    // in `checkMigrationState` makes this reject instead of resolve —
    // `db.execute` throws on the missing `drizzle.__drizzle_migrations`
    // relation, and without the catch that throw is not absorbed.
    expect(state.applied).toBe(0);
    expect(state.pending.length).toBe(state.onDisk);
    expect(state.pending.length).toBeGreaterThan(0);
  }, 30_000);

  it("behind by one: migrated through every on-disk entry EXCEPT the last — that tag is the sole pending one", async () => {
    const behind = await createDatabaseBehindByOne("migration_state_behind");
    rawDb = behind;
    const state = await checkMigrationState(behind.db);

    expect(state.pending).toEqual([behind.pendingTag]);
    expect(state.applied).toBe(state.onDisk - 1);
  }, 30_000);
});
