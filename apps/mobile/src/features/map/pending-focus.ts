/**
 * FROZEN SEAM (c) — pending map focus (T-8.2 / MAP-1; filled by **T-8.4**,
 * MAP-6 / R-map-24; the today spec's quick action reuses it, §2.7).
 *
 * The `focusPlaceId` transport ruling (P-8 prep, binding): imperative
 * cross-tab pushes SILENTLY NO-OP inside the vendored tab navigator
 * (mobile.md landmine), so "view on map" params CANNOT ride a URL push.
 * Senders instead (1) write the {tripId, placeId} pair here, then (2) jump
 * tabs via `jumpToTripTab(nav, tripId, "map")`; the map screen DRAINS the
 * store on focus and feeds its `onPinSelect` contract.
 *
 * Semantics: LAST-SET-WINS, CONSUMED ONCE, TRIP-SCOPED. A consume returns
 * the pending id and clears it, so a later tab revisit never re-triggers the
 * focus (§2.7 "param consumed once"). TRIP SCOPING (R1 review, sec A5): the
 * jump can be interrupted (the exact vendored-navigator class this transport
 * dodges), leaving an armed id to survive into ANOTHER trip's map focus —
 * so a consume for a DIFFERENT trip discards-and-clears instead of
 * presenting a foreign trip's place. T-8.4 wires the SENDERS
 * (itinerary/today surfaces) — this module's API is the frozen contract and
 * does not change for it. (The contract gained `tripId` in this PR's R1 fix
 * leg — before any sender existed, so no caller migration.)
 */
import { create } from "zustand";

interface PendingMapFocus {
  tripId: string;
  placeId: string;
}

interface PendingMapFocusState {
  pending: PendingMapFocus | null;
}

/** Reactive handle (screen/store subscriptions); actions live below. */
export const usePendingMapFocusStore = create<PendingMapFocusState>(() => ({
  pending: null,
}));

/** Sender side (T-8.4): stash the place to focus, then jump to the map tab. */
export function setPendingMapFocus(tripId: string, placeId: string): void {
  usePendingMapFocusStore.setState({ pending: { tripId, placeId } });
}

/**
 * Consumer side (map screen, on focus): read AND clear — consumed once.
 * A pending focus armed for a DIFFERENT trip is DISCARDED (and cleared):
 * stale cross-trip state never presents (module doc).
 */
export function consumePendingMapFocus(tripId: string): string | null {
  const { pending } = usePendingMapFocusStore.getState();
  if (pending === null) return null;
  usePendingMapFocusStore.setState({ pending: null });
  return pending.tripId === tripId ? pending.placeId : null;
}
