/**
 * Typed server-state hooks (T-5.8) — the ONLY sanctioned way screens touch the
 * profile/session/entitlement API. Each hook wraps `apiClient.request(descriptor,
 * input)` over a `@gogo/shared` endpoint descriptor, so the wire shape stays the
 * backend's (both-direction runtime validation happens inside the ApiClient).
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
  userEndpoints,
  type AuthSessionInfo,
  type EffectiveEntitlements,
  type Paginated,
  type PaymentHandles,
  type PaymentHandlesUpdate,
  type User,
  type UserUpdate,
} from "@gogo/shared";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/** `GET /users/me` — the caller's full profile (R-user-1). */
export function useMe(): UseQueryResult<User, Error> {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiClient.request(userEndpoints.getMe, {}),
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
    queryFn: () => apiClient.request(entitlementEndpoints.getMyEntitlements, {}),
  });
}

/** `GET /auth/sessions` — active sessions, `current` flags this device (R-auth-13). */
export function useSessions(): UseQueryResult<Paginated<AuthSessionInfo>, Error> {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => apiClient.request(authEndpoints.listSessions, { query: {} }),
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
