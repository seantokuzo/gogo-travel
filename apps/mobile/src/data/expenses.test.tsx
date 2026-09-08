/**
 * Expense data layer (T-9.6 / CMON-2+CMON-3) — hook-level pins over the
 * REAL TanStack machinery, network mocked at the descriptor boundary,
 * fixtures wire-schema-validated (money-fixtures parses through the shared
 * schemas, so T-9.2/T-9.4 contract drift fails HERE):
 *
 * - `useTripExpenses`: E2 descriptor + filters on the wire, the shared
 *   `Paginated` cursor round-trip (`nextCursor` → `?cursor=`, null = stop),
 *   and per-filter cache keys under the frozen `tripExpensesRoot` prefix;
 * - mutations: E1/E4/E5 wire shapes; EVERY success runs the R-cmoney-32
 *   trio (delete `invalidateMoneyData` from a success arm ⇒ its pin goes
 *   RED — the mutation map's kill-check #3);
 * - `useUpdateExpense`: response seeds the detail cache; the LWW guard
 *   cancels an in-flight detail read before reconciling (T-9.5 R1 class);
 * - `useFxRate`: OUR proxy only, disabled = no request.
 */
import type { Expense } from "@gogo/shared";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";

import {
  useCreateExpense,
  useDeleteExpense,
  useFxRate,
  useTripExpenses,
  useUpdateExpense,
} from "./expenses";
import { queryKeys } from "./query-client";

import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  makeExpense,
  makeExpensesPage,
  makeFxRateRead,
  TEST_EXPENSE_ID,
} from "@/test-utils/money-fixtures";

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

// Sync notify scheduler (money.test.tsx pattern — the B-2 floating-update class).
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

describe("useTripExpenses (E2 infinite list)", () => {
  it("first page: descriptor + params, filters on the query, signal forwarded", async () => {
    const client = makeClient();
    const page = makeExpensesPage([makeExpense()]);
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(page as never);

    const { result } = await renderHook(
      () =>
        useTripExpenses(TEST_TRIP_ID, {
          member: "11111111-1111-4111-8111-111111111199",
          category: "food",
        }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/trips/:tripId/expenses" }),
      {
        params: { tripId: TEST_TRIP_ID },
        query: { member: "11111111-1111-4111-8111-111111111199", category: "food" },
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("cursor round-trip: nextCursor rides ?cursor= and null stops the crawl", async () => {
    const client = makeClient();
    const first = makeExpensesPage([makeExpense()], "cursor-1");
    const second = makeExpensesPage(
      [makeExpense({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab9", description: "Museum" })],
      null,
    );
    const request = jest
      .spyOn(apiClient, "request")
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(second as never);

    const { result } = await renderHook(() => useTripExpenses(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

    expect(request).toHaveBeenLastCalledWith(
      expect.anything(),
      { params: { tripId: TEST_TRIP_ID }, query: { cursor: "cursor-1" } },
      { signal: expect.any(AbortSignal) },
    );
    expect(result.current.hasNextPage).toBe(false);
  });

  it("KEY-CACHE LAW: every filter variant lives under the frozen invalidation root", () => {
    const root = queryKeys.tripExpensesRoot(TEST_TRIP_ID);
    for (const key of [
      queryKeys.tripExpenses(TEST_TRIP_ID, {}),
      queryKeys.tripExpenses(TEST_TRIP_ID, { member: "m", category: "food" }),
      queryKeys.tripExpense(TEST_TRIP_ID, TEST_EXPENSE_ID),
    ]) {
      expect(key.slice(0, root.length)).toEqual([...root]);
    }
    // …and the list discriminator can never collide with a detail key
    // (expense ids are UUIDs, "list" is not).
    expect(queryKeys.tripExpenses(TEST_TRIP_ID, {})[3]).toBe("list");
  });
});

describe("mutations run the R-cmoney-32 trio", () => {
  const created = makeExpense();

  it("useCreateExpense posts the E1 body and invalidates expenses+balances+budgets", async () => {
    const client = makeClient();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(created as never);
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const seam = jest.fn();

    const { result } = await renderHook(
      () => useCreateExpense(TEST_TRIP_ID, { onMutationSuccess: seam }),
      { wrapper: wrapperFor(client) },
    );
    const body = {
      description: created.description,
      category: created.category,
      paid_by: created.paid_by,
      amount_cents: created.amount_cents,
      currency: created.currency,
      spent_at: created.spent_at,
      shares: created.shares,
    };
    await act(async () => {
      result.current.mutate(body);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/trips/:tripId/expenses" }),
      { params: { tripId: TEST_TRIP_ID }, body },
    );
    expect(seam).toHaveBeenCalledWith(created);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tripExpensesRoot(TEST_TRIP_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBalances(TEST_TRIP_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBudgets(TEST_TRIP_ID) });
  });

  it("useUpdateExpense seeds the detail cache with the response, then invalidates the trio", async () => {
    const client = makeClient();
    const updated = makeExpense({ description: "Dinner — corrected" });
    jest.spyOn(apiClient, "request").mockResolvedValue(updated as never);
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const cancel = jest.spyOn(client, "cancelQueries");

    const { result } = await renderHook(() => useUpdateExpense(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({
        expenseId: TEST_EXPENSE_ID,
        input: { description: "Dinner — corrected" },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // LWW guard: the in-flight detail read is cancelled BEFORE reconciling.
    expect(cancel).toHaveBeenCalledWith({
      queryKey: queryKeys.tripExpense(TEST_TRIP_ID, TEST_EXPENSE_ID),
    });
    expect(
      client.getQueryData<Expense>(queryKeys.tripExpense(TEST_TRIP_ID, TEST_EXPENSE_ID)),
    ).toEqual(updated);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tripExpensesRoot(TEST_TRIP_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBalances(TEST_TRIP_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBudgets(TEST_TRIP_ID) });
  });

  it("useDeleteExpense sends E5 and invalidates the trio (detail key rides the prefix)", async () => {
    const client = makeClient();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
    const invalidate = jest.spyOn(client, "invalidateQueries");

    const { result } = await renderHook(() => useDeleteExpense(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate(TEST_EXPENSE_ID);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/trips/:tripId/expenses/:expenseId" }),
      { params: { tripId: TEST_TRIP_ID, expenseId: TEST_EXPENSE_ID } },
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tripExpensesRoot(TEST_TRIP_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBalances(TEST_TRIP_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tripBudgets(TEST_TRIP_ID) });
  });

  it("mutation failure fires the hook-level seam and invalidates NOTHING", async () => {
    const client = makeClient();
    jest.spyOn(apiClient, "request").mockRejectedValue(new Error("boom"));
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const onError = jest.fn();

    const { result } = await renderHook(
      () => useDeleteExpense(TEST_TRIP_ID, { onMutationError: onError }),
      { wrapper: wrapperFor(client) },
    );
    await act(async () => {
      result.current.mutate(TEST_EXPENSE_ID);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(onError).toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("useFxRate (the ruling-③ proxy)", () => {
  it("requests OUR endpoint with base/quote; disabled fires nothing", async () => {
    const client = makeClient();
    const doc = makeFxRateRead();
    const request = jest.spyOn(apiClient, "request").mockResolvedValue(doc as never);

    const { result } = await renderHook(() => useFxRate("EUR", "USD", { enabled: true }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/fx/rate" }),
      { query: { base: "EUR", quote: "USD" } },
      { signal: expect.any(AbortSignal) },
    );

    request.mockClear();
    await renderHook(() => useFxRate("EUR", "USD", { enabled: false }), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(request).not.toHaveBeenCalled();
  });
});
