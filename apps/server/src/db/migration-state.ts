/**
 * Migration-state check (B-28, STATE.md "migration-state drift is silent
 * end to end"). Read-only: this module NEVER calls drizzle's `migrate()` —
 * applying migrations is a deliberate `db:migrate` action (Law #6), never an
 * implicit side effect of a boot check or a health-endpoint hit.
 *
 * Applied-migrations bookkeeping, verified two ways for the exact
 * `drizzle-orm@0.45.2` pinned in `apps/server/package.json` (never guessed,
 * per the backend-engineer landmine):
 *  - Context7 (`drizzle-team/drizzle-orm-docs`, "Customize migration log
 *    table and schema"): default `{ table: "__drizzle_migrations", schema:
 *    "drizzle" }`, and `drizzle.config.ts` here does not override either.
 *  - The vendored source itself, `node_modules/.pnpm/drizzle-orm@0.45.2.../
 *    drizzle-orm/pg-core/dialect.js` `PgDialect.migrate()`: one row per
 *    applied migration in `drizzle.__drizzle_migrations(id serial, hash
 *    text NOT NULL, created_at bigint)` — matches
 *    `fresh-install.db.test.ts`'s own pin (`select count(*) from
 *    drizzle.__drizzle_migrations`).
 *
 * 🔴 Review round-1 C1 (blocking) — drift was a TIMESTAMP WATERMARK, and a
 * watermark lies the moment the journal isn't monotonic in `idx` order.
 * Two branches each `drizzle-kit generate`; A's entry stamps `when = T_late`
 * and merges first, B's stamps `when = T_early` and merges second. Resolving
 * the `_journal.json` conflict the normal way (renumber `idx`, leave `when`
 * alone — this repo's parallel-wave workflow makes that a live hazard, not a
 * curiosity) leaves `entries[N].when < entries[N-1].when`. The REAL
 * migrator (`pg-core/dialect.js:56-71`, verified via Context7 AND the
 * vendored source at the pinned version) reads `lastDbMigration` ONCE
 * (`order by created_at desc limit 1`) and skips entry N forever the moment
 * some earlier-applied entry's `created_at` exceeds N's `when` — a WATERMARK
 * (an ordering/threshold comparison against a single max) agrees nothing is
 * pending in that exact shape. The round-1 fix replaced the watermark with a
 * pure BY-HASH set difference (never reading `when` at all) — safe against
 * non-monotonic journals, but it created the round-2 regression below.
 *
 * 🔴 Review round-2 regression (blocking) — a pure by-hash set difference
 * cannot tell "never applied" (pending) apart from "applied, then the file
 * was EDITED afterward" (the hash the migrator recorded no longer matches
 * the on-disk hash): both simply have no matching hash anywhere in
 * `__drizzle_migrations`, so an edited-after-apply migration misread as
 * PENDING — and `development`'s refuse-on-pending posture then refused to
 * boot UNRECOVERABLY (`db:migrate` cannot fix an edited file the migrator
 * already believes it ran; drizzle only ever applies migrations whose
 * `when` it hasn't seen before). Fix: match journal entries to applied rows
 * by `when === created_at` FIRST — an EXACT per-entry equality lookup, NOT
 * a watermark (it is immune to the round-1 non-monotonic-journal shape:
 * equality doesn't care about ordering, only whether some row's
 * `created_at` is bit-for-bit the entry's `when`). Three outcomes per entry:
 *   (a) a row matches `when` AND its hash matches → cleanly applied.
 *   (b) a row matches `when` but its hash DIFFERS → `modified` (the file was
 *       edited after this exact migration ran) — always a WARN, never a
 *       refuse, in every env (`decideBootMigrationAction`): unlike a
 *       genuinely pending migration, no command fixes this.
 *   (c) no row matches `when` at all → genuinely `pending` (never applied).
 * The pre-existing applied-count-mismatch defensive arm (duplicate/orphaned
 * tracking rows that don't map 1:1 onto the journal) still fires for
 * whatever falls outside (a)-(c) — see the `pending.length === 0 && applied
 * !== entries.length` guard below, unchanged from round 1.
 *
 * 🔴 Driver-shape trap (same family as `db/pg-errors.ts`'s documented one):
 * `db.execute(sql\`...\`)` on the raw-SQL/no-fields path returns the FULL
 * driver result for neon-serverless (`{ rows: [...] }`, node-postgres wire
 * protocol) but the ROW ARRAY DIRECTLY for postgres-js (the test driver) —
 * confirmed by reading both drivers' `session.js` at the pinned version.
 * `extractRows` normalizes both shapes; never destructure `.rows` inline.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { MigrationState } from "@gogo/shared/api/health";
import type { DbClient } from "./create-user.js";

export type { MigrationState };

/** Resolves against THIS file's location, so it works from `src/` (tsx/dev)
 * and from `dist/` (built prod) alike — both sit two levels under
 * `apps/server/`, same as `src/test/global-setup.ts`'s identical calc. */
const DEFAULT_JOURNAL_URL = new URL("../../drizzle/meta/_journal.json", import.meta.url);

/** The exact command Sean/CI runs to catch this DB up — `apps/server/package.json`'s `db:migrate` script, filtered from the repo root. */
export const MIGRATE_COMMAND = "pnpm --filter @gogo/server db:migrate";

export interface MigrationJournalEntry {
  tag: string;
  when: number;
}

/** Thrown when `meta/_journal.json` is missing, unreadable, or malformed — distinct from any DB-side failure, so a caller never confuses "we can't read our own migration manifest" with "the database is unreachable". */
export class MigrationJournalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationJournalError";
  }
}

/** SQLSTATEs meaning "the migrations tracking table/schema doesn't exist yet" — a legitimate zero-applied state (a database that has NEVER been migrated), not a connection failure. 42P01 undefined_table (schema exists, table doesn't); 3F000 invalid_schema_name (the `drizzle` schema itself doesn't exist). */
const UNDEFINED_RELATION_SQLSTATES = new Set(["42P01", "3F000"]);

/** Walks the `cause` chain (same pattern as `pg-errors.ts`'s `isCheckViolationOf`) so a wrapped driver error is still recognized. */
function isUndefinedRelation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && UNDEFINED_RELATION_SQLSTATES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Normalizes the neon-serverless (`{ rows }`) vs postgres-js (bare array) `db.execute()` shapes — see module doc. */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(`migration-state: unrecognized db.execute() result shape: ${typeof result}`);
}

/**
 * `__drizzle_migrations.created_at` is `bigint` — postgres-js (the test
 * driver) returns `bigint` columns as a native JS `BigInt` by default
 * (Context7, `porsager/postgres` "Numeric Type Handling": "bigint types are
 * returned as JavaScript BigInt"), while node-postgres-wire drivers
 * (`@neondatabase/serverless`, prod) conventionally return `int8` as a
 * `string` to avoid precision loss. The journal's own `when` is a plain JS
 * `number` (from JSON). Normalize every shape to `number` here so the
 * `when === created_at` matching below is a same-type comparison — these are
 * millisecond epoch stamps, far inside `Number.MAX_SAFE_INTEGER`, so the
 * `bigint`→`number` narrowing never loses precision in practice. Same
 * "throw on an unrecognized shape rather than silently coercing" posture as
 * `extractRows`.
 */
function toCreatedAtMillis(raw: unknown): number {
  if (typeof raw === "bigint" || typeof raw === "number") return Number(raw);
  if (typeof raw === "string") return Number(raw);
  throw new Error(
    `migration-state: unrecognized __drizzle_migrations.created_at shape: ${typeof raw}`,
  );
}

async function readJournal(journalUrl: URL): Promise<MigrationJournalEntry[]> {
  const journalPath = fileURLToPath(journalUrl);
  let raw: string;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch (err) {
    throw new MigrationJournalError(`migration journal unreadable at ${journalPath}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MigrationJournalError(`migration journal at ${journalPath} is not valid JSON`, {
      cause: err,
    });
  }

  const entries: unknown = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) {
    throw new MigrationJournalError(`migration journal at ${journalPath} has no \`entries\` array`);
  }

  return entries.map((entry, index) => {
    const tag = (entry as { tag?: unknown }).tag;
    const when = (entry as { when?: unknown }).when;
    if (typeof tag !== "string" || typeof when !== "number") {
      throw new MigrationJournalError(
        `migration journal at ${journalPath}: entry ${index} is malformed (expected {tag: string, when: number})`,
      );
    }
    return { tag, when };
  });
}

/**
 * `sha256(fileContents)` of `<migrationsRoot>/<tag>.sql` — byte-for-byte the
 * same computation `drizzle-orm/migrator.js`'s `readMigrationFiles` performs
 * (`crypto.createHash("sha256").update(query).digest("hex")` over the same
 * `fs.readFileSync(...).toString()` read), so this always agrees with what a
 * real `db:migrate` run inserted into `__drizzle_migrations.hash`. A missing
 * `.sql` file for an on-disk journal entry is a journal/on-disk integrity
 * problem — thrown as `MigrationJournalError`, same family as a malformed
 * entry, and (like every other journal error) surfaces BEFORE the database
 * is ever touched.
 */
async function hashMigrationFile(migrationsRoot: string, tag: string): Promise<string> {
  const sqlPath = join(migrationsRoot, `${tag}.sql`);
  let contents: string;
  try {
    contents = await readFile(sqlPath, "utf8");
  } catch (err) {
    throw new MigrationJournalError(
      `migration file missing for on-disk journal entry "${tag}": ${sqlPath}`,
      { cause: err },
    );
  }
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Read-only on-disk-vs-applied comparison.
 *
 * Throws `MigrationJournalError` if the journal (or an on-disk `.sql` file
 * it names) can't be read/parsed/hashed — this check runs BEFORE the
 * database is ever touched, so a broken journal never masquerades as a DB
 * problem.
 *
 * Any OTHER error from the database query (connection refused, auth
 * failure, timeout, …) propagates UNCHANGED — never masked or reworded into
 * a migration-state message (the B-28 landmine: "a DB that is unreachable
 * must still surface the existing connection error"). The ONE database
 * error this function absorbs is "the tracking table/schema doesn't exist"
 * (a database that has never been migrated), which is a legitimate
 * zero-applied state, not a failure.
 *
 * Journal entries are matched to applied rows by `when === created_at` FIRST
 * (round-2 fix — see the module doc's "review round-2 regression" for why a
 * pure by-hash set difference isn't enough): a matching row with the SAME
 * hash is cleanly `applied`; a matching row with a DIFFERENT hash is
 * `modified` (edited after it ran — always a warn, never pending, never a
 * refuse reason); no matching row at all is genuinely `pending`. The
 * pre-existing applied/on-disk COUNT-mismatch defensive arm (review round-1
 * C1: duplicate/orphaned tracking rows that don't map 1:1 onto the journal)
 * still fires for whatever falls outside that three-way split. `checkedAt`
 * stamps when THIS read happened (ISO-8601, R-shared-11) — `/health`
 * (`app.ts`) recomputes this at most once per TTL instead of freezing the
 * boot-time value forever.
 */
export async function checkMigrationState(
  db: DbClient,
  options?: { journalUrl?: URL },
): Promise<MigrationState> {
  const journalUrl = options?.journalUrl ?? DEFAULT_JOURNAL_URL;
  const journalPath = fileURLToPath(journalUrl);
  // `<journalPath>` is `<migrationsRoot>/meta/_journal.json` — the `.sql`
  // files this check hashes live one level up, directly under
  // `<migrationsRoot>` (matches drizzle-kit's own layout).
  const migrationsRoot = dirname(dirname(journalPath));
  const entries = await readJournal(journalUrl);
  const hashedEntries = await Promise.all(
    entries.map(async (entry) => ({
      tag: entry.tag,
      when: entry.when,
      hash: await hashMigrationFile(migrationsRoot, entry.tag),
    })),
  );

  interface AppliedRow {
    hash: string;
    createdAt: number;
  }
  let appliedRows: AppliedRow[] = [];
  try {
    const result = await db.execute(sql`select hash, created_at from drizzle.__drizzle_migrations`);
    const rows = extractRows<{ hash: unknown; created_at: unknown }>(result);
    appliedRows = rows.map((row) => ({
      hash: String(row.hash),
      createdAt: toCreatedAtMillis(row.created_at),
    }));
  } catch (err) {
    if (!isUndefinedRelation(err)) throw err;
    appliedRows = [];
  }

  const applied = appliedRows.length;

  // Group by `created_at` (not a Map<number,AppliedRow> — a corrupted/
  // duplicated tracking table can carry more than one row for the same
  // journal `when`, and the count-mismatch fallback below needs to see that,
  // not have it silently collapsed).
  const appliedByCreatedAt = new Map<number, AppliedRow[]>();
  for (const row of appliedRows) {
    const bucket = appliedByCreatedAt.get(row.createdAt);
    if (bucket) bucket.push(row);
    else appliedByCreatedAt.set(row.createdAt, [row]);
  }

  const pendingTags: string[] = [];
  const modifiedTags: string[] = [];
  for (const entry of hashedEntries) {
    const matches = appliedByCreatedAt.get(entry.when);
    if (!matches || matches.length === 0) {
      // (c) no applied row was ever recorded for this entry's `when` at all.
      pendingTags.push(entry.tag);
    } else if (!matches.some((row) => row.hash === entry.hash)) {
      // (b) a row DOES exist for this `when`, but none of them carry the
      // CURRENT on-disk hash — the file was edited after it was applied.
      // Never pending (running db:migrate cannot fix this) — see
      // `formatModifiedMigrationsMessage`.
      modifiedTags.push(entry.tag);
    }
    // (a) else: a row matches both `when` AND `hash` — cleanly applied,
    // nothing to record.
  }
  let pending = pendingTags;
  const modified = modifiedTags;

  // Defensive (review round-1 C1, preserved unchanged by the round-2 by-
  // created_at rework): even when every on-disk entry IS accounted for
  // (matched cleanly or modified), a COUNT mismatch — extra/duplicate rows
  // in the tracking table that don't map 1:1 onto the journal — is still
  // drift. Never let that read as "ok" just because every entry matched;
  // `decideBootMigrationAction` branches on `pending`/`modified` alone, so
  // an empty `pending` here MUST mean "truly current or only modified," not
  // "unaccounted for."
  if (pending.length === 0 && applied !== entries.length) {
    pending = [
      `<applied/on-disk count mismatch: applied=${applied}, onDisk=${entries.length} — every on-disk migration matches an applied row, but the counts don't reconcile>`,
    ];
  }

  return {
    onDisk: entries.length,
    applied,
    pending,
    pendingCount: pending.length,
    modified,
    modifiedCount: modified.length,
    checkedAt: new Date().toISOString(),
  };
}

/** The actionable boot/health message: names every pending tag (never just a count) and the exact migrate command. Shared by the dev-refuse and warn-elsewhere paths (`boot-migration-check.ts`) so the two behaviors never drift apart in wording. */
export function formatMigrationStateMessage(state: MigrationState): string {
  const tags = state.pending.join(", ");
  return (
    `database is behind: ${state.pending.length} pending migration(s) [${tags}] ` +
    `(${state.applied}/${state.onDisk} applied) — run \`${MIGRATE_COMMAND}\` to apply them`
  );
}

/**
 * The actionable message for `modified`-after-apply migrations (round-2
 * fix) — deliberately never suggests `MIGRATE_COMMAND`: drizzle's migrator
 * only ever applies a `when` it hasn't recorded before, so re-running it
 * cannot touch an already-applied, edited file. Names every tag so the
 * developer knows exactly which file to restore or replace with a new
 * migration. Always a WARN (`decideBootMigrationAction` never refuses on
 * this alone) — unlike a genuinely pending migration, no command fixes it,
 * so refusing to boot would be unrecoverable.
 */
export function formatModifiedMigrationsMessage(state: MigrationState): string {
  const tags = state.modified.join(", ");
  return (
    `${state.modified.length} migration(s) were edited AFTER being applied [${tags}] — ` +
    `the on-disk file no longer matches the hash recorded when it ran. This is NOT fixed by ` +
    `running the migrate command (drizzle only applies migrations it hasn't recorded before) — ` +
    `restore the original file, or make the change as a NEW migration instead`
  );
}
