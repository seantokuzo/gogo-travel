/**
 * Places server-state layer (T-8.2 / MAP-1 — map spec §2.1 "Data").
 *
 * One hook for now: the trip's saved-places list, the map's saved-pin set
 * (R-map-1) and the coordinate source the itinerary pin builder joins
 * against (`features/map/pin-features.ts`). T-8.3/T-8.4 extend THIS module
 * with map search + place detail + save/unsave; the `['place-fresh', id]`
 * fetch-fresh query (§2.4 non-persistence contract) is T-8.4's and does NOT
 * live under any trip key.
 *
 * KEY-CACHE LAW (T-6.7): `tripSavedPlaces` lives under the
 * `["trips", tripId]` DETAIL subtree so the membership guard's 404-scrub and
 * `evictTripSubtree` (prefix removal over `trip(tripId)`) evict it on access
 * loss. NOTHING here touches `["trip-list"]`.
 *
 * Every query forwards TanStack's `{ signal }` (T-6.6 R1 cancellation
 * posture).
 */
import { placeEndpoints, type Paginated, type SavedPlaceWithPlace } from "@gogo/shared";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/**
 * One page at the server cap — the shared-schema posture verbatim
 * (`SavedPlacesListQuerySchema`: "the map wants the full pin set in one page
 * for typical trips; the bound here IS the cap"). Larger pin sets paginate
 * when a surface needs them; the map's v1 read does not.
 */
const SAVED_PLACES_PAGE_LIMIT = 100;

/** `GET /trips/:tripId/saved-places` — saved pins + embedded place rows (PL-4). */
export function useSavedPlaces(
  tripId: string,
): UseQueryResult<Paginated<SavedPlaceWithPlace>, Error> {
  return useQuery({
    queryKey: queryKeys.tripSavedPlaces(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(
        placeEndpoints.listSavedPlaces,
        { params: { tripId }, query: { limit: SAVED_PLACES_PAGE_LIMIT } },
        { signal },
      ),
  });
}
