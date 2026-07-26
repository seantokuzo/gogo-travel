/**
 * T-6.7 data module (CT-1/CT-2) — the trip-list infinite query, the
 * create-trip mutation, and the destination place search. Lives in its own
 * file (not `hooks.ts`) per the Wave-5 merge plan: T-6.8/T-6.9 extend the
 * data layer in their own modules, so parallel lanes only ever touch
 * `query-client.ts`/`index.ts` additively.
 *
 * Conventions carried from T-5.8/T-6.6 (`hooks.ts`):
 * - every QUERY forwards TanStack's `{ signal }` (cancellation + the
 *   app-wide `REQUEST_TIMEOUT_MS` cap compose inside the ApiClient);
 * - wire shapes are `@gogo/shared` descriptors end to end.
 */
import {
  PLACES_SEARCH_TEXT_ONLY_MIN_CHARS,
  placeEndpoints,
  tripEndpoints,
  type Paginated,
  type Place,
  type TripCreate,
  type TripListItem,
  type TripWithRole,
} from "@gogo/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/**
 * `GET /trips` with REAL keyset pagination (CT-1; §2.1) — cursor pages per
 * the shared `Paginated` contract (`nextCursor` round-trips as `?cursor=`,
 * `null` = end). Page size stays server-default (`TRIPS_PAGE_SIZE_DEFAULT`):
 * the list virtualizes, so there is no client reason to override it.
 *
 * The entry redirect / trip switcher keep their own first-page-at-cap read
 * (`useTrips`, key `["trips"]`) — an `InfiniteData` shape can't share a key
 * with a plain page, and the launch decision wants one bounded read, not a
 * paginated crawl.
 */
export function useTripList(): UseInfiniteQueryResult<
  InfiniteData<Paginated<TripListItem>, string | undefined>,
  Error
> {
  return useInfiniteQuery({
    queryKey: queryKeys.tripsList,
    queryFn: ({ pageParam, signal }) =>
      apiClient.request(
        tripEndpoints.listTrips,
        { query: pageParam !== undefined ? { cursor: pageParam } : {} },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    // `null` (shared contract's "no further page") and `undefined` both mean
    // stop in v5 — normalize so the pageParam type stays `string | undefined`.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/**
 * `POST /trips` (CT-2; R-tripui-6/7). NOT optimistic — §2.6: server-generated
 * identity (trip id + owner membership) means a spinner, not a cache guess.
 * On success:
 * - seed the trip's detail cache (the guard still re-verifies on mount —
 *   R-nav-20 — but the fresh row is the reconciled truth, R-trips-19);
 * - invalidate BOTH trips list keys so the new trip appears everywhere
 *   (`exact` on `["trips"]` — it is a PREFIX of every detail key; the T-6.6
 *   guard scrub learned that landmine live).
 * `enqueueDestination` (places ingest) fires server-side on create — no
 * client call.
 */
export function useCreateTrip(): UseMutationResult<TripWithRole, Error, TripCreate> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TripCreate) =>
      apiClient.request(tripEndpoints.createTrip, { body: input }),
    onSuccess: (trip) => {
      qc.setQueryData(queryKeys.trip(trip.id), trip);
      void qc.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.tripsList, exact: true });
    },
  });
}

/** Trimmed + NFC-normalized, mirroring the shared `SearchTextSchema` transform. */
function normalizeSearchText(raw: string): string {
  return raw.trim().normalize("NFC");
}

/**
 * Client mirror of the text-ONLY search floor (`PlaceSearchQuerySchema`):
 * the create form has no geo bound (no trip exists yet), so `q` must carry
 * ≥ `PLACES_SEARCH_TEXT_ONLY_MIN_CHARS` (4) chars — shorter typeahead is a
 * server 400 by design (trgm-GIN scale bound, config/places.ts).
 */
export function isSearchableDestinationQuery(raw: string): boolean {
  return normalizeSearchText(raw).length >= PLACES_SEARCH_TEXT_ONLY_MIN_CHARS;
}

/**
 * `GET /places/search` — destination structured search (CT-2; §2.3 resolved
 * Gate 2: Overture city/locality subset lives in the same `places` spine, so
 * the standard search endpoint IS the destination source). Text-only (no
 * bbox/near) with the 4-char floor enforced by the `enabled` gate — the
 * ApiClient validates inputs against the descriptor schema, so firing a
 * 2–3-char bare query would reject client-side.
 */
export function usePlaceSearch(rawQuery: string): UseQueryResult<Paginated<Place>, Error> {
  const q = normalizeSearchText(rawQuery);
  return useQuery({
    queryKey: queryKeys.placeSearch(q),
    queryFn: ({ signal }) =>
      apiClient.request(placeEndpoints.searchPlaces, { query: { q } }, { signal }),
    enabled: isSearchableDestinationQuery(rawQuery),
  });
}
