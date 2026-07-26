/**
 * Entry-redirect resolution (T-6.6 / NAV-3; navigation.spec §2.2) — the PURE
 * decision behind `app/index.tsx`, kept side-effect-free so every
 * R-nav-5/6/23 branch is unit-testable without a router or query client:
 *
 *   activeTrips.length == 1 → /[tripId]/today                     (R-nav-6)
 *   activeTrips.length >= 2 → most-recently-viewed active trip's
 *                             today tab; none viewed → /(trips)    (R-nav-23)
 *   else                    → /(trips)                             (R-nav-5)
 *
 * "Most-recently-viewed" is the ONE-slot MMKV stamp (spec §2.2). With ≥2
 * active trips the stamp is honored only when it points INTO the active set:
 * a stamp for a trip that is no longer active — or that this account has no
 * membership in (user switch) — carries no ranking information about the
 * others, so it falls back to the trip list exactly like "never viewed".
 */
import type { ISODate, TripListItem } from "@gogo/shared";

import type { LastViewedTrip } from "./last-viewed-trip";
import { isTripActive } from "./trip-defaults";

export function resolveEntryTarget(
  trips: readonly TripListItem[],
  lastViewed: LastViewedTrip | null,
  today: ISODate,
): string {
  const active = trips.filter((trip) => isTripActive(trip, today));

  if (active.length === 1) return `/${active[0].id}/today`;

  if (active.length >= 2) {
    const viewed =
      lastViewed !== null && active.some((trip) => trip.id === lastViewed.tripId)
        ? lastViewed.tripId
        : null;
    return viewed !== null ? `/${viewed}/today` : "/(trips)";
  }

  return "/(trips)";
}
