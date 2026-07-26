/**
 * Trip default-tab rules (T-6.6 / NAV-3; navigation.spec §2.5).
 *
 * `tripIsActive(trip) = trip.status == 'active' && today ∈ [start, end]`
 * verbatim: the server's EFFECTIVE status (date-derived unless the owner
 * override wins, R-db-19) must say active AND the date window must hold in
 * the USER's timezone — re-checked client-side through the shared
 * `deriveTripStatus` so the boundary day can never drift between server and
 * client (the single-definition seam the trips spec mandates).
 */
import { deriveTripStatus, type ISODate, type Trip } from "@gogo/shared";

/** The fields §2.5 reads — both `Trip` and `TripListItem` satisfy it. */
export type TripStatusFields = Pick<Trip, "status" | "start_date" | "end_date">;

/** Today's date in the DEVICE timezone as an ISO `YYYY-MM-DD` (§2.5). */
export function localTodayISO(): ISODate {
  const now = new Date();
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** §2.5 `tripIsActive` — effective status AND local date window agree. */
export function isTripActive(trip: TripStatusFields, today: ISODate): boolean {
  return (
    trip.status === "active" && deriveTripStatus(today, trip.start_date, trip.end_date) === "active"
  );
}

/** §2.5 `initialTab` — active → today (R-nav-7); planning/past → itinerary (R-nav-8). */
export function initialTabFor(trip: TripStatusFields, today: ISODate): "today" | "itinerary" {
  return isTripActive(trip, today) ? "today" : "itinerary";
}
