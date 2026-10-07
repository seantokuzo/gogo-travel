/**
 * Trip default-tab rules (T-6.6 / NAV-3; navigation.spec §2.5).
 *
 * `tripIsActive(trip) = trip.status == 'active' && today ∈ [start, end]`
 * verbatim: the server's EFFECTIVE status (date-derived unless the owner
 * override wins, R-db-19) must say active AND the date window must hold on
 * the trip's DESTINATION calendar — B-30 (Sean ruling 2026-09-19): a trip's
 * "today" is the day at its destination, `todayInZone(now, trip.destination_tz)`
 * (`@gogo/shared/time`, the SAME helper the server evaluates per trip, with
 * the SAME effective zone it serves on the wire). It is re-checked
 * client-side through the shared `deriveTripStatus` so the boundary day can
 * never drift between server and client (the single-definition seam the
 * trips spec mandates). Neither the device zone nor the server's UTC day
 * enters the status clock: a device in Los Angeles at 18:00 on a Tokyo trip's
 * last day sees the trip exactly as the server does.
 *
 * Callers pass the instant (`new Date()`), never a precomputed date, so each
 * trip is judged at its own destination day — one list can hold trips whose
 * calendar days differ.
 */
import { deriveTripStatus, todayInZone, type ISODate, type Trip } from "@gogo/shared";

/** The fields §2.5 reads — both `Trip` and `TripListItem` satisfy it. */
export type TripStatusFields = Pick<Trip, "status" | "start_date" | "end_date" | "destination_tz">;

/**
 * Today's date in the DEVICE timezone as an ISO `YYYY-MM-DD`.
 *
 * NOT the trip-status clock (B-30 — use `tripTodayISO`). Remaining
 * genuinely device-local uses, by decision (T-7.17 territory, outside the
 * 2026-09-19 ruling): the expense form's default `spentAt`
 * (`ExpenseForm`), the itinerary grid's scroll-to-today (`GridSurface`), and
 * test-fixture day offsets for rows that carry no zone.
 */
export function localTodayISO(): ISODate {
  const now = new Date();
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The calendar day at the trip's destination at instant `now` (B-30). */
export function tripTodayISO(trip: Pick<Trip, "destination_tz">, now: Date): ISODate {
  return todayInZone(now, trip.destination_tz);
}

/** §2.5 `tripIsActive` — effective status AND the destination-day window agree. */
export function isTripActive(trip: TripStatusFields, now: Date): boolean {
  return (
    trip.status === "active" &&
    deriveTripStatus(tripTodayISO(trip, now), trip.start_date, trip.end_date) === "active"
  );
}

/** §2.5 `initialTab` — active → today (R-nav-7); planning/past → itinerary (R-nav-8). */
export function initialTabFor(trip: TripStatusFields, now: Date): "today" | "itinerary" {
  return isTripActive(trip, now) ? "today" : "itinerary";
}
