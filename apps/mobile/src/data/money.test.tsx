/**
 * Money data layer (T-9.5 / CMON-1+CMON-4) — hook-level pins over the REAL
 * TanStack machinery with the network mocked at the descriptor boundary,
 * fixtures wire-schema-validated (money-fixtures parses through the shared
 * schemas, so contract drift fails here, not in prod):
 *
 * - reads: descriptor + params + `{ signal }` forwarded (T-6.6 R1 posture);
 * - `usePutBudget`: wire shape for a real category AND the `total`
 *   pseudo-category; success replaces the cached G1 read with the SERVER's
 *   returned document (the fixture returns caps the client never wrote, so
 *   deleting the reconcile turns the pin red); failure leaves the cache
 *   untouched and fires the hook-level seam — including for a SUPERSEDED
 *   call (the T-6.8/T-6.9 per-call-drop landmine);
 * - `invalidateMoneyData`: the R-cmoney-32 TRIO — expenses root + balances
 *   + budgets together, `["trip-list"]` untouched;
 * - KEY-CACHE LAW pin: all money keys live under the `["trips", tripId]`
 *   detail subtree — `evictTripSubtree`'s prefix removal evicts them
 *   (NAV-4 zero-trip-data).
 *
 * Observer-less cache asserts pin `gcTime: Infinity` (P-6 landmine — a
 * gcTime-0 unobserved entry can be collected mid-assert).
 */
import type { BudgetsRead } from "@gogo/shared";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";

import { evictTripSubtree } from "./collab";
import { invalidateMoneyData, usePutBudget, useTripBalances, useTripBudgets } from "./money";
import { queryKeys } from "./query-client";

import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeBalancesRead, makeBudgetsRead } from "@/test-utils/money-fixtures";

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

// Sync notify scheduler (itinerary.test.tsx pattern): renderHook suites
// otherwise leak a setTimeout(0) notify batch into a waitFor sleep window
// under worker contention (B-2 floating-update class).
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

describe("reads (B1/G1)", () => {
  it("useTripBalances requests the balances descriptor with params + signal", async () => {
    const client = makeClient();
    const doc = makeBalancesRead();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(doc as never);

    const { result } = await renderHook(() => useTripBalances(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/trips/:tripId/balances" }),
      { params: { tripId: TEST_TRIP_ID } },
      { signal: expect.any(AbortSignal) },
    );
    expect(result.current.data).toEqual(doc);
    expect(client.getQueryData(queryKeys.tripBalances(TEST_TRIP_ID))).toEqual(doc);
  });

  it("useTripBudgets requests the budgets descriptor with params + signal", async () => {
    const client = makeClient();
    const doc = makeBudgetsRead();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(doc as never);

    const { result } = await renderHook(() => useTripBudgets(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/trips/:tripId/budgets" }),
      { params: { tripId: TEST_TRIP_ID } },
      { signal: expect.any(AbortSignal) },
    );
    expect(client.getQueryData(queryKeys.tripBudgets(TEST_TRIP_ID))).toEqual(doc);
  });
});

describe("usePutBudget (G2 / R-cmoney-2)", () => {
  it("PUTs a category cap and replaces the cached read with the SERVER's document", async () => {
    const client = makeClient();
    client.setQueryData(queryKeys.tripBudgets(TEST_TRIP_ID), makeBudgetsRead());
    // The server's recomputed doc carries a lodging cap the client never
    // wrote (999) — reconciling from vars instead of the response, or
    // deleting the setQueryData, fails this pin.
    const serverDoc = makeBudgetsRead({
      items: { food: { cap_cents: 2500 }, lodging: { cap_cents: 999 } },
    });
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(serverDoc as never);
    const onMutationSuccess = jest.fn();

    const { result } = await renderHook(() => usePutBudget(TEST_TRIP_ID, { onMutationSuccess }), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({ category: "food", cap_cents: 2500 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT", path: "/trips/:tripId/budgets/:category" }),
      { params: { tripId: TEST_TRIP_ID, category: "food" }, body: { cap_cents: 2500 } },
    );
    expect(client.getQueryData<BudgetsRead>(queryKeys.tripBudgets(TEST_TRIP_ID))).toEqual(
      serverDoc,
    );
    expect(onMutationSuccess).toHaveBeenCalledWith(serverDoc);
  });

  it("the overall trip cap rides the `total` pseudo-category (R-money-20)", async () => {
    const client = makeClient();
    const serverDoc = makeBudgetsRead({ total: { cap_cents: 50000 } });
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(serverDoc as never);

    const { result } = await renderHook(() => usePutBudget(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({ category: "total", cap_cents: 50000 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT", path: "/trips/:tripId/budgets/:category" }),
      { params: { tripId: TEST_TRIP_ID, category: "total" }, body: { cap_cents: 50000 } },
    );
  });

  it("`null` clears a cap on the wire (G2 body verbatim)", async () => {
    const client = makeClient();
    const request = jest
      .spyOn(apiClient, "request")
      .mockResolvedValue(makeBudgetsRead({ items: { food: { cap_cents: null } } }) as never);

    const { result } = await renderHook(() => usePutBudget(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({ category: "food", cap_cents: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(expect.anything(), {
      params: { tripId: TEST_TRIP_ID, category: "food" },
      body: { cap_cents: null },
    });
  });

  it("failure leaves the cache untouched and fires the hook-level seam", async () => {
    const client = makeClient();
    const seeded = makeBudgetsRead();
    client.setQueryData(queryKeys.tripBudgets(TEST_TRIP_ID), seeded);
    jest
      .spyOn(apiClient, "request")
      .mockRejectedValue(new ApiRequestError(403, "FORBIDDEN", "viewer"));
    const onMutationError = jest.fn();

    const { result } = await renderHook(() => usePutBudget(TEST_TRIP_ID, { onMutationError }), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({ category: "food", cap_cents: 100 });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData<BudgetsRead>(queryKeys.tripBudgets(TEST_TRIP_ID))).toEqual(seeded);
    expect(onMutationError).toHaveBeenCalledTimes(1);
    expect(onMutationError).toHaveBeenCalledWith(expect.any(ApiRequestError));
  });

  it("the seam fires for a SUPERSEDED call (per-call callbacks would drop it — T-6.8 landmine)", async () => {
    const client = makeClient();
    let rejectFirst: ((err: unknown) => void) | undefined;
    const first = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    jest
      .spyOn(apiClient, "request")
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => Promise.resolve(makeBudgetsRead()) as never);
    const onMutationError = jest.fn();

    const { result } = await renderHook(() => usePutBudget(TEST_TRIP_ID, { onMutationError }), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      // Two in-flight calls on the SAME mutation instance; the second
      // supersedes the first before it settles.
      result.current.mutate({ category: "food", cap_cents: 100 });
      result.current.mutate({ category: "transport", cap_cents: 200 });
    });
    await act(async () => {
      rejectFirst?.(new ApiRequestError(500, "INTERNAL", "boom"));
      await first.catch(() => undefined);
    });
    await waitFor(() => expect(onMutationError).toHaveBeenCalledTimes(1));
  });
});

describe("invalidateMoneyData (R-cmoney-32 trio)", () => {
  it("invalidates expenses root + balances + budgets together; trip-list untouched", () => {
    const client = makeClient();
    const invalidate = jest.spyOn(client, "invalidateQueries");

    invalidateMoneyData(client, TEST_TRIP_ID);

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tripExpensesRoot(TEST_TRIP_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBalances(TEST_TRIP_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBudgets(TEST_TRIP_ID) });
    // Control arm: no call targets the trips/trip-list keys.
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.tripsList }),
    );
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.trips }),
    );
  });
});

describe("key-cache law: detail-subtree eviction (NAV-4 pin)", () => {
  it("the guard's prefix scrub evicts balances + budgets + expenses-root caches; trip-list survives", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.tripBalances(TEST_TRIP_ID), makeBalancesRead());
    client.setQueryData(queryKeys.tripBudgets(TEST_TRIP_ID), makeBudgetsRead());
    client.setQueryData(queryKeys.tripExpensesRoot(TEST_TRIP_ID), { items: [] });
    client.setQueryData(queryKeys.tripsList, { pages: [] });

    evictTripSubtree(client, TEST_TRIP_ID);

    expect(client.getQueryData(queryKeys.tripBalances(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryData(queryKeys.tripBudgets(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryData(queryKeys.tripExpensesRoot(TEST_TRIP_ID))).toBeUndefined();
    // Control arm: the disjoint trip-list root is NOT under the prefix.
    expect(client.getQueryData(queryKeys.tripsList)).toEqual({ pages: [] });
  });
});
