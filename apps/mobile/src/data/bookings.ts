/**
 * Bookings server-state layer (T-7.8 / IT-8) — typed hooks over the merged
 * `bookingEndpoints` (`@gogo/shared` domains/booking.ts, landed T-7.1).
 * Started minimal by the deeplink return-prompt's "add manually" landing
 * (create with `source: 'deeplink_return'`, R-itin-22 / API R-ib-11);
 * T-7.6 (add/edit flows) and T-7.9 (booking detail) EXTEND this module —
 * update/delete/schedule hooks land there, on these same keys.
 *
 * KEY-CACHE LAW: booking keys live in `queryKeys` (query-client.ts — the ONE
 * home for cache keys; module-local `bookingKeys` promoted there by the
 * T-7.6 key-homing ruling, 2026-08-01) under the `["trips", tripId, …]`
 * DETAIL subtree — the `[tripId]` guard's 404-scrub evicts by that prefix,
 * and the collab foreground sweep already refreshes it. NOTHING here may
 * ever touch `["trip-list"]`.
 *
 * Mutation policy (trips §2.6 pattern): create/update are NOT optimistic —
 * the row is server-generated identity (+ server-derived instants/auto-items
 * and §3.2 transition side effects), the invite-create precedent; callers
 * show a spinner. `useScheduleBooking` IS optimistic — R-itin-11 says the
 * bucket card moves "optimistically" — with full snapshot rollback. Side
 * effects ride the hook-level `onMutationError`/`onMutationSuccess` seam
 * ONLY (T-6.8/T-6.9 landmine: TanStack v5 drops per-call callbacks for
 * superseded calls on a shared mutation instance — never hang per-call
 * callbacks on these hooks).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  bookingEndpoints,
  type Booking,
  type BookingCreate,
  type BookingUpdate,
  type BookingWithItems,
  type ItineraryItem,
  type ItineraryRead,
  type Paginated,
  type ScheduleBookingInput,
} from "@gogo/shared";

import { apiClient } from "@/auth";

import { byCalendarOrder, upsertItineraryItem } from "./itinerary";
import { queryKeys } from "./query-client";

/**
 * Hook-level mutation side-effect seam (members.ts precedent — module doc
 * has the landmine). Cache reconciliation never rides it.
 */
export interface BookingMutationOptions<TData = unknown> {
  onMutationError?(error: unknown): void;
  onMutationSuccess?(data: TData): void;
}

/**
 * `GET /trips/:tripId/bookings` — default view (no filters): every
 * non-cancelled booking, ordered `starts_at ASC NULLS LAST, updated_at
 * DESC` (R-ib-10). One page at the server cap: per-trip booking sets are
 * small (the trip-invites §3.5 posture). Filtered/paginated variants are
 * T-7.6/T-7.9 extensions.
 */
const BOOKINGS_PAGE_LIMIT = 100;

export function useTripBookings(
  tripId: string,
  options?: { enabled?: boolean },
): UseQueryResult<Paginated<Booking>, Error> {
  return useQuery({
    queryKey: queryKeys.tripBookings(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(
        bookingEndpoints.listBookings,
        { params: { tripId }, query: { limit: BOOKINGS_PAGE_LIMIT } },
        { signal },
      ),
    enabled: options?.enabled ?? true,
  });
}

/**
 * `POST /trips/:tripId/bookings` (§3.4) — server derives instants and
 * auto-items (I-2), so no optimistic row (module doc). Success invalidates
 * the whole booking prefix for the trip (list + any cached details), and —
 * the T-7.6 fan-out — the composite itinerary read too when the create
 * could have spawned auto-items (I-2: `status ∈ {planned, booked}` ∧ times
 * known); a timeless or `idea` create leaves itinerary keys untouched.
 */
export function useCreateBooking(
  tripId: string,
  options?: BookingMutationOptions<Booking>,
): UseMutationResult<Booking, Error, BookingCreate> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BookingCreate) =>
      apiClient.request(bookingEndpoints.createBooking, { params: { tripId }, body: input }),
    onSuccess: (booking) => {
      // Seam first (fires for EVERY settled create — superseded-call law),
      // then the cache work.
      options?.onMutationSuccess?.(booking);
      void qc.invalidateQueries({ queryKey: queryKeys.tripBookingsRoot(tripId) });
      if (booking.status !== "idea" && booking.starts_at !== null) {
        void qc.invalidateQueries({ queryKey: queryKeys.tripItinerary(tripId) });
      }
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

/**
 * `GET /trips/:tripId/bookings/:bookingId` — booking detail + calendar
 * presence (`BookingWithItems`). The `?bookingId=` edit-mode prefill read
 * (T-7.6); T-7.9's detail screen reuses this hook and key.
 */
export function useBooking(
  tripId: string,
  bookingId: string,
  options?: { enabled?: boolean },
): UseQueryResult<BookingWithItems, Error> {
  return useQuery({
    queryKey: queryKeys.tripBooking(tripId, bookingId),
    queryFn: ({ signal }) =>
      apiClient.request(
        bookingEndpoints.getBooking,
        { params: { tripId, bookingId } },
        { signal },
      ),
    enabled: options?.enabled ?? true,
  });
}

/**
 * `GET /trips/:tripId/bookings?status=cancelled` — the Ideas bucket's
 * "Show cancelled" list (R-itin-12: hidden by default, their only surface).
 * Cancelled is excluded from the default list (R-ib-10), so it is its own
 * trailing-arg key; the root-prefix invalidation reaches it.
 */
export function useCancelledBookings(
  tripId: string,
  options?: { enabled?: boolean },
): UseQueryResult<Paginated<Booking>, Error> {
  return useQuery({
    queryKey: queryKeys.tripBookingsCancelled(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(
        bookingEndpoints.listBookings,
        {
          params: { tripId },
          query: { status: "cancelled", limit: BOOKINGS_PAGE_LIMIT },
        },
        { signal },
      ),
    enabled: options?.enabled ?? true,
  });
}

/**
 * The R-ib-10 list order, mirrored client-side: `starts_at ASC NULLS LAST,
 * updated_at DESC` (id-tiebroken for determinism).
 *
 * Instants are compared as PARSED time values, never lexicographically: the
 * wire scalar is `z.iso.datetime({ offset: true })` (scalars.ts), so an
 * offset-bearing (`…+09:00`) or differently-precise (`…:00Z` vs
 * `…:00.000Z`) serialization is schema-legal — string compare would order
 * those by their spelling, not their instant, and would even call two
 * spellings of the SAME instant unequal. Unparseable ⇒ treated as unknown
 * (trailing), the shared `toUtcInstant` corruption-fold posture.
 */
export function byBookingListOrder(a: Booking, b: Booking): number {
  const startA = instantOrNull(a.starts_at);
  const startB = instantOrNull(b.starts_at);
  if (startA !== startB) {
    // NULLS LAST — a timeless idea trails every scheduled booking.
    if (startA === null) return 1;
    if (startB === null) return -1;
    return startA - startB;
  }
  const updatedA = instantOrNull(a.updated_at) ?? 0;
  const updatedB = instantOrNull(b.updated_at) ?? 0;
  // updated_at DESC — freshest first.
  if (updatedA !== updatedB) return updatedB - updatedA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function instantOrNull(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reconcile one row into the cached DEFAULT booking list (post-state,
 * R-ib-18) — upsert or REMOVE, whichever keeps the cache truthful.
 *
 * INVARIANT: the cached default list always satisfies the server's own list
 * predicate — R-ib-10, "all except `cancelled`" (`useTripBookings` sends no
 * status filter). Every arm below exists to preserve it:
 *
 *  - present + still listable ⇒ replace IN PLACE. The server's returned
 *    order is preserved byte-exactly (identical to the pre-round-1
 *    behavior), so a client/server ordering disagreement can never reshuffle
 *    rows the server already placed.
 *  - ABSENT + listable ⇒ SPLICE at the `byBookingListOrder` position. Load
 *    bearing (round-1 blocker): the create→schedule chain fires schedule
 *    BEFORE create's root invalidation refetch settles, and schedule's own
 *    `cancelQueries` aborts that refetch — a map-replace-only reconcile
 *    stranded the freshly created booking out of the list, so the day list
 *    rendered the enrichment-gap fallback ("Booking", no badge) with a FALSE
 *    day lock. Splicing repairs it without re-entering the invalidate/cancel
 *    race (the module's zero-refetch design).
 *  - CANCELLED ⇒ never inserted, and REMOVED if present. Round-2: without
 *    this, a PATCH could put a cancelled booking into the non-cancelled list
 *    (insert arm) or leave one there after a cancel transition (replace
 *    arm) — either way the Ideas bucket renders it as a live card with a
 *    guaranteed-403 "Add to day" (cancelled bookings have zero items,
 *    R-ib-7, so `unscheduledBookings` picks them up) until the trailing
 *    invalidation lands, or indefinitely if that refetch fails offline.
 *
 * Narrowing the insert arm back to the schedule call site was the other
 * option; it was rejected because it does NOT enforce the invariant — the
 * replace arm would still write `cancelled` into a listed row once T-7.9
 * wires R-itin-26's cancel action.
 */
function reconcileBookingRow(qc: QueryClient, tripId: string, booking: Booking): void {
  qc.setQueryData<Paginated<Booking>>(queryKeys.tripBookings(tripId), (old) => {
    if (old === undefined) return old;
    const index = old.items.findIndex((row) => row.id === booking.id);
    const listable = booking.status !== "cancelled";
    const items = old.items.slice();
    if (index !== -1) {
      if (listable) items[index] = booking;
      else items.splice(index, 1);
      return { ...old, items };
    }
    if (!listable) return old;
    const at = items.findIndex((row) => byBookingListOrder(booking, row) < 0);
    items.splice(at === -1 ? items.length : at, 0, booking);
    return { ...old, items };
  });
}

/** `BookingWithItems` → the bare `Booking` row (list caches hold rows, not composites). */
function toBookingRow(result: BookingWithItems): Booking {
  const { items: _items, ...booking } = result;
  return booking;
}

export interface BookingUpdateVars {
  bookingId: string;
  input: BookingUpdate;
}

/**
 * `PATCH /trips/:tripId/bookings/:bookingId` (§3.4) — NOT optimistic
 * (module doc: §3.2 transition side effects + item resync are
 * server-derived; concurrency is collab-v1 LWW, R-ib-18 — reconcile to the
 * returned post-state, nothing more). Success writes the `BookingWithItems`
 * post-state into the detail key, reconciles the default list row, and
 * invalidates the booking root (filtered lists — a cancel transition moves
 * rows between them) + the composite itinerary read (item side effects).
 */
export function useUpdateBooking(
  tripId: string,
  options?: BookingMutationOptions<BookingWithItems>,
): UseMutationResult<BookingWithItems, Error, BookingUpdateVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, input }: BookingUpdateVars) =>
      apiClient.request(bookingEndpoints.updateBooking, {
        params: { tripId, bookingId },
        body: input,
      }),
    onSuccess: (result) => {
      options?.onMutationSuccess?.(result);
      qc.setQueryData<BookingWithItems>(queryKeys.tripBooking(tripId, result.id), result);
      reconcileBookingRow(qc, tripId, toBookingRow(result));
      void qc.invalidateQueries({ queryKey: queryKeys.tripBookingsRoot(tripId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tripItinerary(tripId) });
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

/**
 * Remove one booking from every cache that can hold it — the DELETE arm
 * (T-7.9 / R-itin-26 second half). Deliberately NOT folded into
 * `reconcileBookingRow`: that function's contract is "reconcile a row that
 * still EXISTS server-side to its post-state", and its invariant (the cached
 * default list satisfies R-ib-10) is stated in terms of a live row's status.
 * A hard delete has no post-state, and it must also clear the CANCELLED list
 * (which `reconcileBookingRow` never touches, because a live cancel is exactly
 * the transition that puts a row there) and the detail key (whose entry would
 * otherwise re-render a 404'd booking if the screen remounts before the
 * invalidation refetch lands).
 */
function removeBookingEverywhere(qc: QueryClient, tripId: string, bookingId: string): void {
  for (const key of [queryKeys.tripBookings(tripId), queryKeys.tripBookingsCancelled(tripId)]) {
    qc.setQueryData<Paginated<Booking>>(key, (old) =>
      old === undefined ? old : { ...old, items: old.items.filter((row) => row.id !== bookingId) },
    );
  }
  qc.removeQueries({ queryKey: queryKeys.tripBooking(tripId, bookingId), exact: true });
}

/**
 * `DELETE /trips/:tripId/bookings/:bookingId` (§3.4) — hard delete; items
 * cascade in the DB and expense links SET NULL (schema §3.6: the ledger
 * outlives the booking, which is why R-itin-26's confirm copy says so).
 *
 * NOT optimistic (module-doc policy): the row is gone or it isn't, and a
 * failed delete that had already emptied the screen would have to resurrect
 * it. Success prunes every cache holding the row, then invalidates the booking
 * root (filtered lists) and the composite itinerary read (the cascaded items).
 */
export function useDeleteBooking(
  tripId: string,
  options?: BookingMutationOptions<string>,
): UseMutationResult<string, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (bookingId: string) => {
      await apiClient.request(bookingEndpoints.deleteBooking, {
        params: { tripId, bookingId },
      });
      // 204 carries no body — the id is the only useful post-state, and the
      // hook-level seam needs it to route/close.
      return bookingId;
    },
    onSuccess: (bookingId) => {
      // Seam first (fires for EVERY settled call — superseded-call law).
      options?.onMutationSuccess?.(bookingId);
      removeBookingEverywhere(qc, tripId, bookingId);
      void qc.invalidateQueries({ queryKey: queryKeys.tripBookingsRoot(tripId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tripItinerary(tripId) });
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

export interface ScheduleBookingVars {
  bookingId: string;
  input: ScheduleBookingInput;
}

/** Optimistic-schedule placeholder id — replaced by the server row on success. */
export function optimisticScheduleItemId(bookingId: string): string {
  return `optimistic-schedule-${bookingId}`;
}

interface ScheduleContext {
  previousItinerary: ItineraryRead | undefined;
  previousBookings: Paginated<Booking> | undefined;
}

/**
 * `POST /trips/:tripId/bookings/:bookingId/schedule` (R-ib-8) — the Ideas
 * bucket's "Add to day". OPTIMISTIC per R-itin-11 ("optimistically moving
 * the card into its day section with the status badge advancing
 * idea → planned"): a placeholder `booking`-kind item is appended to the
 * target day and the cached booking row advances `idea → planned`; success
 * swaps in the server post-state (R-ib-18 — real item id/sort_order,
 * authoritative status), failure restores both snapshots AND invalidates
 * (a 400/409 means the optimistic premise was stale — booking gained times
 * or was scheduled elsewhere).
 */
export function useScheduleBooking(
  tripId: string,
  options?: BookingMutationOptions<BookingWithItems>,
): UseMutationResult<BookingWithItems, Error, ScheduleBookingVars, ScheduleContext> {
  const qc = useQueryClient();
  const itineraryKey = queryKeys.tripItinerary(tripId);
  const listKey = queryKeys.tripBookings(tripId);
  return useMutation({
    mutationFn: ({ bookingId, input }: ScheduleBookingVars) =>
      apiClient.request(bookingEndpoints.scheduleBooking, {
        params: { tripId, bookingId },
        body: input,
      }),
    onMutate: async ({ bookingId, input }) => {
      await qc.cancelQueries({ queryKey: itineraryKey });
      await qc.cancelQueries({ queryKey: listKey });
      const previousItinerary = qc.getQueryData<ItineraryRead>(itineraryKey);
      const previousBookings = qc.getQueryData<Paginated<Booking>>(listKey);

      // Badge advance (R-ib-8: `idea → planned` when it was `idea`).
      qc.setQueryData<Paginated<Booking>>(listKey, (old) =>
        old === undefined
          ? old
          : {
              ...old,
              items: old.items.map((row) =>
                row.id === bookingId && row.status === "idea"
                  ? { ...row, status: "planned" }
                  : row,
              ),
            },
      );

      // Placeholder item appended to the target day (server default:
      // append — R-ib-15's +1024 gap over the day's current tail).
      qc.setQueryData<ItineraryRead>(itineraryKey, (old) => {
        if (old === undefined) return old;
        const dayTail = old.items
          .filter((item) => item.day === input.day)
          .reduce((max, item) => Math.max(max, item.sort_order), 0);
        const booking = previousBookings?.items.find((row) => row.id === bookingId);
        const placeholder: ItineraryItem = {
          id: optimisticScheduleItemId(bookingId),
          trip_id: tripId,
          kind: "booking",
          booking_id: bookingId,
          place_id: booking?.place_id ?? null,
          title: null,
          notes: null,
          day: input.day,
          end_day: null,
          start_time: input.start_time ?? null,
          end_time: input.end_time ?? null,
          sort_order: dayTail + 1024,
          created_by: booking?.created_by ?? "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        return { ...old, items: [...old.items, placeholder].sort(byCalendarOrder) };
      });

      return { previousItinerary, previousBookings };
    },
    onSuccess: (result, { bookingId }) => {
      options?.onMutationSuccess?.(result);
      // Swap the placeholder for the server post-state (R-ib-18): drop the
      // optimistic row, upsert every returned item, reconcile the booking
      // row + detail cache.
      qc.setQueryData<ItineraryRead>(itineraryKey, (old) => {
        if (old === undefined) return old;
        const withoutPlaceholder = {
          ...old,
          items: old.items.filter((item) => item.id !== optimisticScheduleItemId(bookingId)),
        };
        return result.items.reduce(upsertItineraryItem, withoutPlaceholder);
      });
      reconcileBookingRow(qc, tripId, toBookingRow(result));
      qc.setQueryData<BookingWithItems>(queryKeys.tripBooking(tripId, result.id), result);
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previousItinerary !== undefined) {
        qc.setQueryData(itineraryKey, ctx.previousItinerary);
      }
      if (ctx?.previousBookings !== undefined) {
        qc.setQueryData(listKey, ctx.previousBookings);
      }
      void qc.invalidateQueries({ queryKey: itineraryKey });
      void qc.invalidateQueries({ queryKey: queryKeys.tripBookingsRoot(tripId) });
      options?.onMutationError?.(err);
    },
  });
}
