/**
 * Bookings server-state layer (T-7.8 / IT-8) — typed hooks over the merged
 * `bookingEndpoints` (`@gogo/shared` domains/booking.ts, landed T-7.1).
 * Started minimal by the deeplink return-prompt's "add manually" landing
 * (create with `source: 'deeplink_return'`, R-itin-22 / API R-ib-11);
 * T-7.6 (add/edit flows) and T-7.9 (booking detail) EXTEND this module —
 * update/delete/schedule hooks land there, on these same keys.
 *
 * KEY-CACHE LAW (orchestrator-pinned): booking keys join the
 * `["trips", tripId, …]` DETAIL subtree — the `[tripId]` guard's 404-scrub
 * evicts by that prefix, and the collab foreground sweep already refreshes
 * it. NOTHING here may ever touch `["trip-list"]`. Keys live here (not in
 * query-client.ts) to keep this wave conflict-free with T-7.4's parallel
 * key additions; promoting them into `queryKeys` post-merge is fine.
 *
 * Mutation policy (trips §2.6 pattern): create is NOT optimistic — the row
 * is server-generated identity (+ server-derived instants/auto-items), the
 * invite-create precedent; callers show a spinner. Side effects ride the
 * hook-level `onMutationError`/`onMutationSuccess` seam ONLY (T-6.8/T-6.9
 * landmine: TanStack v5 drops per-call callbacks for superseded calls on a
 * shared mutation instance — never hang per-call callbacks on these hooks).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { bookingEndpoints, type Booking, type BookingCreate, type Paginated } from "@gogo/shared";

import { apiClient } from "@/auth";

/**
 * One home for booking cache keys (module doc: detail-subtree by law).
 * `list` is the unfiltered default view (R-ib-10: all except `cancelled`);
 * filtered variants (status/category/unscheduled) get their own trailing
 * args when T-7.6 needs them — extending, never replacing, this prefix.
 */
export const bookingKeys = {
  /** Prefix for every booking key of a trip — the invalidation target. */
  root: (tripId: string) => ["trips", tripId, "bookings"] as const,
  list: (tripId: string) => ["trips", tripId, "bookings"] as const,
  detail: (tripId: string, bookingId: string) => ["trips", tripId, "bookings", bookingId] as const,
} as const;

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
    queryKey: bookingKeys.list(tripId),
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
 * the whole booking prefix for the trip (list + any cached details); the
 * timeless deeplink-return create spawns no itinerary items, so itinerary
 * keys (T-7.4's) are untouched here — timed-create invalidation fan-out is
 * T-7.6's contract when the full add flow lands.
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
      void qc.invalidateQueries({ queryKey: bookingKeys.root(tripId) });
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}
