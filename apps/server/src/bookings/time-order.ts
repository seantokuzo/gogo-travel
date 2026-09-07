/**
 * The GRANDFATHERED-ROW half of `bookings_time_order_ck` (round-1 B1).
 *
 * `derivedInstantsOf` (bookings/service.ts) mirrors the constraint for the
 * instants a PAYLOAD derives. It cannot see the instants a row already
 * HOLDS — and migration 0003 deliberately re-added the constraint `NOT
 * VALID`, so grace-era rows with genuinely inverted instants survive
 * unchecked. Postgres re-evaluates every CHECK, `NOT VALID` included, against
 * the NEW tuple of every UPDATE, so those rows are update-poison: a
 * details-less `PATCH {"status":"booked"}` rewrites the row carrying the
 * stored inversion and raises 23514.
 *
 * The DB constraint fires on ANY update to such a row regardless of what the
 * service does — nothing here can make those writes succeed (widening the
 * constraint or rewriting the rows is Sean's call, Autonomy trigger #5). What
 * this module does is make the answer an honest, specific 400 instead of a
 * 500 "internal error":
 *
 * - `assertStoredInstantsOrdered` — the pre-write check on the MERGED
 *   instants, so the client gets the reason before the statement runs.
 * - `rethrowTimeOrderCkMapped` — the 23514 → 400 fallback for the UPDATE
 *   paths a validator does not cover (`itinerary/service.ts` `deleteItem`
 *   flips `planned → idea` on the parent booking with no booking-side
 *   validation at all).
 *
 * SCOPE, deliberately narrow: the fallback is wired onto the UPDATE paths
 * only. On an INSERT this constraint can fire for exactly one reason — the
 * service mirror drifted from the migration — which is a bug in our code and
 * must stay a loud 500 (it is the signal `bookings/routes.db.test.ts` reds
 * on; see `db/pg-errors.ts` `isCheckViolationOf`).
 */
import { isCheckViolationOf } from "../db/pg-errors.js";
import { HttpError } from "../http/errors.js";

/** The constraint's name, as Postgres reports it on the wire. */
export const BOOKINGS_TIME_ORDER_CK = "bookings_time_order_ck";

/**
 * The ONE message for "the ROW's stored times are inverted" — distinct from
 * `derivedInstantsOf`'s "the category's primary end time precedes its start
 * time", which is about the PAYLOAD. Two different causes, two different
 * fixes; a client that conflates them tells the user to edit the wrong thing.
 */
export const STORED_INSTANTS_INVERTED_MESSAGE =
  "this booking's stored times are inverted (it was saved before the current time-order rule) — send corrected details in the same request to update it";

/**
 * Same condition, same message — but WHICH layer caught it is diagnostic, not
 * cosmetic: `rejected_by: "constraint"` means the pre-write guard missed a
 * path and Postgres was the last line, which is a bug report, while
 * `rejected_by: "service"` is the designed answer. It also keeps the two
 * fixes independently falsifiable (delete either one and a pin reds).
 */
const REJECTED_BY_SERVICE = {
  details: "stored end before start",
  rejected_by: "service",
} as const;
const REJECTED_BY_CONSTRAINT = {
  details: "stored end before start",
  rejected_by: "constraint",
} as const;

/**
 * Guard the instants an UPDATE is about to WRITE (payload-derived where the
 * request carries details, the row's stored values otherwise). A
 * details-carrying PATCH heals a grandfathered row — its derived instants are
 * ordered — which is exactly the B-9 re-entry flow, so this must not block it.
 */
export function assertStoredInstantsOrdered(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt !== null && endsAt !== null && endsAt.getTime() < startsAt.getTime()) {
    throw new HttpError("VALIDATION_FAILED", STORED_INSTANTS_INVERTED_MESSAGE, REJECTED_BY_SERVICE);
  }
}

/** Is this driver error the `bookings_time_order_ck` 23514? */
export function isTimeOrderCkViolation(error: unknown): boolean {
  return isCheckViolationOf(error, BOOKINGS_TIME_ORDER_CK);
}

/** Rethrow, mapping that 23514 onto the honest 400. Everything else stays loud. */
export function rethrowTimeOrderCkMapped(error: unknown): never {
  if (isTimeOrderCkViolation(error)) {
    throw new HttpError(
      "VALIDATION_FAILED",
      STORED_INSTANTS_INVERTED_MESSAGE,
      REJECTED_BY_CONSTRAINT,
    );
  }
  throw error;
}
