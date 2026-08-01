/**
 * Itinerary data layer (T-7.4 / IT-2 — R-itin-2, api R-ib-15/18) — hook-level
 * pins over the REAL TanStack machinery with the network mocked by
 * descriptor:
 *
 * - optimistic apply → wire PUT shape → reconcile to the SERVER's post-state
 *   (the fixture returns sort_orders the optimistic arm did NOT predict, so
 *   deleting the reconcile turns the pin red — R-ib-18 falsifiability);
 * - failure → rollback to the pre-mutation snapshot (visible-revert half);
 * - the hook-level `onMutationError` seam fires for a SUPERSEDED call (the
 *   T-6.8/T-6.9 per-call-drop landmine, discriminating probe);
 * - KEY-CACHE LAW pin: `tripItinerary`/`tripBookings` live under the
 *   `["trips", tripId]` detail subtree — the guard's 404-scrub /
 *   `evictTripSubtree` prefix removal evicts them (NAV-4 zero-trip-data),
 *   and `["trip-list"]` is untouched.
 *
 * Observer-less cache asserts pin `gcTime: Infinity` (P-6 landmine — a
 * gcTime-0 unobserved entry can be collected mid-assert).
 */
import type { ItineraryRead } from "@gogo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";

import { evictTripSubtree } from "./collab";
import { applyDayOrder, reconcileDayOrder, useDayOrder } from "./itinerary";
import { queryKeys } from "./query-client";

import {
  defaultItineraryItems,
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_LODGING_ID,
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

function seededRead(): ItineraryRead {
  return { items: defaultItineraryItems(), legs: [] };
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(async () => {
  // Absorb any tail-of-test TanStack notify batch (setTimeout 0) into an act
  // scope — a mutation's late notification otherwise fires inside the next
  // test's window (B-2 floating-update class; contention-only).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

describe("applyDayOrder (optimistic arm)", () => {
  it("reassigns listed ids to the day at 1024×position and re-sorts; unlisted untouched", () => {
    const next = applyDayOrder(seededRead(), TRIP_DAY_2, [ITEM_B_ID]);
    const moved = next.items.find((i) => i.id === ITEM_B_ID);
    expect(moved?.day).toBe(TRIP_DAY_2);
    expect(moved?.sort_order).toBe(1024);
    // Unlisted survivors keep their sort_order (R-ib-15 — reorder touches
    // only the listed set).
    const survivor = next.items.find((i) => i.id === ITEM_A_ID);
    expect(survivor?.day).toBe(TRIP_START);
    expect(survivor?.sort_order).toBe(1024);
    // Re-sorted by (day, sort_order): the moved row now renders after day-1 rows.
    expect(next.items[next.items.length - 2]?.id).toBe(ITEM_B_ID);
  });

  it("ignores ids not in the cache (server LWW mirror)", () => {
    const next = applyDayOrder(seededRead(), TRIP_START, [
      "99999999-9999-4999-8999-999999999999",
      ITEM_A_ID,
    ]);
    expect(next.items).toHaveLength(seededRead().items.length);
    expect(next.items.find((i) => i.id === ITEM_A_ID)?.sort_order).toBe(2048);
  });
});

describe("reconcileDayOrder (R-ib-18)", () => {
  it("the server's post-state replaces the day wholesale — including rows the optimistic arm kept", () => {
    const optimistic = applyDayOrder(seededRead(), TRIP_START, [ITEM_B_ID, ITEM_A_ID]);
    // Server post-state: A was deleted concurrently (LWW-ignored), so only B
    // survives, at a sort_order the client never assigned.
    const server = [
      makeItineraryItem({ id: ITEM_B_ID, title: "Walk Shibuya", sort_order: 1024 }),
      makeItineraryItem({
        id: ITEM_LODGING_ID,
        kind: "booking",
        booking_id: "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
        title: null,
        end_day: "2027-03-03",
        sort_order: 2048,
      }),
    ];
    const next = reconcileDayOrder(optimistic, TRIP_START, server);
    const day1 = next.items.filter((i) => i.day === TRIP_START);
    expect(day1.map((i) => i.id)).toEqual([ITEM_B_ID, ITEM_LODGING_ID]);
    // A is gone everywhere — the server's day list is the whole truth.
    expect(next.items.find((i) => i.id === ITEM_A_ID)).toBeUndefined();
  });
});

describe("useDayOrder", () => {
  it("round-trip: optimistic apply → wire PUT → reconcile to the server's (diverging) post-state", async () => {
    const client = makeClient();
    client.setQueryData(queryKeys.tripItinerary(TEST_TRIP_ID), seededRead());
    // Server compacts to sort_orders the optimistic arm did NOT compute
    // (5000/6000/7000): the final cache must equal the SERVER's numbers, so
    // deleting the reconcile (or reconciling from vars) fails this pin.
    const serverItems = [ITEM_B_ID, ITEM_A_ID, ITEM_LODGING_ID].map((id, index) => {
      const item = seededRead().items.find((i) => i.id === id);
      if (item === undefined) throw new Error("fixture miss");
      return { ...item, sort_order: 5000 + index * 1000 };
    });
    const request = jest
      .spyOn(apiClient, "request")
      .mockResolvedValue({ items: serverItems } as never);

    const { result } = await renderHook(() => useDayOrder(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({
        day: TRIP_START,
        itemIds: [ITEM_B_ID, ITEM_A_ID, ITEM_LODGING_ID],
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT", path: "/trips/:tripId/itinerary/days/:day/order" }),
      {
        params: { tripId: TEST_TRIP_ID, day: TRIP_START },
        body: { item_ids: [ITEM_B_ID, ITEM_A_ID, ITEM_LODGING_ID] },
      },
    );
    const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
    const day1 = read?.items.filter((i) => i.day === TRIP_START) ?? [];
    expect(day1.map((i) => [i.id, i.sort_order])).toEqual([
      [ITEM_B_ID, 5000],
      [ITEM_A_ID, 6000],
      [ITEM_LODGING_ID, 7000],
    ]);
  });

  it("failure rolls the cache back to the pre-mutation snapshot and fires the seam", async () => {
    const client = makeClient();
    client.setQueryData(queryKeys.tripItinerary(TEST_TRIP_ID), seededRead());
    jest
      .spyOn(apiClient, "request")
      .mockRejectedValue(new ApiRequestError(400, "VALIDATION_FAILED", "nope"));
    const onMutationError = jest.fn();

    const { result } = await renderHook(() => useDayOrder(TEST_TRIP_ID, { onMutationError }), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      result.current.mutate({ day: TRIP_DAY_2, itemIds: [ITEM_B_ID] });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
    // Byte-identical rollback: B is back on day 1 at its seeded sort_order.
    expect(read?.items).toEqual(seededRead().items);
    expect(onMutationError).toHaveBeenCalledTimes(1);
    expect(onMutationError).toHaveBeenCalledWith(expect.any(ApiRequestError));
  });

  it("the seam fires for a SUPERSEDED call (per-call callbacks would drop it — T-6.8 landmine)", async () => {
    const client = makeClient();
    client.setQueryData(queryKeys.tripItinerary(TEST_TRIP_ID), seededRead());
    let rejectFirst: ((err: unknown) => void) | undefined;
    const first = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    jest
      .spyOn(apiClient, "request")
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => Promise.resolve({ items: [] }) as never);
    const onMutationError = jest.fn();

    const { result } = await renderHook(() => useDayOrder(TEST_TRIP_ID, { onMutationError }), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      // Two in-flight calls on the SAME mutation instance; the second
      // supersedes the first before it settles.
      result.current.mutate({ day: TRIP_START, itemIds: [ITEM_A_ID] });
      result.current.mutate({ day: TRIP_START, itemIds: [ITEM_B_ID] });
    });
    await act(async () => {
      rejectFirst?.(new ApiRequestError(500, "INTERNAL", "boom"));
      await first.catch(() => undefined);
    });
    await waitFor(() => expect(onMutationError).toHaveBeenCalledTimes(1));
  });
});

describe("key-cache law: detail-subtree eviction (NAV-4 pin)", () => {
  it("the guard's prefix scrub evicts itinerary + bookings caches; trip-list survives", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.tripItinerary(TEST_TRIP_ID), seededRead());
    client.setQueryData(queryKeys.tripBookings(TEST_TRIP_ID), { items: [], nextCursor: null });
    client.setQueryData(queryKeys.trip(TEST_TRIP_ID), { id: TEST_TRIP_ID });
    client.setQueryData(queryKeys.tripItinerary(TRIP_B_ID), seededRead());
    client.setQueryData(queryKeys.tripsList, { pages: [], pageParams: [] });

    // evictTripSubtree AND the [tripId] guard's post-404 teardown both run
    // exactly this prefix removal — the shape under pin.
    evictTripSubtree(client, TEST_TRIP_ID);

    expect(client.getQueryData(queryKeys.tripItinerary(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryData(queryKeys.tripBookings(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryData(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined();
    // Another trip's subtree and the disjoint list root are untouched.
    expect(client.getQueryData(queryKeys.tripItinerary(TRIP_B_ID))).toBeDefined();
    expect(client.getQueryData(queryKeys.tripsList)).toBeDefined();
  });
});
