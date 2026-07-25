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
} as const;

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
