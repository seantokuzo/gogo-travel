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
 * Server page cap (`SavedPlacesListQuerySchema`: limit max 100). The map
 * needs the FULL pin set — §2.1 sizes for 500-pin trips — so the query
 * follows `nextCursor` to exhaustion (R1 review: one page silently dropped
 * pins >100 AND their itinerary twins, which resolve coordinates through
 * this list).
 */
const SAVED_PLACES_PAGE_LIMIT = 100;

/**
 * Loop bound: 10 pages × 100 = 1000 pins, double the §2.1 sizing — a
 * runaway/cyclic cursor terminates instead of spinning. A truncated read
 * (bound hit) surfaces the remaining cursor truthfully.
 */
const SAVED_PLACES_MAX_PAGES = 10;

/**
 * `GET /trips/:tripId/saved-places` — saved pins + embedded place rows
 * (PL-4), paginated to exhaustion (bounded). The accumulated result keeps
 * the `Paginated` shape (`nextCursor: null` once exhausted) and is rebuilt
 * per fetch — TanStack's structural sharing keeps the array identity stable
 * when the data hasn't changed, which the screen's memo chain rides.
 */
export function useSavedPlaces(
  tripId: string,
): UseQueryResult<Paginated<SavedPlaceWithPlace>, Error> {
  return useQuery({
    queryKey: queryKeys.tripSavedPlaces(tripId),
    queryFn: async ({ signal }) => {
      const items: SavedPlaceWithPlace[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let page: Paginated<SavedPlaceWithPlace>;
      do {
        page = await apiClient.request(
          placeEndpoints.listSavedPlaces,
          {
            params: { tripId },
            query: {
              limit: SAVED_PLACES_PAGE_LIMIT,
              ...(cursor !== undefined ? { cursor } : {}),
            },
          },
          { signal },
        );
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < SAVED_PLACES_MAX_PAGES);
      const result: Paginated<SavedPlaceWithPlace> = { items, nextCursor: page.nextCursor };
      return result;
    },
  });
}
