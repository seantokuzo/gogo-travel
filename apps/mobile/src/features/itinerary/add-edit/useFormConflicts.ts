/**
 * R-itin-20 form conflict seam (T-7.5 / IT-4): the live form's pending
 * placement(s) → the existing items they would land on top of.
 *
 * Reads the SAME two queries the plan screen already holds
 * (`useItinerary` + `useItineraryBookings`), so on the usual path — the form
 * opened from the itinerary tab — this costs nothing: TanStack serves both
 * from cache under the identical keys. Cold entry (a deep link straight into
 * the modal) just fetches them; the notice appears when the data lands and
 * never blocks the form in the meantime.
 *
 * Not memoized on purpose: `findPlacementConflicts` is O(day items) over a
 * per-trip set that is small by construction, and the placements array is
 * rebuilt from form state on every keystroke anyway — a memo keyed on it
 * would have to stringify the array to be correct, which costs more than the
 * scan it saves.
 */
import { useMemo } from "react";

import { useItinerary, useItineraryBookings } from "@/data";

import {
  findPlacementConflicts,
  type ConflictHit,
  type PlacementCandidate,
} from "../conflicts";

export interface FormConflictExclusions {
  /** Edit mode: the item being edited can't conflict with itself. */
  itemIds?: readonly string[];
  /** Booking edit: every auto-item of THIS booking is excluded (R-ib-5). */
  bookingId?: string | null;
}

export function useFormConflicts(
  tripId: string,
  placements: readonly PlacementCandidate[],
  exclude: FormConflictExclusions = {},
): ConflictHit[] {
  const itineraryQuery = useItinerary(tripId);
  const bookingsQuery = useItineraryBookings(tripId);

  const bookingsById = useMemo(() => {
    const bookings = bookingsQuery.data?.items ?? [];
    return new Map(bookings.map((booking) => [booking.id, booking]));
  }, [bookingsQuery.data]);

  const items = itineraryQuery.data?.items ?? [];
  if (items.length === 0 || placements.length === 0) return [];

  return findPlacementConflicts(placements, {
    items,
    bookingsById,
    ...(exclude.itemIds !== undefined ? { excludeItemIds: exclude.itemIds } : null),
    ...(exclude.bookingId !== undefined ? { excludeBookingId: exclude.bookingId } : null),
  });
}
