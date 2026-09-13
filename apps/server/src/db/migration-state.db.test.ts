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
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, inject, it } from "vitest";
import { decideBootMigrationAction } from "../boot-migration-check.js";
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
const REAL_DRIZZLE_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

describe.skipIf(!dockerAvailable)("checkMigrationState — real Postgres shapes (B-28)", () => {
  let suiteDb: SuiteDb | undefined;
  let rawDb: RawDb | BehindDatabase | undefined;
  let journalScratchDir: string | undefined;

  afterEach(async () => {
    await suiteDb?.drop();
    suiteDb = undefined;
    await rawDb?.drop();
    rawDb = undefined;
    if (journalScratchDir) {
      await rm(journalScratchDir, { recursive: true, force: true });
      journalScratchDir = undefined;
    }
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

  it("review round-1 C1 (blocking), against REAL Postgres: a non-monotonic `when` for the unapplied entry still reports it pending", async () => {
    // Reviewer's exact reproduction, run against a REAL Postgres migrated
    // by the REAL drizzle-orm migrator (not a stub): apply every on-disk
    // entry except the last (same technique as `createDatabaseBehindByOne`
    // — the last entry's real `.sql`/hash is never inserted), then read
    // state against a SCRATCH COPY of the full journal whose last entry's
    // `when` has been rewritten to be SMALLER than an already-applied
    // entry's `when` — the exact "renumbered idx, `when` left alone" merge
    // shape. Falsification: reintroducing any `entry.when` comparison into
    // `checkMigrationState` reds this (a watermark check agrees nothing is
    // pending here).
    const behind = await createDatabaseBehindByOne("migration_state_nonmono");
    rawDb = behind;

    journalScratchDir = await mkdtemp(join(tmpdir(), "gogo-migrate-nonmono-"));
    await cp(REAL_DRIZZLE_DIR, journalScratchDir, { recursive: true });
    const journalPath = join(journalScratchDir, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const lastIdx = journal.entries.length - 1;
    const original = journal.entries[lastIdx];
    const previous = journal.entries[lastIdx - 1];
    if (!original || !previous) throw new Error("unreachable — real journal has ≥2 entries");
    expect(original.tag).toBe(behind.pendingTag);
    const rewrittenWhen = previous.when - 1000;
    journal.entries[lastIdx] = { ...original, when: rewrittenWhen };
    expect(rewrittenWhen).toBeLessThan(previous.when);
    await writeFile(journalPath, JSON.stringify(journal, null, 2), "utf8");

    const state = await checkMigrationState(behind.db, {
      journalUrl: pathToFileURL(journalPath),
    });
    expect(state.pending).toEqual([behind.pendingTag]);
    expect(state.applied).toBe(state.onDisk - 1);

    const devDecision = decideBootMigrationAction("development", state);
    expect(devDecision.action).toBe("refuse");
  }, 30_000);
});
