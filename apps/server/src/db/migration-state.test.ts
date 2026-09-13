/**
 * Plain unit suite (no Docker) for `migration-state.ts`'s journal handling
 * and its "don't mask a connection error" contract. DB-shaped comparisons
 * (current / behind-by-one / never-migrated) need a real Postgres and live
 * in `migration-state.db.test.ts`.
 *
 * Falsification (R-test-7) is stated per test.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { decideBootMigrationAction } from "../boot-migration-check.js";
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

/** Mirrors drizzle-kit's real layout: `<scratchDir>/meta/_journal.json` with `.sql` files one level up, directly under `<scratchDir>` — `checkMigrationState`'s hash step reads `<scratchDir>/<tag>.sql`. */
async function writeJournal(contents: string): Promise<URL> {
  scratchDir = await mkdtemp(join(tmpdir(), "gogo-migration-journal-"));
  const metaDir = join(scratchDir, "meta");
  await mkdir(metaDir, { recursive: true });
  const path = join(metaDir, "_journal.json");
  await writeFile(path, contents, "utf8");
  return pathToFileURL(path);
}

/** Writes a stub `<tag>.sql` file so `checkMigrationState`'s hash step (sha256 of this exact content, matching `drizzle-orm/migrator.js`) can read it. Call AFTER `writeJournal`, which sets `scratchDir`. Returns the hash so callers can build a matching stub DB row. */
async function writeMigrationFile(
  tag: string,
  contents = `-- ${tag}\nselect 1;\n`,
): Promise<string> {
  if (!scratchDir) throw new Error("writeMigrationFile: call writeJournal first");
  await writeFile(join(scratchDir, `${tag}.sql`), contents, "utf8");
  return createHash("sha256").update(contents).digest("hex");
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
    await writeMigrationFile("0000_ok");
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

describe("checkMigrationState — pending is a HASH set difference, not a timestamp watermark (review round-1 C1, blocking)", () => {
  it("a journal whose `when` is NON-MONOTONIC in idx order, with the last entry genuinely unapplied, still reports it pending", async () => {
    // Reviewer's exact reproduction: two branches each `drizzle-kit
    // generate`; A's entry stamps `when = T_late` and merges first, B's
    // stamps `when = T_early` and merges second. Resolving the
    // `_journal.json` conflict the normal way (renumber `idx`, leave `when`
    // alone) leaves entries[3].when SMALLER than an already-applied entry's
    // `when` — the OLD timestamp-watermark check (`entry.when >
    // maxCreatedAt`) agreed nothing was pending in this exact shape. A
    // hash-based set difference does not, because it never reads `when` at
    // all — this is the falsification: reintroducing a `when` comparison
    // anywhere in `checkMigrationState` would make this red.
    const url = await writeJournal(
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 4000, tag: "0000_a", breakpoints: true },
          { idx: 1, version: "7", when: 5000, tag: "0001_b", breakpoints: true },
          { idx: 2, version: "7", when: 6000, tag: "0002_c", breakpoints: true },
          // Non-monotonic: generated on another branch BEFORE 0000/0001/0002,
          // renumbered to idx 3 on merge, `when` left untouched.
          {
            idx: 3,
            version: "7",
            when: 1000,
            tag: "0003_outstanding_doctor_spectrum",
            breakpoints: true,
          },
        ],
      }),
    );
    const hash0 = await writeMigrationFile("0000_a");
    const hash1 = await writeMigrationFile("0001_b");
    const hash2 = await writeMigrationFile("0002_c");
    await writeMigrationFile("0003_outstanding_doctor_spectrum");

    // 0003 genuinely never applied — only the first three hashes are in the
    // tracking table, regardless of how `when` compares to them.
    const stubDb = {
      execute: () => Promise.resolve([{ hash: hash0 }, { hash: hash1 }, { hash: hash2 }]),
    } as unknown as DbClient;

    const state = await checkMigrationState(stubDb, { journalUrl: url });
    expect(state.onDisk).toBe(4);
    expect(state.applied).toBe(3);
    expect(state.pending).toEqual(["0003_outstanding_doctor_spectrum"]);
    expect(state.pendingCount).toBe(1);

    // And the boot decision built on this state actually reflects the drift.
    const devDecision = decideBootMigrationAction("development", state);
    expect(devDecision.action).toBe("refuse");
    const prodDecision = decideBootMigrationAction("production", state);
    expect(prodDecision.action).toBe("warn");
  });

  it("blocking: applied !== onDisk with an EMPTY by-hash `pending` is still drift — never `ok`", async () => {
    // Falsification: removing the count-mismatch fallback (or reverting to
    // `pending.length === 0` alone deciding "ok") makes this resolve
    // `pending: []` and `decideBootMigrationAction` return `{action: "ok"}` —
    // exactly the silent-green outcome C1 exists to close.
    const url = await writeJournal(JSON.stringify({ entries: [{ tag: "0000_a", when: 1 }] }));
    const hash0 = await writeMigrationFile("0000_a");
    // Two applied rows share the SAME hash as the one on-disk migration — a
    // duplicate/orphaned row the on-disk journal doesn't account for.
    const stubDb = {
      execute: () => Promise.resolve([{ hash: hash0 }, { hash: hash0 }]),
    } as unknown as DbClient;

    const state = await checkMigrationState(stubDb, { journalUrl: url });
    expect(state.onDisk).toBe(1);
    expect(state.applied).toBe(2);
    expect(state.pending.length).toBeGreaterThan(0);
    expect(state.pendingCount).toBe(state.pending.length);

    const decision = decideBootMigrationAction("development", state);
    expect(decision.action).not.toBe("ok");
  });
});

describe("checkMigrationState — driver-shape normalization (architecture review round-1 #1: neon `{rows}` branch was untested)", () => {
  it("a bare row array (postgres-js) and a `{ rows: [...] }` result (neon-serverless) normalize identically", async () => {
    const url = await writeJournal(JSON.stringify({ entries: [{ tag: "0000_a", when: 1 }] }));
    const hash = await writeMigrationFile("0000_a");

    const bareArrayDb = { execute: () => Promise.resolve([{ hash }]) } as unknown as DbClient;
    const neonShapedDb = {
      execute: () => Promise.resolve({ rows: [{ hash }] }),
    } as unknown as DbClient;

    const [bareResult, neonResult] = await Promise.all([
      checkMigrationState(bareArrayDb, { journalUrl: url }),
      checkMigrationState(neonShapedDb, { journalUrl: url }),
    ]);
    // checkedAt is a real wall-clock stamp on each call — compare everything
    // else for exact equality rather than risk a millisecond-boundary flake.
    const { checkedAt: _bareCheckedAt, ...bareRest } = bareResult;
    const { checkedAt: _neonCheckedAt, ...neonRest } = neonResult;
    expect(neonRest).toEqual(bareRest);
    expect(bareResult).toEqual({
      onDisk: 1,
      applied: 1,
      pending: [],
      pendingCount: 0,
      checkedAt: bareResult.checkedAt,
    });
  });

  it("an unrecognized db.execute() result shape throws instead of silently normalizing to empty", async () => {
    const url = await writeJournal(JSON.stringify({ entries: [{ tag: "0000_a", when: 1 }] }));
    await writeMigrationFile("0000_a");
    const weirdDb = {
      execute: () => Promise.resolve("not-an-array-or-rows-object"),
    } as unknown as DbClient;
    await expect(checkMigrationState(weirdDb, { journalUrl: url })).rejects.toThrow(
      /unrecognized db\.execute\(\) result shape/,
    );
  });
});

describe("checkMigrationState — empty journal (testing.md #2 empty/zero-row arm)", () => {
  it('boundary: `{"entries": []}` with zero applied rows → onDisk 0, applied 0, pending [] — a brand-new, unmigrated journal is NOT drift', async () => {
    const url = await writeJournal(JSON.stringify({ entries: [] }));
    const stubDb = { execute: () => Promise.resolve([]) } as unknown as DbClient;
    const state = await checkMigrationState(stubDb, { journalUrl: url });
    expect(state.onDisk).toBe(0);
    expect(state.applied).toBe(0);
    expect(state.pending).toEqual([]);
    expect(state.pendingCount).toBe(0);
    expect(typeof state.checkedAt).toBe("string");
    expect(decideBootMigrationAction("development", state)).toEqual({ action: "ok" });
  });
});

describe("formatMigrationStateMessage", () => {
  it("names every pending tag (not just a count) and the exact migrate command", () => {
    const message = formatMigrationStateMessage({
      onDisk: 4,
      applied: 2,
      pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
      pendingCount: 2,
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(message).toContain("0002_lowly_venom");
    expect(message).toContain("0003_outstanding_doctor_spectrum");
    expect(message).toContain(MIGRATE_COMMAND);
    expect(message).toContain("2/4");
  });
});
