/**
 * The ONE home for "which SQLSTATEs mean a foreign-key violation" (B-24).
 *
 * PG ≤ 17 raised 23503 (`foreign_key_violation`) for EVERY FK failure. PG 18
 * reclassified `ON DELETE/UPDATE RESTRICT` enforcement to 23001
 * (`restrict_violation`) and reworded the message ("violates RESTRICT setting
 * of foreign key constraint"). Prod is Neon Postgres 18.6 — a 23503-only
 * check turns every RESTRICT-delete 409 into a 500, invisibly, while a PG 17
 * test image stays green (the B-24 bug, probe-verified by the PR #32
 * resurrection).
 *
 * Every FK-violation walker (places `fkViolationTable`, the constraint-precise
 * race-recovery predicates in bookings/expenses/itinerary/saved-places/
 * travel-legs) consumes THIS predicate. Never compare `code === "23503"`
 * inline again — the next SQLSTATE reclassification should be a one-line fix
 * here, inherited everywhere.
 */
export const FK_VIOLATION_SQLSTATES: ReadonlySet<string> = new Set(["23503", "23001"]);

/** Is this driver error `code` an FK-violation SQLSTATE (either vintage)? */
export function isFkViolationCode(code: unknown): boolean {
  return typeof code === "string" && FK_VIOLATION_SQLSTATES.has(code);
}

/**
 * Postgres 23514 (`check_violation`) — what a CHECK constraint raises. No
 * cross-version drift here; the constant exists so the code, like
 * `FK_VIOLATION_SQLSTATES`, is never compared inline at a call site.
 */
export const CHECK_VIOLATION_SQLSTATE = "23514";

/**
 * Is this driver error a CHECK violation of EXACTLY `constraintName`?
 *
 * Constraint-PRECISE on purpose (the `isPlaceFkViolation` /
 * `isExpenseBookingFkViolation` precedent): a check constraint whose service
 * mirror was supposed to catch the value first must stay LOUD if it ever
 * fires — blanket-mapping 23514 to a 400 would silence exactly the mirror/DB
 * drift the two-file lockstep pins exist to detect.
 *
 * 🔴 Driver trap: postgres-js — the TEST driver — exposes the wire field as
 * `constraint_name`; pg-protocol's `DatabaseError`, what the PROD Neon
 * serverless driver throws, exposes `constraint`. Accept BOTH and walk
 * `cause` for wrapped shapes; no container ever produces the prod shape, so a
 * unit test pins it.
 */
export function isCheckViolationOf(error: unknown, constraintName: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
    };
    if (candidate.code === CHECK_VIOLATION_SQLSTATE) {
      const constraint =
        typeof candidate.constraint_name === "string"
          ? candidate.constraint_name
          : typeof candidate.constraint === "string"
            ? candidate.constraint
            : null;
      return constraint === constraintName;
    }
    current = current.cause;
  }
  return false;
}
