/**
 * Map place search (T-8.3 / MAP-2 — R-map-25): the spine-search hook behind
 * the map search bar. CT-2 typeahead machinery precedent
 * (`data/trips-mutations.ts` `usePlaceSearch`) with the map-surface deltas:
 *
 *  - 2-char floor (R-map-25 "≥ 2 characters"), legal because every request
 *    carries the destination-region `bbox` geo bound (`search-geo.ts`;
 *    PL-3: 2–3-char typeahead requires a geo bound — the client mirror of
 *    `PlaceSearchQuerySchema`'s text-only floor).
 *  - `trip_id` rides along so custom places saved to THIS trip are findable
 *    (R-places-8 visibility widening; membership is server-checked).
 *  - Results are ranked blended text+geo server-side (PL-3 §3.3).
 *
 * KEY: extends the CT-2 `placeSearch` family with a `"map"` discriminator +
 * tripId + the bbox string — same `["places","search",…]` root, disjoint
 * entries (the destination search caches text-only responses; a map
 * response for the same `q` differs by bbox/trip_id). The key carries the
 * SAME geo bound the request carries, so a response is only ever served for
 * the region it answered: an edited trip destination — or the rider's
 * live-viewport bbox swap (escalation list) — is a key MISS, never a
 * stale-region hit (review A1). NOT under the `["trips", tripId, …]`
 * detail subtree, matching the CT-2 precedent: results are global spine
 * rows, stale-bounded by the default staleTime, not trip data the 404-scrub
 * must evict. The tripId suffix keeps per-trip custom-place visibility from
 * bleeding across trips' search UIs.
 *
 * The `enabled` gate is the ONLY client-side floor (CT-2 doc: the ApiClient
 * never validates inputs — a sub-floor query fired past the gate is a live
 * server 400). Every query forwards `{ signal }` (T-6.6 posture).
 */
import { placeEndpoints, type Paginated, type Place } from "@gogo/shared";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { queryKeys } from "@/data/query-client";

import { bboxParamFor, searchGeoBoundFor } from "./search-geo";

/** R-map-25's floor. The bbox geo bound is what makes < 4 chars legal. */
export const MAP_SEARCH_MIN_CHARS = 2;

/**
 * One page of results — list + temp pins render from it directly (spec
 * wants a bounded typeahead surface, not pagination; server default is 20,
 * pinned explicitly so a server-config change can't resize the UI).
 */
export const MAP_SEARCH_PAGE_LIMIT = 20;

/** Trim + NFC — mirrors the shared `SearchTextSchema` transform (CT-2 doc). */
function normalizeSearchText(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** Client mirror of the map-search floor (module doc). */
export function isSearchableMapQuery(raw: string): boolean {
  return normalizeSearchText(raw).length >= MAP_SEARCH_MIN_CHARS;
}

export interface MapSearchContext {
  tripId: string;
  destination: { lat: number; lng: number };
}

/** `GET /places/search` — q + destination-region bbox + trip_id (module doc). */
export function useMapPlaceSearch(
  context: MapSearchContext,
  rawQuery: string,
): UseQueryResult<Paginated<Place>, Error> {
  const q = normalizeSearchText(rawQuery);
  // Computed once so the KEY and the REQUEST can never disagree about the
  // geo bound (module doc KEY). Old bbox-less cache entries simply miss
  // and age out — the key change needs no migration.
  const bbox = bboxParamFor(searchGeoBoundFor(context.destination));
  return useQuery({
    queryKey: [...queryKeys.placeSearch(q), "map", context.tripId, bbox],
    queryFn: ({ signal }) =>
      apiClient.request(
        placeEndpoints.searchPlaces,
        {
          query: {
            q,
            bbox,
            trip_id: context.tripId,
            limit: MAP_SEARCH_PAGE_LIMIT,
          },
        },
        { signal },
      ),
    enabled: isSearchableMapQuery(rawQuery),
  });
}
