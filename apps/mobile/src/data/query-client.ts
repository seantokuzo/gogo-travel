/**
 * Server-state layer (T-5.8) — the single shared TanStack Query client and the
 * canonical query keys. This is the FIRST server-state infra in the app
 * (ADR-004 locks TanStack Query for server state); screens read/write it only
 * through the typed hooks in `./hooks`.
 *
 * This module stays free of any `@/auth` *barrel* import so the session store
 * can import the client (to clear the cache on sign-out) without a cycle:
 * `session-store → query-client → api-client` is a DAG (api-client imports
 * only `@gogo/shared`).
 */
import { QueryClient } from "@tanstack/react-query";

import { ApiRequestError } from "@/auth/api-client";

/** A few minutes — profile/session/entitlement reads are not hot data. */
const DEFAULT_STALE_TIME = 1000 * 60 * 5;

/**
 * Stable query keys — one home per cached resource. These are UNSCOPED
 * (`["me"]`/`["sessions"]`/`["entitlements"]`, no user id), which is safe ONLY
 * because `signOut()` calls `queryClient.clear()` (nav §2.2): any future
 * user-switch path that bypasses signOut() would leak the previous user's cache
 * and MUST either clear the cache or scope these keys by user id.
 */
export const queryKeys = {
  me: ["me"] as const,
  entitlements: ["entitlements"] as const,
  sessions: ["sessions"] as const,
  /** `GET /trips` first page — the entry redirect + trip switcher read (T-6.6). */
  trips: ["trips"] as const,
  /**
   * `GET /trips` REAL cursor pagination — the trip-list screen's infinite
   * query (T-6.7 / CT-1). Distinct from `trips` (different data shape:
   * `InfiniteData` vs a single page).
   *
   * DISJOINT ROOT on purpose (R1 review): `trip(param)`'s key space is
   * route-param-driven — deep links pass ANY segment through and the guard
   * skips client-side UUID checks (T-6.6 posture), so `tripId` can be an
   * arbitrary string (`gogo://list` was a live collision with a
   * `["trips","list"]` key). The guard's 404-scrub also removes by PREFIX
   * over `trip(tripId)`, so no key under `["trips", ...]` besides the
   * detail keys themselves is safe. Nothing else may ever live under a
   * `["trips", ...]` prefix for the same reason.
   */
  tripsList: ["trip-list"] as const,
  /** `GET /trips/:tripId` — the `[tripId]` membership guard's query (R-nav-20). */
  trip: (tripId: string) => ["trips", tripId] as const,
  /** `GET /places/search` — destination structured search (T-6.7 / CT-2). */
  placeSearch: (q: string) => ["places", "search", q] as const,
  /** `GET /invites/:token` — join-screen preview (R-nav-11). */
  invitePreview: (token: string) => ["invites", token, "preview"] as const,
} as const;

/**
 * "Invalidate the trips list" is a TWO-key operation (R1 review): the entry
 * redirect / trip switcher read `["trips"]` and the list screen reads the
 * disjoint `["trip-list"]` infinite cache — every site that wants the list
 * stale (guard 404-scrub, list focus, create success, and the upcoming CT-3
 * invite-accept / CT-6 push-map "invalidate ['trips']" spec sites) MUST go
 * through this helper or the visible list silently stays stale. Both
 * invalidates are `exact`: `["trips"]` is a PREFIX of every `["trips", id]`
 * detail key — a non-exact match refetch-loops the [tripId] guard (T-6.6,
 * caught live). `refetchType: "none"` marks stale without refetching — for
 * sites where a guaranteed later refetch (e.g. the list's focus effect)
 * does the work.
 */
export function invalidateTripLists(
  qc: QueryClient,
  opts?: { refetchType?: "active" | "none" },
): void {
  const refetchType = opts?.refetchType ?? "active";
  void qc.invalidateQueries({ queryKey: queryKeys.trips, exact: true, refetchType });
  void qc.invalidateQueries({ queryKey: queryKeys.tripsList, exact: true, refetchType });
}

/**
 * Retry policy: never retry a 4xx (deterministic client error — a 400/403/404
 * won't heal, and a 401 already burned the ApiClient's single-flight refresh,
 * so a second one means the session is dead). Transport failures + 5xx get a
 * couple of shots.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      staleTime: DEFAULT_STALE_TIME,
      // No DOM focus events in RN; leave app-state refetch to a later infra
      // task rather than firing a no-op listener.
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
