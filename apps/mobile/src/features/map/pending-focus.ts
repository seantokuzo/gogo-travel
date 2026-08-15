/**
 * FROZEN SEAM (c) — pending map focus (T-8.2 / MAP-1; filled by **T-8.4**,
 * MAP-6 / R-map-24; the today spec's quick action reuses it, §2.7).
 *
 * The `focusPlaceId` transport ruling (P-8 prep, binding): imperative
 * cross-tab pushes SILENTLY NO-OP inside the vendored tab navigator
 * (mobile.md landmine), so "view on map" params CANNOT ride a URL push.
 * Senders instead (1) write the place id here, then (2) jump tabs via
 * `jumpToTripTab(nav, tripId, "map")`; the map screen DRAINS the store on
 * focus and feeds its `onPinSelect` contract.
 *
 * Semantics: LAST-SET-WINS, CONSUMED ONCE. A consume returns the pending id
 * and clears it, so a later tab revisit never re-triggers the focus
 * (§2.7 "param consumed once"). T-8.4 wires the SENDERS (itinerary/today
 * surfaces) — this module's API is the frozen contract and does not change
 * for it.
 */
import { create } from "zustand";

interface PendingMapFocusState {
  pendingPlaceId: string | null;
}

/** Reactive handle (screen/store subscriptions); actions live below. */
export const usePendingMapFocusStore = create<PendingMapFocusState>(() => ({
  pendingPlaceId: null,
}));

/** Sender side (T-8.4): stash the place to focus, then jump to the map tab. */
export function setPendingMapFocus(placeId: string): void {
  usePendingMapFocusStore.setState({ pendingPlaceId: placeId });
}

/** Consumer side (map screen, on focus): read AND clear — consumed once. */
export function consumePendingMapFocus(): string | null {
  const { pendingPlaceId } = usePendingMapFocusStore.getState();
  if (pendingPlaceId !== null) usePendingMapFocusStore.setState({ pendingPlaceId: null });
  return pendingPlaceId;
}
