/**
 * Bookings data-layer pins (T-7.8 / IT-8). Load-bearing cases:
 *  - KEY-CACHE LAW: booking keys join the `["trips", tripId, …]` detail
 *    subtree (never `["trip-list"]`) — pinned structurally so a refactor
 *    that drifts the root fails loudly.
 *  - Hook-level `onMutationSuccess` fires for BOTH of two in-flight creates
 *    (the T-6.8/T-6.9 superseded-call landmine — members.test.tsx proves
 *    the drop; here we pin that the NEW hooks honor the same seam).
 *  - Create success invalidates the booking prefix (list + cached details).
 *
 * Sync notify scheduler + apiClient spy per the members.test.tsx pattern.
 */
import { bookingEndpoints, type Booking, type Paginated } from "@gogo/shared";
import { notifyManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";
import { useCreateBooking, useTripBookings } from "@/data/bookings";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeBooking(id: string): Booking {
  return { id } as unknown as Booking;
}

beforeAll(() => {
  notifyManager.setScheduler((cb) => cb());
});
afterAll(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

afterEach(() => {
  jest.restoreAllMocks();
});

it("booking keys join the trip-detail subtree (KEY-CACHE LAW; promoted into queryKeys per the T-7.6 key-homing ruling)", () => {
  expect(queryKeys.tripBookingsRoot(TEST_TRIP_ID)).toEqual(["trips", TEST_TRIP_ID, "bookings"]);
  expect(queryKeys.tripBookings(TEST_TRIP_ID)).toEqual(["trips", TEST_TRIP_ID, "bookings"]);
  expect(queryKeys.tripBooking(TEST_TRIP_ID, "b-1")).toEqual([
    "trips",
    TEST_TRIP_ID,
    "bookings",
    "b-1",
  ]);
  // Filtered variants EXTEND the list prefix with trailing args (never
  // replace it) — invalidating the root reaches them by prefix.
  expect(queryKeys.tripBookingsCancelled(TEST_TRIP_ID)).toEqual([
    "trips",
    TEST_TRIP_ID,
    "bookings",
    "cancelled",
  ]);
});

it("useTripBookings requests the list descriptor (signal forwarded) and caches under the list key", async () => {
  const client = makeTestQueryClient();
  const page: Paginated<Booking> = { items: [makeBooking("b-1")], nextCursor: null };
  spyRequest().mockResolvedValue(page);

  const { result } = await renderHook(() => useTripBookings(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(apiClient.request).toHaveBeenCalledWith(
    bookingEndpoints.listBookings,
    { params: { tripId: TEST_TRIP_ID }, query: { limit: 100 } },
    expect.objectContaining({ signal: expect.anything() }),
  );
  expect(client.getQueryData(queryKeys.tripBookings(TEST_TRIP_ID))).toEqual(page);
});

it("useCreateBooking: hook-level onMutationSuccess fires for BOTH in-flight creates; success invalidates the booking prefix", async () => {
  const client = makeTestQueryClient();
  // Seed a list AND a cached detail — the prefix invalidation must reach both.
  client.setQueryDefaults(queryKeys.tripBookings(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryData(queryKeys.tripBookings(TEST_TRIP_ID), { items: [], nextCursor: null });
  client.setQueryDefaults(queryKeys.tripBooking(TEST_TRIP_ID, "b-0"), { gcTime: Infinity });
  client.setQueryData(queryKeys.tripBooking(TEST_TRIP_ID, "b-0"), makeBooking("b-0"));

  const resolvers: ((booking: Booking) => void)[] = [];
  spyRequest().mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
  const onMutationSuccess = jest.fn();

  const { result } = await renderHook(() => useCreateBooking(TEST_TRIP_ID, { onMutationSuccess }), {
    wrapper: makeWrapper(client),
  });

  await act(async () => {
    result.current.mutate({ category: "lodging", title: "First", source: "deeplink_return" });
  });
  await act(async () => {
    result.current.mutate({ category: "flight", title: "Second" });
  });
  expect(resolvers).toHaveLength(2);

  await act(async () => resolvers[0]?.(makeBooking("b-1")));
  await act(async () => resolvers[1]?.(makeBooking("b-2")));
  await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledTimes(2));
  expect(onMutationSuccess).toHaveBeenNthCalledWith(1, makeBooking("b-1"));
  expect(onMutationSuccess).toHaveBeenNthCalledWith(2, makeBooking("b-2"));

  expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.tripBooking(TEST_TRIP_ID, "b-0"))?.isInvalidated).toBe(true);
});

it("useCreateBooking error rides the hook-level onMutationError and leaves the cache alone", async () => {
  const client = makeTestQueryClient();
  client.setQueryDefaults(queryKeys.tripBookings(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryData(queryKeys.tripBookings(TEST_TRIP_ID), { items: [], nextCursor: null });
  const failure = new Error("500");
  spyRequest().mockRejectedValue(failure);
  const onMutationError = jest.fn();

  const { result } = await renderHook(() => useCreateBooking(TEST_TRIP_ID, { onMutationError }), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ category: "other", title: "Nope" });
  });
  await waitFor(() => expect(onMutationError).toHaveBeenCalledWith(failure));
  expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(false);
});
