/**
 * Places server-state layer (T-8.2 / MAP-1 list read · T-8.4 / MAP-3 detail
 * + saved-place mutations — map spec §2.3/§2.4, R-map-9..11/14).
 *
 * Reads:
 * - `useSavedPlaces` — the trip's saved-places list, the map's saved-pin set
 *   (R-map-1) and the coordinate source the itinerary pin builder joins
 *   against (`features/map/pin-features.ts`). Paginated to exhaustion; the
 *   ACCUMULATED `Paginated` shape below is a contract the mutations respect.
 * - `usePlace` — the detail screen's spine read (`GET /places/:placeId`,
 *   no `fresh` param — cacheable, offline-capable, §2.3).
 * - `usePlaceFresh` — the §2.4 fetch-fresh contract, DORMANT in v1
 *   (`PLACE_FRESH_ENABLED`); see its doc for the non-persistence rules.
 *
 * Mutations (R-map-11 save/unsave optimistic + reconcile; R-map-14 note):
 * side effects ride the HOOK-level `PlaceMutationOptions` seam ONLY
 * (T-6.8/T-6.9 landmine: TanStack v5 drops per-call callbacks for
 * superseded calls). Success paths reconcile the cached list from returned
 * rows with NO trailing refetch (the bookings-layer zero-refetch design);
 * error/409 paths rollback-or-adopt AND invalidate (the optimistic premise
 * was stale — truth comes from the next read).
 *
 * KEY-CACHE LAW (T-6.7): `tripSavedPlaces` lives under the
 * `["trips", tripId]` DETAIL subtree so the membership guard's 404-scrub and
 * `evictTripSubtree` (prefix removal over `trip(tripId)`) evict it on access
 * loss. `placeDetail`/`placeFresh` are DELIBERATELY outside that subtree —
 * rationale on the keys themselves (query-client.ts). NOTHING here touches
 * `["trip-list"]`.
 *
 * Every query forwards TanStack's `{ signal }` (T-6.6 R1 cancellation
 * posture).
 */
import {
  placeEndpoints,
  type FreshPlaceDetails,
  type Paginated,
  type Place,
  type PlaceDetails,
  type SavedPlaceWithPlace,
} from "@gogo/shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient, ApiRequestError } from "@/auth";

import { queryKeys } from "./query-client";

/**
 * Hook-level mutation side-effect seam (members.ts precedent — module doc
 * has the landmine). Cache reconciliation never rides it.
 */
export interface PlaceMutationOptions<TData = unknown> {
  onMutationError?(error: unknown): void;
  onMutationSuccess?(data: TData): void;
}

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

/**
 * The saved-place row for a place, from the accumulated list read — the
 * detail screen's "is this place saved" + note source (R-map-11/14). Pure
 * over the page so it is testable without a component.
 */
export function findSavedPlace(
  page: Paginated<SavedPlaceWithPlace> | undefined,
  placeId: string,
): SavedPlaceWithPlace | undefined {
  return page?.items.find((row) => row.place_id === placeId);
}

/**
 * `GET /places/:placeId` — the detail screen's SPINE read (§2.3: "the
 * detail screen requests `?fresh=true`" is the SEPARATE `usePlaceFresh`
 * query below; this one deliberately omits the param so the spine view
 * stays normally cacheable and renders offline from retained cache,
 * R-map-22). An invisible custom place surfaces as `is404` — the screen's
 * missing state (Law #3 client half).
 */
export function usePlace(
  placeId: string,
  options?: { enabled?: boolean },
): UseQueryResult<PlaceDetails, Error> {
  return useQuery({
    queryKey: queryKeys.placeDetail(placeId),
    queryFn: ({ signal }) =>
      apiClient.request(placeEndpoints.getPlace, { params: { placeId }, query: {} }, { signal }),
    enabled: options?.enabled ?? true,
  });
}

/**
 * v1 DORMANCY FLAG for the fetch-fresh seam. Premium place details are
 * MVP-deferred (places spec Gate-2 resolution: "`fresh` never requested in
 * v1") — the detail screen passes this as `usePlaceFresh`'s `enabled`, so
 * no v1 code path issues `?fresh=true` while the whole §2.4 contract ships
 * built and tested. Flip when the post-MVP Foursquare integration lands
 * (ADR-005 entitlement seam).
 */
export const PLACE_FRESH_ENABLED = false;

/**
 * `GET /places/:placeId?fresh=true` — the §2.4 fetch-fresh client contract
 * (R-map-9, display-then-discard):
 *
 * - Dedicated query, SPEC-VERBATIM key `['place-fresh', placeId]`.
 * - `staleTime: 0` — refetched per view (every mount), never served warm.
 * - `gcTime: 0` — evaporates from the cache the moment no screen observes
 *   it; nothing survives to be persisted.
 * - `retry: false` — absence degrades silently (R-map-10); retrying a
 *   licensing-metered upstream is never worth it (places spec §3.4 mirrors
 *   this server-side: no retries).
 * - The payload is RENDER-ONLY: it must never reach Zustand, SQLite, MMKV,
 *   analytics, or logging (§2.4) — no TQ persister exists (P-8 ruling: do
 *   NOT build one), and `.github/scripts/check-place-fresh-persistence.mjs`
 *   enforces both halves lint-level in CI.
 *
 * `select` narrows to the `fresh` block (`null` when the server omitted it
 * — offline/error/`fresh_unavailable_reason` all render as silent absence,
 * R-map-10). The spine half of the response is already owned by `usePlace`.
 */
export function usePlaceFresh(
  placeId: string,
  options?: { enabled?: boolean },
): UseQueryResult<FreshPlaceDetails | null, Error> {
  return useQuery({
    queryKey: queryKeys.placeFresh(placeId),
    queryFn: ({ signal }) =>
      apiClient.request(
        placeEndpoints.getPlace,
        // `stringbool` wire boolean (the bookings `unscheduled` precedent).
        { params: { placeId }, query: { fresh: "true" } },
        { signal },
      ),
    select: (data: PlaceDetails) => data.fresh ?? null,
    enabled: options?.enabled ?? true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/**
 * Optimistic-save placeholder id — replaced by the server row on success
 * (the `optimisticScheduleItemId` precedent). NOT a UUID on purpose: it can
 * never collide with a server id, and `isOptimisticSavedPlaceId` lets the
 * screen keep note-edit/unsave gated until the real row lands (a PATCH or
 * DELETE against the placeholder id would be a guaranteed 404).
 */
export function optimisticSavedPlaceId(placeId: string): string {
  return `optimistic-saved-${placeId}`;
}

export function isOptimisticSavedPlaceId(savedPlaceId: string): boolean {
  return savedPlaceId.startsWith("optimistic-saved-");
}

/**
 * Reconcile one saved-place row into the accumulated list (post-state) —
 * replace the row for its place (optimistic placeholder included, matched
 * by `place_id`) or append. Append, not splice: the map's pin set is
 * order-independent and the server list order (creation order) puts new
 * saves last anyway. The accumulated `Paginated` shape (`nextCursor`
 * untouched) is preserved; untouched rows keep identity via setQueryData's
 * structural sharing, which the map screen's memo chain rides.
 */
function reconcileSavedPlaceRow(
  qc: QueryClient,
  tripId: string,
  row: SavedPlaceWithPlace,
): void {
  qc.setQueryData<Paginated<SavedPlaceWithPlace>>(queryKeys.tripSavedPlaces(tripId), (old) => {
    if (old === undefined) return old;
    const index = old.items.findIndex((existing) => existing.place_id === row.place_id);
    const items = old.items.slice();
    if (index === -1) items.push(row);
    else items[index] = row;
    return { ...old, items };
  });
}

export interface SavePlaceVars {
  /** The full place row (from `usePlace`/search) — embeds into the optimistic list row. */
  place: Place;
  note?: string;
}

interface SavedPlacesContext {
  previous: Paginated<SavedPlaceWithPlace> | undefined;
}

/**
 * `POST /trips/:tripId/saved-places` (PL-4) — OPTIMISTIC per R-map-11
 * ("apply the change optimistically and reconcile"): a placeholder row with
 * the embedded place appends immediately (the map's saved pin appears — the
 * PR #23 pin-coverage ruling rides this list), success swaps in the server
 * row, and failure rolls back + invalidates.
 *
 * 409 CONFLICT ≡ SUCCESS (R-map-11 / R-places-16 save-once semantics): the
 * place IS saved server-side — the optimistic row is KEPT (not rolled
 * back), the list is invalidated so the real row (real id, real note)
 * replaces the placeholder, and the seam fires `onMutationSuccess(null)`
 * (`null` = "saved, but no row came back"). Only non-409 failures reach
 * `onMutationError`.
 */
export function useSavePlace(
  tripId: string,
  options?: PlaceMutationOptions<SavedPlaceWithPlace | null>,
): UseMutationResult<SavedPlaceWithPlace, Error, SavePlaceVars, SavedPlacesContext> {
  const qc = useQueryClient();
  const listKey = queryKeys.tripSavedPlaces(tripId);
  return useMutation({
    mutationFn: ({ place, note }: SavePlaceVars) =>
      apiClient.request(placeEndpoints.createSavedPlace, {
        params: { tripId },
        body: { place_id: place.id, ...(note !== undefined ? { note } : {}) },
      }),
    onMutate: async ({ place, note }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<Paginated<SavedPlaceWithPlace>>(listKey);
      const now = new Date().toISOString();
      qc.setQueryData<Paginated<SavedPlaceWithPlace>>(listKey, (old) => {
        if (old === undefined) return old;
        // Already present (double-tap race) — leave the cache truthful.
        if (old.items.some((row) => row.place_id === place.id)) return old;
        const placeholder: SavedPlaceWithPlace = {
          id: optimisticSavedPlaceId(place.id),
          trip_id: tripId,
          place_id: place.id,
          note: note ?? null,
          created_by: null,
          created_at: now,
          updated_at: now,
          place,
        };
        return { ...old, items: [...old.items, placeholder] };
      });
      return { previous };
    },
    onSuccess: (row) => {
      // Seam first (fires for EVERY settled call — superseded-call law).
      options?.onMutationSuccess?.(row);
      reconcileSavedPlaceRow(qc, tripId, row);
    },
    onError: (err, _vars, ctx) => {
      if (err instanceof ApiRequestError && err.status === 409) {
        // Already saved ≡ success: keep the optimistic row, let the refetch
        // swap the placeholder for the real one.
        void qc.invalidateQueries({ queryKey: listKey });
        options?.onMutationSuccess?.(null);
        return;
      }
      if (ctx?.previous !== undefined) qc.setQueryData(listKey, ctx.previous);
      void qc.invalidateQueries({ queryKey: listKey });
      options?.onMutationError?.(err);
    },
  });
}

/**
 * `DELETE /trips/:tripId/saved-places/:savedPlaceId` (PL-4) — OPTIMISTIC
 * removal (R-map-11), snapshot rollback + invalidate on ANY error. Unlike
 * save's 409, no status is success-equivalent here by spec — a 404 rolls
 * back and the invalidation refetch resolves the truth (if the row really
 * was already gone, the refetch removes it again).
 */
export function useUnsavePlace(
  tripId: string,
  options?: PlaceMutationOptions<string>,
): UseMutationResult<string, Error, string, SavedPlacesContext> {
  const qc = useQueryClient();
  const listKey = queryKeys.tripSavedPlaces(tripId);
  return useMutation({
    mutationFn: async (savedPlaceId: string) => {
      await apiClient.request(placeEndpoints.deleteSavedPlace, {
        params: { tripId, savedPlaceId },
      });
      // 204 carries no body — the id is the post-state the seam needs.
      return savedPlaceId;
    },
    onMutate: async (savedPlaceId) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<Paginated<SavedPlaceWithPlace>>(listKey);
      qc.setQueryData<Paginated<SavedPlaceWithPlace>>(listKey, (old) =>
        old === undefined
          ? old
          : { ...old, items: old.items.filter((row) => row.id !== savedPlaceId) },
      );
      return { previous };
    },
    onSuccess: (savedPlaceId) => {
      options?.onMutationSuccess?.(savedPlaceId);
    },
    onError: (err, _savedPlaceId, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(listKey, ctx.previous);
      void qc.invalidateQueries({ queryKey: listKey });
      options?.onMutationError?.(err);
    },
  });
}

export interface SavedPlaceNoteVars {
  savedPlaceId: string;
  /** `null` clears the note (PL-4 PATCH contract). */
  note: string | null;
}

/**
 * `PATCH /trips/:tripId/saved-places/:savedPlaceId` — the R-map-14 inline
 * note editor's save. NOT optimistic (house policy for non-R-map-11 writes:
 * the editor shows a spinner and the server's post-state is the truth to
 * reconcile — the trip-settings/booking-update precedent); success replaces
 * the row in the accumulated list.
 */
export function useUpdateSavedPlaceNote(
  tripId: string,
  options?: PlaceMutationOptions<SavedPlaceWithPlace>,
): UseMutationResult<SavedPlaceWithPlace, Error, SavedPlaceNoteVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ savedPlaceId, note }: SavedPlaceNoteVars) =>
      apiClient.request(placeEndpoints.updateSavedPlace, {
        params: { tripId, savedPlaceId },
        body: { note },
      }),
    onSuccess: (row) => {
      options?.onMutationSuccess?.(row);
      reconcileSavedPlaceRow(qc, tripId, row);
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}
