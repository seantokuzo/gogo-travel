/**
 * Members & invites server-state layer (T-6.8 / CT-3+CT-4) — the typed hooks
 * for the member/invite wire family (`@gogo/shared` domains/member.ts).
 *
 * Mutation policy is trips spec §2.6, FOLLOWED EXACTLY:
 * - OPTIMISTIC (cache update → reconcile with the returned row → rollback +
 *   ErrorBanner on error): role change, member remove/leave, invite revoke.
 * - NOT optimistic (server-generated identity/membership — spinner instead):
 *   invite ACCEPT; invite create (server mints token/url) reconciles by
 *   appending the returned row.
 * - Transfer ownership is deliberately NOT optimistic either: it is a
 *   two-row transactional swap §2.6 never lists as optimistic; the response
 *   carries BOTH updated rows (R-trips-19) and reconciles the cache.
 *
 * Rollbacks re-sync truth with an invalidate on error (a 404/409 means the
 * cache was stale — e.g. the target already left); success paths reconcile
 * from returned rows without an extra fetch (R-trips-19). Every QUERY
 * forwards TanStack's `{ signal }` (T-6.6 R1 cancellation/timeout posture).
 *
 * Token hygiene (round-1 security finding): the invites LIST wire shape
 * carries each row's live bearer `token` — the UI never uses it, so the
 * query layer strips it before anything lands in the cache (`InviteRow`).
 * Removing it from the wire itself is a server-side QUEUE row.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  inviteEndpoints,
  memberEndpoints,
  type InviteAccept,
  type InviteGrantableRole,
  type InviteListItem,
  type InviteWithUrl,
  type MemberList,
  type OwnershipTransferResult,
  type Paginated,
  type TripMember,
} from "@gogo/shared";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/**
 * Mutation-error seam for screens (round-1, via the concurrency pin):
 * TanStack fires PER-CALL `mutate` callbacks only for the LATEST call on a
 * mutation instance — with two in-flight row actions, the first failure's
 * per-call `onError` (the screen's banner) is silently dropped. Hook-LEVEL
 * callbacks fire for every in-flight mutation, so screens hand their banner
 * setter here instead of per-call.
 */
export interface MemberMutationOptions {
  onMutationError?(error: unknown): void;
}

/** `GET /trips/:tripId/members` — live members only (ghosts server-excluded). */
export function useTripMembers(tripId: string): UseQueryResult<MemberList, Error> {
  return useQuery({
    queryKey: queryKeys.tripMembers(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(memberEndpoints.listMembers, { params: { tripId } }, { signal }),
  });
}

/**
 * An invites-list row as CACHED: the wire `InviteListItem` minus its live
 * bearer `token` (never rendered, never needed client-side — hygiene above).
 */
export type InviteRow = Omit<InviteListItem, "token">;

function stripInviteToken(item: InviteListItem): InviteRow {
  const { token: _token, ...row } = item;
  return row;
}

/**
 * `GET /trips/:tripId/invites` — active AND dead invites, flagged (§3.2:
 * owner/editor only). Callers gate `enabled` on the caller's role so a
 * viewer never fires the guaranteed-403 request (R-tripui-14 — the UI hides
 * the affordance; the server matrix still enforces). One page: trip invite
 * sets are small (§3.5 rule 5 posture, same rationale as `useTrips`).
 */
export function useTripInvites(
  tripId: string,
  options?: { enabled?: boolean },
): UseQueryResult<Paginated<InviteRow>, Error> {
  return useQuery({
    queryKey: queryKeys.tripInvites(tripId),
    queryFn: async ({ signal }) => {
      const page = await apiClient.request(
        inviteEndpoints.listInvites,
        { params: { tripId }, query: {} },
        { signal },
      );
      // Strip the bearer token BEFORE caching (module doc: token hygiene).
      return { ...page, items: page.items.map(stripInviteToken) };
    },
    enabled: options?.enabled ?? true,
  });
}

/**
 * `POST /invites/:token/accept` (R-tripui-12) — NOT optimistic (§2.6: the
 * membership row is server-generated; the screen shows a spinner). Accept is
 * idempotent for existing members (R-trips-15: 200 + `already_member`, no
 * `use_count` increment) — the already-member "Open trip" path re-uses this
 * mutation because the preview deliberately withholds `trip_id` until
 * acceptance (token-capability posture, §3.3).
 *
 * Success invalidates the trips LIST (`exact` — the T-6.6 landmine: the list
 * key is a prefix of every detail key) so the joined trip appears when the
 * list next renders; navigation into `/[tripId]` is the screen's move. It
 * also EVICTS the token's preview entry (round-1): the preview flips
 * `already_member` server-side on acceptance, and a cached pre-accept copy
 * inside staleTime would replay the "Join as <role>" card on a link re-tap
 * instead of the already-member notice.
 */
export function useAcceptInvite(): UseMutationResult<InviteAccept, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiClient.request(inviteEndpoints.acceptInvite, { params: { token } }),
    onSuccess: (_data, token) => {
      void qc.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
      qc.removeQueries({ queryKey: queryKeys.invitePreview(token) });
    },
  });
}

export interface MemberRoleUpdateVars {
  userId: string;
  role: InviteGrantableRole;
}

interface MembersSnapshot {
  previous: MemberList | undefined;
}

/**
 * `PATCH /trips/:tripId/members/:userId` — owner-only editor↔viewer flip
 * (R-trips-9: never grants/revokes owner). OPTIMISTIC per §2.6.
 */
export function useUpdateMemberRole(
  tripId: string,
  options?: MemberMutationOptions,
): UseMutationResult<TripMember, Error, MemberRoleUpdateVars, MembersSnapshot> {
  const qc = useQueryClient();
  const key = queryKeys.tripMembers(tripId);
  return useMutation({
    mutationFn: ({ userId, role }: MemberRoleUpdateVars) =>
      apiClient.request(memberEndpoints.updateMemberRole, {
        params: { tripId, userId },
        body: { role },
      }),
    onMutate: async ({ userId, role }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MemberList>(key);
      qc.setQueryData<MemberList>(key, (old) =>
        old === undefined
          ? old
          : { items: old.items.map((m) => (m.user.id === userId ? { ...m, role } : m)) },
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous);
      // The optimistic premise was stale (target left, role raced) — re-sync.
      void qc.invalidateQueries({ queryKey: key });
      options?.onMutationError?.(err);
    },
    onSuccess: (row) => {
      // Reconcile with the returned row (R-trips-19) — no extra fetch.
      qc.setQueryData<MemberList>(key, (old) =>
        old === undefined
          ? old
          : {
              items: old.items.map((m) =>
                m.user.id === row.user_id ? { ...m, role: row.role, joined_at: row.joined_at } : m,
              ),
            },
      );
    },
  });
}

/**
 * `DELETE /trips/:tripId/members/:userId` — owner removes others; any member
 * leaves self (R-trips-11). OPTIMISTIC removal per §2.6. Owner leave always
 * 409s (`owner_transfer_required` with other members, `delete_trip_instead`
 * when sole member) — the UI never offers it, and the rollback + mapped
 * banner covers the race where ownership shifted under an open screen.
 * Self-leave callers (trip settings, T-6.9 — see features/members
 * LEAVE_TRIP_CONFIRM) handle navigation per-call.
 */
export function useRemoveMember(
  tripId: string,
  options?: MemberMutationOptions,
): UseMutationResult<void, Error, { userId: string }, MembersSnapshot> {
  const qc = useQueryClient();
  const key = queryKeys.tripMembers(tripId);
  return useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      apiClient.request(memberEndpoints.removeMember, { params: { tripId, userId } }),
    onMutate: async ({ userId }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MemberList>(key);
      qc.setQueryData<MemberList>(key, (old) =>
        old === undefined ? old : { items: old.items.filter((m) => m.user.id !== userId) },
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous);
      void qc.invalidateQueries({ queryKey: key });
      options?.onMutationError?.(err);
    },
    onSuccess: () => {
      // 204 — nothing to reconcile; the trips list's member_count is stale.
      void qc.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
    },
  });
}

/**
 * `POST /trips/:tripId/transfer-ownership` (R-trips-10) — demote + promote in
 * one server transaction; response carries BOTH rows. Not optimistic (see
 * module doc). The trip detail invalidate refreshes the caller's own role in
 * the mounted `[tripId]` guard/TripProvider, which re-gates every affordance
 * (§2.6 "refetch own role — gates re-render").
 */
export function useTransferOwnership(
  tripId: string,
  options?: MemberMutationOptions,
): UseMutationResult<OwnershipTransferResult, Error, { toUserId: string }> {
  const qc = useQueryClient();
  const key = queryKeys.tripMembers(tripId);
  return useMutation({
    mutationFn: ({ toUserId }: { toUserId: string }) =>
      apiClient.request(memberEndpoints.transferOwnership, {
        params: { tripId },
        body: { to_user_id: toUserId },
      }),
    onSuccess: (result) => {
      qc.setQueryData<MemberList>(key, (old) =>
        old === undefined
          ? old
          : {
              items: old.items.map((m) => {
                const row = result.items.find((r) => r.user_id === m.user.id);
                return row === undefined ? m : { ...m, role: row.role, joined_at: row.joined_at };
              }),
            },
      );
      void qc.invalidateQueries({ queryKey: queryKeys.trip(tripId), exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
    },
    onError: (err) => {
      // Not optimistic, so nothing to roll back — but a 404 means the target
      // left under an open screen: refetch so the list matches the error copy
      // ("the list has been refreshed", error-copy.ts).
      void qc.invalidateQueries({ queryKey: key });
      options?.onMutationError?.(err);
    },
  });
}

/**
 * `POST /trips/:tripId/invites` (R-tripui-16) — server mints token/url/expiry
 * (7-day default), so no optimistic row; the returned row is appended as the
 * reconcile. Opening the OS share sheet with `url` is the screen's move.
 */
export function useCreateInvite(
  tripId: string,
  options?: MemberMutationOptions,
): UseMutationResult<InviteWithUrl, Error, { role: InviteGrantableRole }> {
  const qc = useQueryClient();
  const key = queryKeys.tripInvites(tripId);
  return useMutation({
    mutationFn: ({ role }: { role: InviteGrantableRole }) =>
      apiClient.request(inviteEndpoints.createInvite, { params: { tripId }, body: { role } }),
    onSuccess: (invite) => {
      // Reconcile by appending — minus `url` (create-response-only) and the
      // bearer `token` (cache hygiene, module doc). If the cache is empty
      // (create raced the initial GET, or a prior list error), an append has
      // nothing to land on — invalidate so the new invite isn't invisible
      // until staleTime lapses (round-1).
      const existing = qc.getQueryData<Paginated<InviteRow>>(key);
      if (existing === undefined) {
        void qc.invalidateQueries({ queryKey: key });
        return;
      }
      const { url: _url, ...wireRow } = invite;
      const row = stripInviteToken({ ...wireRow, state: "active" });
      qc.setQueryData<Paginated<InviteRow>>(key, {
        ...existing,
        items: [...existing.items, row],
      });
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

/**
 * `DELETE /trips/:tripId/invites/:inviteId` (R-trips-17) — owner: any;
 * editor: own. OPTIMISTIC per §2.6: the row flips to `revoked` in place
 * (rows are never deleted as a revocation path — the list stays honest).
 */
export function useRevokeInvite(
  tripId: string,
  options?: MemberMutationOptions,
): UseMutationResult<
  void,
  Error,
  { inviteId: string },
  { previous: Paginated<InviteRow> | undefined }
> {
  const qc = useQueryClient();
  const key = queryKeys.tripInvites(tripId);
  return useMutation({
    mutationFn: ({ inviteId }: { inviteId: string }) =>
      apiClient.request(inviteEndpoints.revokeInvite, { params: { tripId, inviteId } }),
    onMutate: async ({ inviteId }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Paginated<InviteRow>>(key);
      qc.setQueryData<Paginated<InviteRow>>(key, (old) =>
        old === undefined
          ? old
          : {
              ...old,
              items: old.items.map((i) =>
                i.id === inviteId ? { ...i, state: "revoked" as const } : i,
              ),
            },
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous);
      // 409 already_revoked / 404 mean the cache lied — refetch the truth.
      void qc.invalidateQueries({ queryKey: key });
      options?.onMutationError?.(err);
    },
  });
}
