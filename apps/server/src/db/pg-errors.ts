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
