/**
 * Settle data layer (T-9.7 / CMON-5+CMON-6) — hook-level pins over the REAL
 * TanStack machinery with the network mocked at the descriptor boundary
 * (data/money.test.tsx is the harness precedent):
 *
 * - reads: descriptor + params + `{ signal }` forwarded;
 * - `useCreateSettlement`: S1 body verbatim; success invalidates the
 *   R-cmoney-32 TRIO + settlements + (when linked) the request detail;
 *   the 409 error arm ALSO refreshes the request detail (truth posture);
 * - `useCreateSettleRequest`: Q1 body verbatim; success fires the seam
 *   with the wire response and invalidates NOTHING (no list endpoint —
 *   the flagged spec gap; a request changes no balance);
 * - `useCancelSettleRequest`: Q3; request detail refreshed on success AND
 *   on the 409 already-moved arm;
 * - KEY-CACHE LAW pin: settle keys live under the `["trips", tripId]`
 *   detail subtree — `evictTripSubtree` prefix removal evicts them.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";

import { evictTripSubtree } from "./collab";
import { queryKeys } from "./query-client";
import {
  useCancelSettleRequest,
  useCreateSettlement,
  useCreateSettleRequest,
  useSettleRequestDetail,
  useTripSettlements,
} from "./settlements";

import { MEMBER_B_ID, TEST_TRIP_ID } from "@/test-utils/ids";
import {
  makeSettleRequestDetail,
  makeSettlement,
  TEST_REQUEST_ID,
} from "@/test-utils/settle-fixtures";
import { makeSettleRequest } from "@/test-utils/money-fixtures";
import { TEST_USER } from "@/test-utils/session-fixtures";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

// Sync notify scheduler (data/money.test.tsx pattern — B-2 floating-update class).
beforeAll(() => {
  notifyManager.setScheduler((cb) => cb());
});
afterAll(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

describe("reads (Q2/S2)", () => {
  it("useSettleRequestDetail requests the Q2 descriptor with params + signal", async () => {
    const client = makeClient();
    const doc = makeSettleRequestDetail();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(doc as never);

    const { result } = await renderHook(
      () => useSettleRequestDetail(TEST_TRIP_ID, TEST_REQUEST_ID),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/trips/:tripId/settle-requests/:requestId" }),
      { params: { tripId: TEST_TRIP_ID, requestId: TEST_REQUEST_ID } },
      { signal: expect.any(AbortSignal) },
    );
    expect(result.current.data).toEqual(doc);
    expect(client.getQueryData(queryKeys.tripSettleRequest(TEST_TRIP_ID, TEST_REQUEST_ID))).toEqual(
      doc,
    );
  });

  it("useTripSettlements requests the S2 descriptor (first page)", async () => {
    const client = makeClient();
    const page = { items: [makeSettlement()], nextCursor: null };
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(page as never);

    const { result } = await renderHook(() => useTripSettlements(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/trips/:tripId/settlements" }),
      { params: { tripId: TEST_TRIP_ID }, query: {} },
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe("useCreateSettlement (S1)", () => {
  const body = {
    from_user_id: TEST_USER.id,
    to_user_id: MEMBER_B_ID,
    amount_cents: 2550,
    currency: "USD",
    method: "venmo",
  } as const;

  it("POSTs the SettlementCreate body verbatim and invalidates trio + settlements", async () => {
    const client = makeClient();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(makeSettlement() as never);
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const onMutationSuccess = jest.fn();

    const { result } = await renderHook(
      () => useCreateSettlement(TEST_TRIP_ID, { onMutationSuccess }),
      { wrapper: wrapperFor(client) },
    );
    await act(async () => {
      result.current.mutate({ ...body });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/trips/:tripId/settlements" }),
      { params: { tripId: TEST_TRIP_ID }, body: { ...body } },
    );
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(queryKeys.tripExpensesRoot(TEST_TRIP_ID));
    expect(keys).toContainEqual(queryKeys.tripBalances(TEST_TRIP_ID));
    expect(keys).toContainEqual(queryKeys.tripBudgets(TEST_TRIP_ID));
    expect(keys).toContainEqual(queryKeys.tripSettlements(TEST_TRIP_ID));
    expect(onMutationSuccess).toHaveBeenCalledWith(makeSettlement());
  });

  it("with request_id: the linked request detail invalidates on success", async () => {
    const client = makeClient();
    jest.spyOn(apiClient, "request").mockResolvedValue(makeSettlement() as never);
    const invalidate = jest.spyOn(client, "invalidateQueries");

    const { result } = await renderHook(() => useCreateSettlement(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({ ...body, request_id: TEST_REQUEST_ID });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(
      queryKeys.tripSettleRequest(TEST_TRIP_ID, TEST_REQUEST_ID),
    );
  });

  it("409 on a linked POST fires the seam AND refreshes the request detail (truth posture)", async () => {
    const client = makeClient();
    const conflict = new ApiRequestError(409, "CONFLICT", "request is not open");
    jest.spyOn(apiClient, "request").mockRejectedValue(conflict);
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const onMutationError = jest.fn();

    const { result } = await renderHook(
      () => useCreateSettlement(TEST_TRIP_ID, { onMutationError }),
      { wrapper: wrapperFor(client) },
    );
    await act(async () => {
      result.current.mutate({ ...body, request_id: TEST_REQUEST_ID });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(onMutationError).toHaveBeenCalledWith(conflict);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(
      queryKeys.tripSettleRequest(TEST_TRIP_ID, TEST_REQUEST_ID),
    );
    // Control: the trio did NOT invalidate on failure.
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).not.toContainEqual(
      queryKeys.tripBalances(TEST_TRIP_ID),
    );
  });
});

describe("useCreateSettleRequest (Q1)", () => {
  it("POSTs the SettleRequestCreate body verbatim and hands the wire response to the seam", async () => {
    const client = makeClient();
    const response = makeSettleRequest();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const onMutationSuccess = jest.fn();

    const { result } = await renderHook(
      () => useCreateSettleRequest(TEST_TRIP_ID, { onMutationSuccess }),
      { wrapper: wrapperFor(client) },
    );
    await act(async () => {
      result.current.mutate({ from_user_id: MEMBER_B_ID, amount_cents: 2550 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/trips/:tripId/settle-requests" }),
      {
        params: { tripId: TEST_TRIP_ID },
        body: { from_user_id: MEMBER_B_ID, amount_cents: 2550 },
      },
    );
    expect(onMutationSuccess).toHaveBeenCalledWith(response);
    // No list endpoint exists (flagged spec gap) and no balance changed —
    // creating a request invalidates NOTHING.
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("useCancelSettleRequest (Q3)", () => {
  it("DELETEs and refreshes the request detail on success and on the 409 arm", async () => {
    const client = makeClient();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
    const invalidate = jest.spyOn(client, "invalidateQueries");

    const { result } = await renderHook(() => useCancelSettleRequest(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({ requestId: TEST_REQUEST_ID });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/trips/:tripId/settle-requests/:requestId",
      }),
      { params: { tripId: TEST_TRIP_ID, requestId: TEST_REQUEST_ID } },
    );
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(
      queryKeys.tripSettleRequest(TEST_TRIP_ID, TEST_REQUEST_ID),
    );

    // 409 arm (already settled/cancelled elsewhere) — still refreshes.
    invalidate.mockClear();
    (apiClient.request as jest.Mock).mockRejectedValue(
      new ApiRequestError(409, "CONFLICT", "not open"),
    );
    await act(async () => {
      result.current.mutate({ requestId: TEST_REQUEST_ID });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(
      queryKeys.tripSettleRequest(TEST_TRIP_ID, TEST_REQUEST_ID),
    );
  });
});

describe("key-cache law (NAV-4 zero-trip-data)", () => {
  it("evictTripSubtree removes the settle keys with the trip", () => {
    const client = makeClient();
    client.setQueryData(
      queryKeys.tripSettleRequest(TEST_TRIP_ID, TEST_REQUEST_ID),
      makeSettleRequestDetail(),
    );
    client.setQueryData(queryKeys.tripSettlements(TEST_TRIP_ID), {
      items: [makeSettlement()],
      nextCursor: null,
    });

    evictTripSubtree(client, TEST_TRIP_ID);

    expect(
      client.getQueryData(queryKeys.tripSettleRequest(TEST_TRIP_ID, TEST_REQUEST_ID)),
    ).toBeUndefined();
    expect(client.getQueryData(queryKeys.tripSettlements(TEST_TRIP_ID))).toBeUndefined();
  });
});
