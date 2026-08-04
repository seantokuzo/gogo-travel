/**
 * Offline signal for the trip surfaces (T-7.9 / IT-10 — client itinerary spec
 * R-itin-29). Derived from the query cache; no connectivity library, no new
 * dependency, no global store.
 *
 * WHY DERIVED, NOT MEASURED: the app ships no connectivity module —
 * `@react-native-community/netinfo` (or `expo-network`) is a new dependency,
 * which is an escalation, not an implementation detail (reported in the PR).
 * TanStack's own `onlineManager` is not a substitute: without a subscriber it
 * reports `online: true` forever in React Native, so gating on it would render
 * the online surface while every request black-holes.
 *
 * What we DO have is an unambiguous transport marker: `api-client.ts` maps
 * every fetch rejection (DNS failure, no route, the 12 s `REQUEST_TIMEOUT_MS`
 * abort) to `ApiRequestError(0, "NETWORK")`, and nothing else in the app
 * produces `status === 0` — every server-originated error carries a real HTTP
 * status. So "some request for this trip failed at the transport layer" is a
 * sound, false-positive-free reading of "the device can't reach the API".
 *
 * SCOPE OF THE SIGNAL (deliberate, documented in the PR as an interpretation):
 * it turns TRUE only after a request has actually failed, so a surface whose
 * data is still fresh (5 min `staleTime`) can be offline without knowing it.
 * That is the correct trade for R-itin-29's two obligations: the "render from
 * cache" arm needs no signal at all (the cache renders either way — the
 * requirement is that nothing BLANKS it), and the "disable deeplink-out" arm
 * is a courtesy that costs nothing when it engages one request late. A true
 * connectivity source belongs to the offline spec.
 *
 * TRIP-SCOPED, cache-subscribed: any query under the `["trips", tripId, …]`
 * DETAIL subtree (key-cache law) contributes — including the `[tripId]`
 * membership guard's own query, which is the earliest and loudest failure when
 * a trip is opened with no network. One failing read therefore degrades the
 * whole tab, which is what "the active trip is offline" means.
 */
import { useQueryClient, type QueryCache } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { ApiRequestError } from "@/auth/api-client";

import { queryKeys } from "./query-client";

/**
 * Transport failure ⇒ offline. `status === 0` is `api-client.ts`'s marker for
 * "the fetch never produced a response"; a 4xx/5xx is the server talking, and
 * the server talking means the network works.
 */
export function isOfflineError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 0;
}

/**
 * Does any cached query for this trip currently hold a transport failure?
 * Pure over the cache so it is testable without a component (and so the hook
 * below is a thin `useSyncExternalStore` wrapper).
 *
 * A successful fetch clears `state.error`, so recovery is automatic: the flag
 * falls back to false as soon as any one of the trip's reads lands.
 */
export function tripHasOfflineError(cache: QueryCache, tripId: string): boolean {
  return cache
    .findAll({ queryKey: queryKeys.trip(tripId) })
    .some((query) => isOfflineError(query.state.error));
}

/**
 * Subscribe to the trip's offline state. `useSyncExternalStore` over the query
 * cache rather than a query-level `isError` read: surfaces that are NOT the one
 * making the failing request (the booking detail's deeplink panel, the add
 * form's) still need the signal, and the cache is the one place all of them
 * already share. The snapshot is a boolean, so React bails out of re-renders
 * for every cache event that doesn't change it.
 */
export function useTripOffline(tripId: string): boolean {
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback(
    (onStoreChange: () => void) => cache.subscribe(onStoreChange),
    [cache],
  );
  const getSnapshot = useCallback(() => tripHasOfflineError(cache, tripId), [cache, tripId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
