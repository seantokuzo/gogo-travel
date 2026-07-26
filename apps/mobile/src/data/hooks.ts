/**
 * Typed server-state hooks (T-5.8) — the ONLY sanctioned way screens touch the
 * profile/session/entitlement API. Each hook wraps `apiClient.request(descriptor,
 * input)` over a `@gogo/shared` endpoint descriptor, so the wire shape stays the
 * backend's (both-direction runtime validation happens inside the ApiClient).
 *
 * Every QUERY forwards TanStack's `{ signal }` into the client (T-6.6 R1):
 * cancellation propagates to the fetch, and the client caps each request at
 * `REQUEST_TIMEOUT_MS` so a stalled network settles into error surfaces
 * instead of pinning boot/guard holds forever.
 *
 * Mutations keep the cache honest:
 * - `useUpdateMe` writes the returned `User` straight into the `me` cache.
 * - `usePaymentHandlesUpdate` invalidates `me` (handles live on the User row).
 * - `useRevokeSession` invalidates `sessions`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  authEndpoints,
  entitlementEndpoints,
  inviteEndpoints,
  tripEndpoints,
  userEndpoints,
  type AuthSessionInfo,
  type EffectiveEntitlements,
  type InvitePreview,
  type Paginated,
  type PaymentHandles,
  type PaymentHandlesUpdate,
  type TripListItem,
  type TripWithRole,
  type User,
  type UserUpdate,
} from "@gogo/shared";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/** `GET /users/me` — the caller's full profile (R-user-1). */
export function useMe(): UseQueryResult<User, Error> {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => apiClient.request(userEndpoints.getMe, {}, { signal }),
  });
}

/** `PATCH /users/me` — display_name/prefs/avatar_key (R-user-2/3). */
export function useUpdateMe(): UseMutationResult<User, Error, UserUpdate> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UserUpdate) => apiClient.request(userEndpoints.updateMe, { body: input }),
    onSuccess: (user) => {
      qc.setQueryData(queryKeys.me, user);
    },
  });
}

/** `PATCH /users/me/payment-handles` (R-user-5..7). Handles ride the User row. */
export function usePaymentHandlesUpdate(): UseMutationResult<
  PaymentHandles,
  Error,
  PaymentHandlesUpdate
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PaymentHandlesUpdate) =>
      apiClient.request(userEndpoints.updatePaymentHandles, { body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** `GET /users/me/entitlements` — display-only plan/caps (R-ent-1/2). */
export function useEntitlements(): UseQueryResult<EffectiveEntitlements, Error> {
  return useQuery({
    queryKey: queryKeys.entitlements,
    queryFn: ({ signal }) => apiClient.request(entitlementEndpoints.getMyEntitlements, {}, { signal }),
  });
}

/** `GET /auth/sessions` — active sessions, `current` flags this device (R-auth-13). */
export function useSessions(): UseQueryResult<Paginated<AuthSessionInfo>, Error> {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: ({ signal }) => apiClient.request(authEndpoints.listSessions, { query: {} }, { signal }),
  });
}

/**
 * `GET /trips` first page (T-6.6 / NAV-3) — the entry redirect's "which trips
 * are active" read (R-nav-5/6/23) and the trip switcher's active set.
 *
 * One page at the server's cap (`TripListQuerySchema` max = 100): the launch
 * decision needs the caller's active set, and 100 memberships is far beyond
 * the MVP ceiling. Real list pagination (infinite query over `nextCursor`)
 * is the trip-list screen's concern (T-6.7), not the redirect's.
 */
const TRIPS_PAGE_LIMIT = 100;

export function useTrips(options?: {
  enabled?: boolean;
}): UseQueryResult<Paginated<TripListItem>, Error> {
  return useQuery({
    queryKey: queryKeys.trips,
    queryFn: ({ signal }) =>
      apiClient.request(tripEndpoints.listTrips, { query: { limit: TRIPS_PAGE_LIMIT } }, { signal }),
    enabled: options?.enabled ?? true,
  });
}

/**
 * `GET /trips/:tripId` (T-6.6 / NAV-4) — the `[tripId]` layout's membership
 * gate (R-nav-20). The server's 404 is indistinguishable across nonexistent /
 * non-member / malformed ids (R-trips-1); the guard maps it to the no-access
 * state (R-nav-15) without any client-side existence oracle.
 */
export function useTrip(tripId: string): UseQueryResult<TripWithRole, Error> {
  return useQuery({
    queryKey: queryKeys.trip(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(tripEndpoints.getTrip, { params: { tripId } }, { signal }),
    // R-nav-20 (round-1 review): membership is re-verified on EVERY mount of
    // the guard — a cached "member" verdict can be revoked server-side at any
    // moment, so a fresh cache entry must never skip the verification request.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

/**
 * `GET /invites/:token` (T-6.6 / NAV-5) — join-screen preview (R-nav-11).
 * Token is the capability; a dead token comes back either as a 404 (unknown)
 * or with a non-`active` `state` (expired/revoked/max-uses) — the screen
 * folds both into the same error surface.
 */
export function useInvitePreview(token: string): UseQueryResult<InvitePreview, Error> {
  return useQuery({
    queryKey: queryKeys.invitePreview(token),
    queryFn: ({ signal }) =>
      apiClient.request(inviteEndpoints.previewInvite, { params: { token } }, { signal }),
  });
}

/** `DELETE /auth/sessions/:sessionId` — revoke one session (R-auth-13). */
export function useRevokeSession(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiClient.request(authEndpoints.revokeSession, { params: { sessionId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}
