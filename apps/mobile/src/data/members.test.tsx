/**
 * Member-mutation seam pins (T-6.9, dispositioned from T-6.8 round 2). The
 * load-bearing case: TanStack v5 fires PER-CALL `mutate` callbacks only for
 * the LATEST call on a mutation instance — a success side effect (the
 * invite-create share-sheet open) hung on a per-call `onSuccess` is silently
 * dropped when a second create supersedes the first mid-flight. The
 * hook-LEVEL `onMutationSuccess` seam fires for EVERY settled call; this
 * suite holds two POSTs open at once and pins both notifications.
 */
import type { InviteWithUrl } from "@gogo/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";
import { useCreateInvite } from "@/data/members";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { TEST_USER } from "@/test-utils/session-fixtures";

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeInviteWithUrl(id: string, token: string): InviteWithUrl {
  return {
    id,
    trip_id: TEST_TRIP_ID,
    token,
    role: "editor",
    created_by: TEST_USER.id,
    expires_at: "2026-08-02T00:00:00.000Z",
    revoked_at: null,
    max_uses: null,
    use_count: 0,
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
    url: `https://links.gogo.example/invite/${token}`,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

it("onMutationSuccess fires for BOTH of two in-flight creates — per-call onSuccess would drop the superseded first", async () => {
  const client = makeTestQueryClient();
  client.setQueryDefaults(queryKeys.tripInvites(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryData(queryKeys.tripInvites(TEST_TRIP_ID), { items: [], nextCursor: null });

  const resolvers: ((invite: InviteWithUrl) => void)[] = [];
  spyRequest().mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
  const onMutationSuccess = jest.fn();
  const perCallSuccess = jest.fn();

  const { result } = await renderHook(
    () => useCreateInvite(TEST_TRIP_ID, { onMutationSuccess }),
    { wrapper: makeWrapper(client) },
  );

  // Two creates, the second while the first is still in flight (the
  // superseding call) — the per-call handle rides BOTH calls to prove the
  // drop this seam exists for.
  await act(async () => {
    result.current.mutate({ role: "editor" }, { onSuccess: perCallSuccess });
  });
  await act(async () => {
    result.current.mutate({ role: "viewer" }, { onSuccess: perCallSuccess });
  });
  expect(resolvers).toHaveLength(2);

  const first = makeInviteWithUrl("11111111-aaaa-4aaa-8aaa-111111111111", "tok-first");
  const second = makeInviteWithUrl("22222222-bbbb-4bbb-8bbb-222222222222", "tok-second");
  await act(async () => resolvers[0]?.(first));
  await act(async () => resolvers[1]?.(second));
  await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledTimes(2));

  // The seam saw BOTH settled creates, in settle order…
  expect(onMutationSuccess).toHaveBeenNthCalledWith(1, first);
  expect(onMutationSuccess).toHaveBeenNthCalledWith(2, second);
  // …while TanStack dropped the superseded call's per-call callback (v5
  // contract — the documented reason side effects must not live per-call).
  expect(perCallSuccess).toHaveBeenCalledTimes(1);
  expect(perCallSuccess.mock.calls[0]?.[0]).toEqual(second);
});
