/**
 * Pending camera intent (T-8.3 / MAP-4 — R-map-17 locate fly-to): the
 * pending-focus store's twin for CAMERA moves. The `Camera` ref lives in the
 * frozen T-8.2 screen and the slot seam carries no camera handle, so
 * slot-side features (locate-me today; a future search-result focus) write
 * the desired move HERE and the screen applies it.
 *
 * DORMANT-EMITTER until the integration rider (PR escalation list): the
 * screen does not drain this store yet — the rider adds a subscribe-and-
 * apply effect mirroring its pending-focus drain (`setCamera(stop)` from
 * `cameraStopFor`-shaped input). Semantics match pending-focus:
 * LAST-SET-WINS, CONSUMED ONCE — a consumed intent never replays on a tab
 * revisit.
 *
 * NO trip scoping (deliberate, unlike pending-focus): the R1 security
 * finding there was a FOREIGN TRIP'S PLACE presenting; a camera move
 * carries only the user's OWN location (never sent to the server — §2.6)
 * or a point the user just tapped, and the map it lands on renders only the
 * active trip's pins — there is no cross-trip data to leak, only a
 * misplaced viewport, and the store clears on consume either way.
 */
import { create } from "zustand";

import type { LngLat } from "./pin-features";

export interface MapCameraIntent {
  center: LngLat;
  zoom: number;
}

interface MapCameraIntentState {
  pending: MapCameraIntent | null;
}

/** Reactive handle (the rider's drain subscribes); actions live below. */
export const useMapCameraIntentStore = create<MapCameraIntentState>(() => ({
  pending: null,
}));

/** Writer side (locate flow): stash the move for the screen to apply. */
export function setPendingCameraIntent(intent: MapCameraIntent): void {
  useMapCameraIntentStore.setState({ pending: intent });
}

/** Consumer side (screen, rider-wired): read AND clear — consumed once. */
export function consumePendingCameraIntent(): MapCameraIntent | null {
  const { pending } = useMapCameraIntentStore.getState();
  if (pending === null) return null;
  useMapCameraIntentStore.setState({ pending: null });
  return pending;
}
