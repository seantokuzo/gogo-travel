/**
 * Plain unit suite (no Docker) for `migration-state.ts`'s journal handling
 * and its "don't mask a connection error" contract. DB-shaped comparisons
 * (current / behind-by-one / never-migrated) need a real Postgres and live
 * in `migration-state.db.test.ts`.
 *
 * Falsification (R-test-7) is stated per test.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";
import {
  checkMigrationState,
  formatMigrationStateMessage,
  MIGRATE_COMMAND,
  MigrationJournalError,
} from "./migration-state.js";
import type { DbClient } from "./create-user.js";

/** A db that throws if ever queried — proves a journal-error short-circuits BEFORE the database is touched (the intended ordering: fix the journal, don't chase a phantom connection problem). */
const UNTOUCHABLE_DB = {
  execute: () => {
    throw new Error(
      "migration-state.test: db must never be queried when the journal read fails first",
    );
  },
} as unknown as DbClient;

let scratchDir: string | undefined;

afterEach(async () => {
  if (scratchDir) {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

async function writeJournal(contents: string): Promise<URL> {
  scratchDir = await mkdtemp(join(tmpdir(), "gogo-migration-journal-"));
  const path = join(scratchDir, "_journal.json");
  await writeFile(path, contents, "utf8");
  return pathToFileURL(path);
}

describe("checkMigrationState — journal errors (short-circuit before the DB, R-test-2 §5 landmine)", () => {
  it("error: journal file missing → MigrationJournalError naming the path, DB never queried", async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "gogo-migration-journal-"));
    const missing = pathToFileURL(join(scratchDir, "does-not-exist.json"));
    const error = await checkMigrationState(UNTOUCHABLE_DB, { journalUrl: missing }).then(
      () => {
        throw new Error("expected a missing journal to throw");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationJournalError);
    expect((error as Error).message).toContain("does-not-exist.json");
  });

  it("adversarial: journal is not valid JSON → MigrationJournalError, DB never queried", async () => {
    const url = await writeJournal("{ not json ");
    const error = await checkMigrationState(UNTOUCHABLE_DB, { journalUrl: url }).then(
      () => {
        throw new Error("expected malformed JSON to throw");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationJournalError);
    expect((error as Error).message).toMatch(/not valid JSON/);
  });

  it("adversarial: journal has no `entries` array → MigrationJournalError", async () => {
    const url = await writeJournal(JSON.stringify({ version: "7" }));
    const error = await checkMigrationState(UNTOUCHABLE_DB, { journalUrl: url }).then(
      () => {
        throw new Error("expected a missing `entries` array to throw");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationJournalError);
    expect((error as Error).message).toMatch(/entries/);
  });

  it("adversarial: a malformed entry (no tag / non-numeric `when`) → MigrationJournalError naming the index", async () => {
    const url = await writeJournal(
      JSON.stringify({
        entries: [
          { tag: "0000_ok", when: 1 },
          { tag: "0001_bad", when: "not-a-number" },
        ],
      }),
    );
    const error = await checkMigrationState(UNTOUCHABLE_DB, { journalUrl: url }).then(
      () => {
        throw new Error("expected a malformed entry to throw");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationJournalError);
    expect((error as Error).message).toContain("entry 1");
  });
});

describe("checkMigrationState — a DB that is unreachable surfaces the REAL connection error (B-28 don't-mask landmine)", () => {
  it("error: connection refused propagates UNCHANGED — never reworded into a migration-state message", async () => {
    // A valid one-entry journal so we actually reach the database query.
    const url = await writeJournal(JSON.stringify({ entries: [{ tag: "0000_ok", when: 1 }] }));
    // Port 1 is privileged/unassigned — nothing listens there, so this fails
    // fast with a genuine connection error rather than hanging.
    const client = postgres("postgresql://baduser:badpass@127.0.0.1:1/nonexistent-gogo-db", {
      max: 1,
      connect_timeout: 2,
    });
    const db = drizzle({ client, schema }) as unknown as DbClient;
    try {
      const error = await checkMigrationState(db, { journalUrl: url }).then(
        () => {
          throw new Error("expected an unreachable database to throw");
        },
        (e: unknown) => e,
      );
      // Falsification: swallowing every db.execute() error (instead of only
      // the undefined-relation SQLSTATEs) would make this resolve to
      // {applied: 0, ...} instead of throwing — this pin catches that.
      expect(error).not.toBeInstanceOf(MigrationJournalError);
      expect(error).toBeInstanceOf(Error);
      // Drizzle wraps the raw driver error as `Failed query: ...` with the
      // ORIGINAL connection error preserved unmodified on `.cause` — walk it
      // rather than asserting on the top-level message alone, matching how
      // `pg-errors.ts`'s own cause-walkers treat wrapped driver errors.
      const top = error as Error;
      expect(top.message.toLowerCase()).not.toMatch(/pending migration/);
      const cause = top.cause;
      expect(cause).toBeInstanceOf(Error);
      const causeError = cause as NodeJS.ErrnoException;
      expect(causeError.code).toBe("ECONNREFUSED");
      expect(causeError.message.toLowerCase()).toMatch(/connect|refused/);
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 10_000);
});

describe("formatMigrationStateMessage", () => {
  it("names every pending tag (not just a count) and the exact migrate command", () => {
    const message = formatMigrationStateMessage({
      onDisk: 4,
      applied: 2,
      pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
    });
    expect(message).toContain("0002_lowly_venom");
    expect(message).toContain("0003_outstanding_doctor_spectrum");
    expect(message).toContain(MIGRATE_COMMAND);
    expect(message).toContain("2/4");
  });
});
