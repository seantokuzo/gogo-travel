/**
 * Trip context (navigation.spec §2.1) — `[tripId]/_layout` "provides trip
 * context (id, role, dates, theme) to all tabs". T-6.6 grew the T-4.4 id-only
 * seam into the full membership-guarded provider: the layout admits a trip
 * only after `GET /trips/:tripId` proves membership (R-nav-20), so everything
 * under the provider can trust `trip` is a trip the caller belongs to.
 *
 * Why a context and not per-screen `useLocalSearchParams`: in expo-router 57
 * a tab screen's LOCAL params only carry `[tripId]` when the route was built
 * from a URL. Routes the tab navigator instantiates itself (initialRouteName
 * on a bare `/[tripId]` open, tab-bar switches) get no inherited params —
 * verified empirically; `initialParams` on `Tabs.Screen` does not reach the
 * vendored tab router either. The layout DOES resolve the segment param, so
 * it owns the truth and provides it downward — which is what the spec asks
 * for anyway.
 */
import type { TripWithRole } from "@gogo/shared";
import { createContext, use } from "react";
import type { ReactNode } from "react";

const TripContext = createContext<TripWithRole | undefined>(undefined);

export function TripProvider({ trip, children }: { trip: TripWithRole; children: ReactNode }) {
  return <TripContext.Provider value={trip}>{children}</TripContext.Provider>;
}

/** The guarded trip (id, role, dates, theme…) — anywhere under `[tripId]/_layout`. */
export function useTripContext(): TripWithRole {
  const trip = use(TripContext);
  if (trip === undefined) {
    // Contract: every `[tripId]/*` screen mounts under the layout's provider;
    // reaching this means a screen escaped the trip shell (or a guard bypass).
    throw new Error("useTripContext must be used inside the [tripId] layout's TripProvider");
  }
  return trip;
}

/** The active trip id — kept for the T-4.4 consumers; same provider contract. */
export function useTripId(): string {
  return useTripContext().id;
}
