/**
 * Sheet place resolution (T-8.3 / MAP-2 — R-map-4): `onPinSelect` hands the
 * slot a bare placeId; the sheet needs the full spine row. Resolution reads
 * the TQ-cached saved-places list — the SAME rows the pin builders resolved
 * coordinates through, so every id a rendered pin can emit resolves here by
 * construction (saved pins carry their own place; itinerary pins only exist
 * when their place is in this index — pin-features doc).
 *
 * UNRESOLVED ⇒ null ⇒ no sheet (binding ruling: pin coverage is
 * interim-limited to saved/indexed places; the structural closure is a
 * PARKED spec decision — no improvised coordinate/row source here). The
 * reachable unresolved case is a T-8.4 pending-focus send for a place never
 * saved: the map also has no pin for it, so "nothing presents" is the
 * consistent degrade, and map-tap still clears the screen's selection
 * state. Search-result selections don't pass through this lookup at all —
 * the slot holds the full row from the tapped result.
 */
import type { Place, SavedPlaceWithPlace } from "@gogo/shared";

export function savedPlaceRowFor(
  savedPlaces: readonly SavedPlaceWithPlace[] | undefined,
  placeId: string,
): Place | null {
  if (savedPlaces === undefined) return null;
  for (const saved of savedPlaces) {
    if (saved.place.id === placeId) return saved.place;
  }
  return null;
}
