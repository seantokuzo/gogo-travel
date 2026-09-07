/**
 * Last-used zone per trip (B-9 client half — the zone picker's default
 * ladder, B-8 row: "a tz picker defaulting to the destination (and to the
 * trip's base) is the minimum"). Rungs: the zone the trip's forms last
 * SUBMITTED (arrival zone when set, else departure) → the device zone. A
 * trip has no base-zone field on the wire (trip.ts), so "the trip's base"
 * is this remembered rung until a trip zone exists.
 *
 * Zustand, session-scoped, in-memory (ADR-004 client state): a wrong
 * default costs one tap in an always-visible picker; persisting it would
 * add an MMKV surface for no B-8 correctness gain.
 */
import { create } from "zustand";

import { deviceTimeZone } from "./zoned-time";

interface LastZoneState {
  zonesByTrip: Readonly<Record<string, string>>;
  remember(tripId: string, tz: string): void;
  reset(): void;
}

export const useLastZoneStore = create<LastZoneState>()((set) => ({
  zonesByTrip: {},
  remember: (tripId, tz) =>
    set((state) => ({ zonesByTrip: { ...state.zonesByTrip, [tripId]: tz } })),
  reset: () => set({ zonesByTrip: {} }),
}));

/** The ladder: last zone submitted in this trip's forms → device zone. */
export function defaultZoneFor(tripId: string): string {
  return useLastZoneStore.getState().zonesByTrip[tripId] ?? deviceTimeZone();
}

/**
 * Sign-out hygiene (B-9 R1, security lane) — the `resetTabMemory()` /
 * `clearLastViewedTrip()` class. This map is keyed by TRIP, not by user, so
 * on a shared device two collaborators on the same trip share a rung: user
 * B's next booking form would default its zone picker to the zone user A
 * last submitted. Wired into the session store's `onSignedOut`.
 */
export function resetLastZones(): void {
  useLastZoneStore.getState().reset();
}

/** Record the zone a submitted form used (arrival wins — the next leg starts there). */
export function rememberTripZone(tripId: string, tz: string): void {
  if (tz === "") return;
  useLastZoneStore.getState().remember(tripId, tz);
}
