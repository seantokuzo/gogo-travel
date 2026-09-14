/**
 * B-7 part 3 round-1 fix: 23514 → 400 mapping for the three nullable-
 * coordinate CHECK constraints migration 0005 added
 * (`drizzle/0005_nullable_custom_coords.sql`):
 *  - `places_coords_pair_ck` — `(lat IS NULL) = (lng IS NULL)`
 *  - `places_spine_coords_ck` — `source = 'custom' OR lat IS NOT NULL`
 *  - `trips_destination_coords_pair_ck` — same pair shape, on `trips`
 *
 * Same posture as `bookings/time-order.ts`'s 23514 fallback: the Zod
 * `superRefine` pair rules (`place.ts`/`trip.ts`) and the places route's
 * source-aware clearing check (`places/routes.ts`, `customPlaceAccess`'s
 * `spine` branch) already reject every payload that could trip one of these
 * at the boundary — round-1 architecture finding was that the ONE gap
 * (`PlaceUpdateSchema` had no pair refine at all) let a lone-field PATCH
 * reach Postgres unpaired, where the constraint was the last line and its
 * escape was an unhandled `500 INTERNAL` (`createErrorHandler`'s generic
 * arm never saw an `HttpError`). This is the belt: if one of these three
 * ever fires anyway (a future mirror/DB drift bug, same class as
 * `bookings_time_order_ck`'s INSERT case), the client still gets an honest
 * 400 instead of a stack-trace-shaped 500.
 */
import { isCheckViolationOf } from "./pg-errors.js";
import { HttpError } from "../http/errors.js";

export const PLACES_COORDS_PAIR_CK = "places_coords_pair_ck";
export const PLACES_SPINE_COORDS_CK = "places_spine_coords_ck";
export const TRIPS_DESTINATION_COORDS_PAIR_CK = "trips_destination_coords_pair_ck";

const PAIR_MESSAGE = "lat and lng must both be present or both be null";
const SPINE_MESSAGE = "coordinates cannot be cleared for this place's source";

/** Rethrow, mapping any of the three nullable-coords 23514s onto VALIDATION_FAILED. Everything else stays loud. */
export function rethrowCoordsCkMapped(error: unknown): never {
  if (
    isCheckViolationOf(error, PLACES_COORDS_PAIR_CK) ||
    isCheckViolationOf(error, TRIPS_DESTINATION_COORDS_PAIR_CK)
  ) {
    throw new HttpError("VALIDATION_FAILED", PAIR_MESSAGE, { rejected_by: "constraint" });
  }
  if (isCheckViolationOf(error, PLACES_SPINE_COORDS_CK)) {
    throw new HttpError("VALIDATION_FAILED", SPINE_MESSAGE, { rejected_by: "constraint" });
  }
  throw error;
}
