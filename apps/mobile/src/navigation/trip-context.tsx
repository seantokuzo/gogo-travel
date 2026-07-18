/**
 * Trip context seam (navigation.spec §2.1) — `[tripId]/_layout` "provides
 * trip context (id, role, dates, theme) to all tabs". The skeleton ships the
 * id; NAV-4 grows this into the full membership-guarded provider.
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
import { createContext, use } from "react";
import type { ReactNode } from "react";

const TripIdContext = createContext<string | undefined>(undefined);

export function TripIdProvider({ tripId, children }: { tripId: string; children: ReactNode }) {
  return <TripIdContext.Provider value={tripId}>{children}</TripIdContext.Provider>;
}

/** The active trip id — usable anywhere under `[tripId]/_layout`. */
export function useTripId(): string {
  const tripId = use(TripIdContext);
  if (tripId === undefined) {
    // Skeleton contract: every `[tripId]/*` screen mounts under the layout's
    // provider; reaching this means a screen escaped the trip shell.
    throw new Error("useTripId must be used inside the [tripId] layout's TripIdProvider");
  }
  return tripId;
}
