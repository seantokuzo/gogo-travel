/**
 * T-6.7 data module (CT-1/CT-2) — the trip-list infinite query, the
 * create-trip mutation, the destination place search, and (B-7) the
 * custom-destination create fallback. Lives in its own file (not
 * `hooks.ts`) per the Wave-5 merge plan: T-6.8/T-6.9 extend the data layer
 * in their own modules, so parallel lanes only ever touch
 * `query-client.ts`/`index.ts` additively.
 *
 * Conventions carried from T-5.8/T-6.6 (`hooks.ts`):
 * - every QUERY forwards TanStack's `{ signal }` (cancellation + the
 *   app-wide `REQUEST_TIMEOUT_MS` cap compose inside the ApiClient);
 * - wire shapes are `@gogo/shared` descriptors end to end.
 */
import {
  PLACES_SEARCH_MIN_CHARS,
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

import { apiClient, ApiRequestError } from "@/auth";

import { invalidateTripLists, queryKeys } from "./query-client";

/**
 * `GET /trips` with REAL keyset pagination (CT-1; §2.1) — cursor pages per
 * the shared `Paginated` contract (`nextCursor` round-trips as `?cursor=`,
 * `null` = end). Page size stays server-default (`TRIPS_PAGE_SIZE_DEFAULT`):
 * the list virtualizes, so there is no client reason to override it.
 *
 * The entry redirect / trip switcher keep their own first-page-at-cap read
 * (`useTrips`, key `["trips"]`) — an `InfiniteData` shape can't share a key
 * with a plain page, and the launch decision wants one bounded read, not a
 * paginated crawl. On cold start that redirect page IS this list's first
 * page (same endpoint, wider limit), so it seeds the infinite cache
 * (`initialData` + the source read's `dataUpdatedAt` — R1 perf review):
 * the default landing renders rows immediately instead of paying a second
 * serial RTT behind a skeleton.
 */
export function useTripList(): UseInfiniteQueryResult<
  InfiniteData<Paginated<TripListItem>, string | undefined>,
  Error
> {
  const qc = useQueryClient();
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
    initialData: () => {
      const seed = qc.getQueryData<Paginated<TripListItem>>(queryKeys.trips);
      if (seed === undefined) return undefined;
      return { pages: [seed], pageParams: [undefined] };
    },
    // Carry the source read's timestamp so staleTime applies to when the
    // rows were actually fetched — a stale redirect page still refetches.
    initialDataUpdatedAt: () => qc.getQueryState(queryKeys.trips)?.dataUpdatedAt,
  });
}

/**
 * `POST /trips` (CT-2; R-tripui-6/7). NOT optimistic — §2.6: server-generated
 * identity (trip id + owner membership) means a spinner, not a cache guess.
 * On success:
 * - seed the trip's detail cache (the guard still re-verifies on mount —
 *   R-nav-20 — but the fresh row is the reconciled truth, R-trips-19);
 * - mark BOTH trips list keys stale WITHOUT refetching (`refetchType:
 *   "none"`, R1 perf review): the modal replaces into `/[tripId]`, so the
 *   list refetches exactly once via its guaranteed focus effect when the
 *   user returns — an eager background refetch here would be a redundant
 *   second RTT.
 * `enqueueDestination` (places ingest) fires server-side on create — no
 * client call.
 */
export function useCreateTrip(): UseMutationResult<TripWithRole, Error, TripCreate> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TripCreate) => apiClient.request(tripEndpoints.createTrip, { body: input }),
    onSuccess: (trip) => {
      qc.setQueryData(queryKeys.trip(trip.id), trip);
      invalidateTripLists(qc, { refetchType: "none" });
    },
  });
}

/** Trimmed + NFC-normalized, mirroring the shared `SearchTextSchema` transform. */
function normalizeSearchText(raw: string): string {
  return raw.trim().normalize("NFC");
}

/**
 * Client mirror of the ABSOLUTE search floor (`PLACES_SEARCH_MIN_CHARS`, 2
 * — mirrors `SearchTextSchema.min(2)`): the create form has no geo bound
 * (no trip exists yet), so `q` must carry ≥ 2 chars after trim.
 *
 * B-7 review R1 (BLOCKING × 3 lanes, 2026-09-15): this used to gate at the
 * WIDER `PLACES_SEARCH_TEXT_ONLY_MIN_CHARS` (4) — the trgm-GIN scale bound
 * that only matters to the SERVER's arm selection — which meant none of
 * the 54 sub-4-char destination-tier rows R-places-28 exists to unblock
 * (Fez, Van, Ufa, Qom, …) were ever reachable from this screen: the
 * request that would hit the server's new exact-match arm never fired.
 * Below `PLACES_SEARCH_MIN_CHARS` is still a genuine floor —
 * `SearchTextSchema.min(2)` 400s it (VALIDATION_FAILED), unaffected by
 * R-places-28 — but at/above it the SERVER, not this client, now picks the
 * arm (exact-tier below `PLACES_SEARCH_TEXT_ONLY_MIN_CHARS`, trigram at/
 * above it).
 */
export function isSearchableDestinationQuery(raw: string): boolean {
  return normalizeSearchText(raw).length >= PLACES_SEARCH_MIN_CHARS;
}

/**
 * `GET /places/search` — destination structured search (CT-2; §2.3 resolved
 * Gate 2: Overture city/locality subset lives in the same `places` spine, so
 * the standard search endpoint IS the destination source). Text-only (no
 * bbox/near) from the ABSOLUTE 2-char floor (`isSearchableDestinationQuery`)
 * — the gate is the ONLY client-side floor: the ApiClient validates
 * RESPONSES against the descriptor schema, never inputs (params/query/body
 * serialize unvalidated — R1 review), so a `q` shorter than the ABSOLUTE
 * floor fired past this gate would still be a live server 400
 * (VALIDATION_FAILED) — that boundary is unchanged. At/above the absolute
 * floor the server ALWAYS answers 200 (B-7 follow-up, R-places-28) and
 * picks which arm ran (exact-tier match below
 * `PLACES_SEARCH_TEXT_ONLY_MIN_CHARS`, trigram scan at/above it) — this
 * client no longer needs to know which.
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

/**
 * Non-blank after trim — a pure function, used as `handleCreateCustomDestination`'s
 * defense-in-depth guard against `deferredQuery` (B-7 review R1 A3): the
 * render gate no longer duplicates this check — `searchActive` already
 * requires `isSearchableDestinationQuery(deferredQuery)` (≥4 chars) before
 * the row can render at all, which is strictly stronger than non-blank, so
 * a SEPARATE JSX call site against the LIVE `destinationQuery` was both
 * redundant AND wrong: a `useDeferredValue` lag window could leave
 * `searchActive` reading true against a STALE deferred query for one tick
 * after the user cleared the input, while the row/mutate argument (also
 * fixed by R1 A3 to read `deferredQuery`, never `destinationQuery`) would
 * then create a custom place for text the user never searched. That lag
 * never materializes under jest's synchronous renderer, so this guard's
 * call site isn't independently mutation-verifiable there either — this
 * pure export is (trips-mutations.test.tsx).
 */
export function isNonBlankDestinationQuery(raw: string): boolean {
  return raw.trim() !== "";
}

/** Hook-level seam (places.ts precedent) — see `useCreateCustomDestination` doc. */
export interface CreateCustomDestinationOptions {
  onMutationSuccess?(place: Place): void;
  onMutationError?(error: unknown): void;
}

/**
 * `POST /places` — the destination-search empty-results fallback (B-7, Sean
 * ruling 2026-09-13, trips spec R-tripui-23): when structured search settles
 * with zero hits, the picker offers to create the typed text as a permanent
 * `source='custom'` place (`PlaceCreateSchema`: `name`, `lat?`, `lng?`,
 * `category?` — no visibility field exists on the wire shape at all, so
 * there is nothing here to accidentally widen past the schema default;
 * creator-scoping is entirely the server's, per `search-query.ts`) and
 * select it. B-7 PART 3 (2026-09-13 ruling, `B-7/nullable-custom-coords`):
 * the body carries `name` ONLY — no `lat`/`lng` at all. `PlaceCreateSchema`
 * now treats the pair as fully optional (omit both ⇒ a coordinate-less
 * custom place; an explicit `null` is a 400 — one way to say "no
 * coordinates"), so the old `(0, 0)` "Null Island" placeholder this hook
 * used to send is GONE — every mobile consumer of a place/trip coordinate
 * now takes a real null arm instead of silently treating `(0, 0)` as a real
 * position (`features/map/**`, `map.spec.md` R-map-26). A trip created from
 * a coordinate-less custom place carries `destination_lat/lng: null`; the
 * settings remediation path (`more/settings.tsx`) is how the user gives it
 * real coordinates later. `category` is omitted (schema optional; server
 * default `null` → coarse category `'other'`, same as the
 * `scripts/seed-qa-places.mjs` precedent).
 *
 * Success/error ride the HOOK's OWN `useMutation` options, not a per-call
 * `.mutate()` callback (the `places.ts` module-doc landmine: TanStack v5
 * drops per-call callbacks for a superseded call — this hook is called at
 * most once in flight by construction, but the seam stays consistent with
 * every other mutation in this data layer).
 */
export function useCreateCustomDestination(
  options?: CreateCustomDestinationOptions,
): UseMutationResult<Place, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    // Trim at the hook boundary (the `usePlaceSearch`/`normalizeSearchText`
    // precedent above: one normalization owner, not "the caller remembered
    // to trim"). The request body carries EXACTLY `name` (B-7 part 3 — no
    // `lat`/`lng`, no `category`, `trip_id`, or visibility field rides along
    // — Law #3: the wire shape has no visibility knob to widen in the first
    // place). Omitting BOTH coordinate keys is what makes the created place
    // coordinate-less (`PlaceCreateSchema`'s pair rule) — sending an explicit
    // `null` for either is a 400, so the key must be absent, not nulled.
    mutationFn: (rawName: string) =>
      apiClient.request(placeEndpoints.createPlace, {
        body: { name: rawName.trim() },
      }),
    onSuccess: (place) => {
      // B-7 review R1 B2 (blocking): with no invalidation, the EMPTY
      // `placeSearch(q)` page fetched before this create stays fresh under
      // prod's 5-min staleTime — the row gets re-offered for a place that
      // now exists, and `places` has no uniqueness constraint for custom
      // rows (`source_id IS NULL`), so a second tap mints a duplicate. This
      // can't target one exact key (the create doesn't know every `q` that
      // would now match), so it invalidates the WHOLE `placeSearch` family —
      // default `refetchType: "active"` refetches any mounted search
      // observer immediately, which is exactly the screen that just created
      // this place.
      void qc.invalidateQueries({ queryKey: queryKeys.placeSearchRoot });
      options?.onMutationSuccess?.(place);
    },
    onError: (error) => options?.onMutationError?.(error),
  });
}

/**
 * Map a `useCreateCustomDestination` failure onto a safe, actionable banner
 * message (§3.5 envelope). Round-1 architecture fix (cross-lane advisory,
 * B-7 review): this was byte-identical, screen-local code in `new.tsx` and
 * `more/settings.tsx` — one mutation, one error contract, so it lives here
 * next to the hook it maps errors for, not duplicated per caller. 409 isn't
 * documented for `POST /places` today (places spec §3.3 lists only 400
 * `VALIDATION_FAILED`) — kept for symmetry with every other create-mutation
 * error mapper and as a defensive branch if that ever changes.
 */
export function createCustomDestinationErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 400) {
      return "That destination name isn't valid — try editing it.";
    }
    if (error.status === 409) {
      return "That change conflicted with another update — try again.";
    }
    if (error.status === 0) {
      return "No connection — check your network and retry.";
    }
  }
  return "Couldn't create that destination. Retry?";
}
