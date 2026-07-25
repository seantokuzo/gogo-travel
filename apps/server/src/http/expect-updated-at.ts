/**
 * `expect_updated_at` optimistic-concurrency precondition (trips spec §3.5
 * rule 2, R-trips-6) — the REUSABLE seam every domain's "conflict detection
 * where it matters" PATCH uses. The doctrine is row-grain LWW (§3.5 rule 1);
 * this precondition is the opt-in guard for the visible-cost collisions
 * (multi-field, slow-editing forms).
 *
 * Shape: the check rides INSIDE the UPDATE's own WHERE clause — never a
 * read-then-write (a check outside the statement is a TOCTOU window where a
 * concurrent commit slips between check and write). A guarded UPDATE that
 * matches zero rows then resolves via `throwGuardedUpdateMiss`: the row still
 * exists ⇒ the precondition failed (`CONFLICT`, nothing written — R-trips-6);
 * the row is gone ⇒ `NOT_FOUND` (deletes converge, §3.5 rule 3).
 *
 * 🔴 Precision landmine (why `date_trunc`): `timestamptz` stores MICROSECONDS
 * (`defaultNow()` = `now()` keeps them) but the wire is millisecond-precision
 * (`Date#toISOString`). A naive `updated_at = $expect` therefore false-
 * conflicts on every row whose stored timestamp carries sub-millisecond
 * digits — e.g. any row never updated since insert. Both sides are compared
 * at millisecond grain: `date_trunc('milliseconds', col)` vs the parsed
 * client value (JS `Date` is inherently ms-grained).
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { HttpError, NOT_FOUND_MESSAGE } from "./errors.js";

/** The ONE message every stale-precondition 409 carries, across domains. */
export const STALE_UPDATED_AT_MESSAGE = "the row changed since it was read";

/**
 * Machine-readable reason in the 409 `details` — clients branch on it to
 * show a "somebody else saved first — refresh" state.
 */
export const STALE_UPDATED_AT_REASON = "stale_updated_at";

/**
 * Build the WHERE fragment enforcing the precondition, or `undefined` when
 * the client sent no `expect_updated_at` (plain LWW applies — R-trips-5).
 * AND it into the UPDATE alongside the row-identity predicate.
 *
 * `expect` has already passed `ISODateTimeSchema` at the boundary, so
 * `new Date(expect)` is always a valid instant — never `Invalid Date`. It is
 * bound as a normalized ISO STRING with an explicit `::timestamptz` cast: a
 * raw `Date` param inside a drizzle `sql` template bypasses column-driven
 * driver mapping and postgres-js rejects it (`ERR_INVALID_ARG_TYPE`); the
 * `toISOString()` round-trip also canonicalizes any client offset form to
 * UTC millisecond grain, matching the truncated column side.
 */
export function expectUpdatedAtPrecondition(
  updatedAtColumn: AnyPgColumn,
  expect: string | undefined,
): SQL | undefined {
  if (expect === undefined) return undefined;
  return sql`date_trunc('milliseconds', ${updatedAtColumn}) = ${new Date(expect).toISOString()}::timestamptz`;
}

/**
 * Resolve a guarded UPDATE that matched zero rows. The caller re-reads row
 * existence (inside the same transaction) and passes it here:
 *
 *  - row still exists → the precondition failed: `CONFLICT`, nothing written
 *    (R-trips-6). Details carry `STALE_UPDATED_AT_REASON`.
 *  - row is gone → a concurrent delete won: `NOT_FOUND`, the §3.5-rule-3
 *    convergent answer (clients treat post-DELETE 404 as success-equivalent).
 */
export function throwGuardedUpdateMiss(rowStillExists: boolean): never {
  if (rowStillExists) {
    throw new HttpError("CONFLICT", STALE_UPDATED_AT_MESSAGE, {
      reason: STALE_UPDATED_AT_REASON,
    });
  }
  throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);
}
