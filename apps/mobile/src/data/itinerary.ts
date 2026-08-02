/**
 * Itinerary server-state layer (T-7.4 / IT-1+IT-2 — itinerary spec §2.2).
 * Typed hooks over the `@gogo/shared` itinerary/booking descriptors for the
 * plan surface:
 *
 * - `useItinerary` — the R-ib-13 composite read `{items, legs}` at the
 *   server's default range (trip dates unioned with existing item days —
 *   exactly the R-itin-1 section range, so the client never passes bounds).
 * - `useItineraryBookings` — the calendar's booking ENRICHMENT read: item
 *   cards need category icon + status Badge (R-itin-8) and the parent
 *   booking's fixed-time day lock (R-itin-3), none of which ride the item
 *   row. Read-only here by design: booking mutations are T-7.6/T-7.8's
 *   (`data/bookings.ts`), which must reuse `queryKeys.tripBookings`.
 * - `useDayOrder` — the R-ib-15 day-order PUT, optimistic with rollback
 *   (R-itin-2): apply the intended order → reconcile with the server's
 *   returned FULL day post-state (R-ib-18) → rollback + invalidate on error.
 *
 * KEY-CACHE LAW (T-6.7): both query keys live under the `["trips", tripId]`
 * DETAIL subtree so the membership guard's 404-scrub and `evictTripSubtree`
 * (prefix removal over `trip(tripId)`) evict them on access loss — the NAV-4
 * zero-trip-data posture. NOTHING here touches `["trip-list"]`.
 *
 * Mutation-callback policy (T-6.8/T-6.9 landmine): TanStack v5 fires
 * PER-CALL `mutate` callbacks only for the LATEST call on a mutation
 * instance — screens hand their banner/haptic side effects to the
 * HOOK-level `ItineraryMutationOptions` seam instead, which fires for every
 * settled call. Cache reconciliation never rides the seam.
 *
 * Every QUERY forwards TanStack's `{ signal }` (T-6.6 R1 cancellation/
 * timeout posture).
 */
import {
  bookingEndpoints,
  itineraryEndpoints,
  type Booking,
  type DayOrderResult,
  type ISODate,
  type ItineraryItem,
  type ItineraryRead,
  type Paginated,
} from "@gogo/shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/**
 * Hook-level mutation callback seam (module doc: the superseded-call drop).
 * Same shape as `MemberMutationOptions`/`TripMutationOptions` — kept local
 * per precedent (each domain layer owns its seam).
 */
export interface ItineraryMutationOptions<TData = unknown> {
  onMutationError?(error: unknown): void;
  onMutationSuccess?(data: TData): void;
}

/**
 * `GET /trips/:tripId/itinerary` — items ordered `(day, sort_order)` plus
 * the legs whose endpoints are both in range, mutually consistent in one
 * response (R-ib-13). No `from`/`to`: the plan surface always wants the
 * server's default full range (§3.4 — trip dates ∪ existing item days).
 * Legs feed the T-7.5 travel-time chips; they are plumbed, not rendered,
 * in T-7.4.
 */
export function useItinerary(tripId: string): UseQueryResult<ItineraryRead, Error> {
  return useQuery({
    queryKey: queryKeys.tripItinerary(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(itineraryEndpoints.getItinerary, { params: { tripId }, query: {} }, { signal }),
  });
}

/**
 * One page at the server cap — same single-page posture as `useTrips` /
 * `useTripInvites`: trip booking sets are small (a trip with >100 live
 * bookings is beyond the MVP ceiling), and the default filter (all except
 * `cancelled`) is exactly the calendar's universe (R-ib-7: cancelled
 * bookings have no items). Real pagination is the Ideas bucket's concern if
 * it ever needs it (T-7.6).
 */
const BOOKINGS_PAGE_LIMIT = 100;

/** `GET /trips/:tripId/bookings` — booking rows for calendar enrichment (module doc). */
export function useItineraryBookings(tripId: string): UseQueryResult<Paginated<Booking>, Error> {
  return useQuery({
    queryKey: queryKeys.tripBookings(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(
        bookingEndpoints.listBookings,
        { params: { tripId }, query: { limit: BOOKINGS_PAGE_LIMIT } },
        { signal },
      ),
  });
}

export interface DayOrderVars {
  /** Target day (PUT param) — the day the dragged item lands on. */
  day: ISODate;
  /** The day's FULL intended order, moved item included (R-ib-15). */
  itemIds: string[];
}

/** R-ib-15 sort_order assignment the server uses: `1024 × position` (1-based). */
const SORT_GAP = 1024;

/** `(day, sort_order, id)` — the R-ib-13 read order, id-tiebroken like the server. */
function byCalendarOrder(a: ItineraryItem, b: ItineraryItem): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Optimistic arm: reassign the listed items to `day` with the server's exact
 * sort_order rule; unlisted items are untouched (R-ib-15 — source-day
 * survivors keep their sort_order). Ids not in the cache are skipped (the
 * server's LWW-ignore for dead ids).
 */
export function applyDayOrder(read: ItineraryRead, day: ISODate, itemIds: string[]): ItineraryRead {
  const position = new Map(itemIds.map((id, index) => [id, index]));
  const items = read.items
    .map((item) => {
      const index = position.get(item.id);
      if (index === undefined) return item;
      return { ...item, day, sort_order: SORT_GAP * (index + 1) };
    })
    .sort(byCalendarOrder);
  return { ...read, items };
}

/**
 * Reconcile arm (R-ib-18): the server returns the target day's FULL
 * resulting item list — replace everything the response owns (that day's
 * items, plus any listed item by id wherever the optimistic update put it)
 * and keep the rest. Legs are untouched: reorder dirties them server-side
 * and the recompute lands via later reads (T-7.3/T-7.5).
 */
export function reconcileDayOrder(
  read: ItineraryRead,
  day: ISODate,
  serverItems: ItineraryItem[],
): ItineraryRead {
  const serverIds = new Set(serverItems.map((item) => item.id));
  const items = read.items
    .filter((item) => item.day !== day && !serverIds.has(item.id))
    .concat(serverItems)
    .sort(byCalendarOrder);
  return { ...read, items };
}

/**
 * `PUT /trips/:tripId/itinerary/days/:day/order` — optimistic day reorder
 * (R-itin-2). Rollback restores the pre-mutation snapshot AND invalidates
 * (a 400/404 means the optimistic premise was stale — e.g. the item was
 * deleted, or a booking's times got fixed under us); the screen's visible
 * rollback + ErrorBanner ride the hook-level seam.
 */
export function useDayOrder(
  tripId: string,
  options?: ItineraryMutationOptions<DayOrderResult>,
): UseMutationResult<
  DayOrderResult,
  Error,
  DayOrderVars,
  { previous: ItineraryRead | undefined }
> {
  const qc = useQueryClient();
  const key = queryKeys.tripItinerary(tripId);
  return useMutation({
    mutationFn: ({ day, itemIds }: DayOrderVars) =>
      apiClient.request(itineraryEndpoints.putDayOrder, {
        params: { tripId, day },
        body: { item_ids: itemIds },
      }),
    onMutate: async ({ day, itemIds }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ItineraryRead>(key);
      qc.setQueryData<ItineraryRead>(key, (old) =>
        old === undefined ? old : applyDayOrder(old, day, itemIds),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous);
      void qc.invalidateQueries({ queryKey: key });
      options?.onMutationError?.(err);
    },
    onSuccess: (result, { day }) => {
      qc.setQueryData<ItineraryRead>(key, (old) =>
        old === undefined ? old : reconcileDayOrder(old, day, result.items),
      );
      options?.onMutationSuccess?.(result);
    },
  });
}
