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
 *    text, created_at bigint)`, `created_at` = the journal entry's `when`
 *    (epoch millis) — matches `fresh-install.db.test.ts`'s own pin
 *    (`select count(*) from drizzle.__drizzle_migrations`).
 *
 * 🔴 Driver-shape trap (same family as `db/pg-errors.ts`'s documented one):
 * `db.execute(sql\`...\`)` on the raw-SQL/no-fields path returns the FULL
 * driver result for neon-serverless (`{ rows: [...] }`, node-postgres wire
 * protocol) but the ROW ARRAY DIRECTLY for postgres-js (the test driver) —
 * confirmed by reading both drivers' `session.js` at the pinned version.
 * `extractRows` normalizes both shapes; never destructure `.rows` inline.
 */
import { readFile } from "node:fs/promises";
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
 * Read-only on-disk-vs-applied comparison.
 *
 * Throws `MigrationJournalError` if the journal can't be read/parsed — this
 * check runs BEFORE the database is ever touched, so a broken journal never
 * masquerades as a DB problem.
 *
 * Any OTHER error from the database query (connection refused, auth
 * failure, timeout, …) propagates UNCHANGED — never masked or reworded into
 * a migration-state message (the B-28 landmine: "a DB that is unreachable
 * must still surface the existing connection error"). The ONE database
 * error this function absorbs is "the tracking table/schema doesn't exist"
 * (a database that has never been migrated), which is a legitimate
 * zero-applied state, not a failure.
 */
export async function checkMigrationState(
  db: DbClient,
  options?: { journalUrl?: URL },
): Promise<MigrationState> {
  const entries = await readJournal(options?.journalUrl ?? DEFAULT_JOURNAL_URL);

  let applied = 0;
  let maxCreatedAt = 0;
  try {
    const result = await db.execute(
      sql`select count(*) as count, coalesce(max(created_at), 0) as max_created_at from drizzle.__drizzle_migrations`,
    );
    const rows = extractRows<{ count: unknown; max_created_at: unknown }>(result);
    applied = Number(rows[0]?.count ?? 0);
    maxCreatedAt = Number(rows[0]?.max_created_at ?? 0);
  } catch (err) {
    if (!isUndefinedRelation(err)) throw err;
    applied = 0;
    maxCreatedAt = 0;
  }

  const pending = entries.filter((entry) => entry.when > maxCreatedAt).map((entry) => entry.tag);
  return { onDisk: entries.length, applied, pending };
}

/** The actionable boot/health message: names every pending tag (never just a count) and the exact migrate command. Shared by the dev-refuse and warn-elsewhere paths (`boot-migration-check.ts`) so the two behaviors never drift apart in wording. */
export function formatMigrationStateMessage(state: MigrationState): string {
  const tags = state.pending.join(", ");
  return (
    `database is behind: ${state.pending.length} pending migration(s) [${tags}] ` +
    `(${state.applied}/${state.onDisk} applied) — run \`${MIGRATE_COMMAND}\` to apply them`
  );
}
