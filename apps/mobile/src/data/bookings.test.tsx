/**
 * Bookings data-layer pins (T-7.8 / IT-8 base; T-7.6 / IT-5+IT-7
 * extensions). Load-bearing cases:
 *  - KEY-CACHE LAW: booking keys join the `["trips", tripId, …]` detail
 *    subtree (never `["trip-list"]`) — pinned structurally so a refactor
 *    that drifts the root fails loudly.
 *  - Hook-level `onMutationSuccess` fires for BOTH of two in-flight creates
 *    (the T-6.8/T-6.9 superseded-call landmine — members.test.tsx proves
 *    the drop; here we pin that the NEW hooks honor the same seam).
 *  - Create success invalidates the booking prefix (list + cached details)
 *    and — the T-7.6 fan-out — the composite itinerary read exactly when
 *    the create could have spawned auto-items (I-2).
 *  - `useScheduleBooking` optimism (R-itin-11): placeholder item + badge
 *    advance on mutate, server post-state swap on success, full snapshot
 *    rollback + invalidation on error.
 *
 * Sync notify scheduler + apiClient spy per the members.test.tsx pattern.
 * Observer-less cache asserts pin `gcTime: Infinity` (P-6 landmine).
 */
import {
  bookingEndpoints,
  type Booking,
  type BookingWithItems,
  type ItineraryItem,
  type ItineraryRead,
  type Paginated,
} from "@gogo/shared";
import { notifyManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";
import {
  optimisticScheduleItemId,
  useBooking,
  useCancelledBookings,
  useCreateBooking,
  useScheduleBooking,
  useTripBookings,
  useUpdateBooking,
} from "@/data/bookings";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeBooking as makeWireBooking, makeItineraryItem } from "@/test-utils/itinerary-fixtures";
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

// ---------------------------------------------------------------------------
// T-7.6 / IT-5+IT-7 extensions
// ---------------------------------------------------------------------------

const BOOKING_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const OTHER_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const SERVER_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const DAY = "2027-03-02";

function seedItinerary(client: QueryClient, items: ItineraryItem[]): void {
  client.setQueryDefaults(queryKeys.tripItinerary(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID), { items, legs: [] });
}

function seedBookingList(client: QueryClient, bookings: Booking[]): void {
  client.setQueryDefaults(queryKeys.tripBookings(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID), {
    items: bookings,
    nextCursor: null,
  });
}

it("a timed non-idea create ALSO invalidates the composite itinerary read (I-2 fan-out)", async () => {
  const client = makeTestQueryClient();
  seedItinerary(client, []);
  spyRequest().mockResolvedValue(
    makeWireBooking({ id: BOOKING_ID, status: "planned", starts_at: "2027-03-02T10:00:00.000Z" }),
  );
  const { result } = await renderHook(() => useCreateBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ category: "flight", title: "Timed" });
  });
  await waitFor(() =>
    expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true),
  );
});

it("a timeless idea create leaves the itinerary read untouched (no phantom refetch)", async () => {
  const client = makeTestQueryClient();
  seedItinerary(client, []);
  spyRequest().mockResolvedValue(
    makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null }),
  );
  const { result } = await renderHook(() => useCreateBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ category: "activity", title: "Idea" });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(false);
});

it("useBooking caches the BookingWithItems detail under the tripBooking key", async () => {
  const client = makeTestQueryClient();
  const detail: BookingWithItems = { ...makeWireBooking({ id: BOOKING_ID }), items: [] };
  spyRequest().mockResolvedValue(detail);
  const { result } = await renderHook(() => useBooking(TEST_TRIP_ID, BOOKING_ID), {
    wrapper: makeWrapper(client),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiClient.request).toHaveBeenCalledWith(
    bookingEndpoints.getBooking,
    { params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_ID } },
    expect.objectContaining({ signal: expect.anything() }),
  );
  expect(client.getQueryData(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID))).toEqual(detail);
});

it("useCancelledBookings requests status=cancelled and caches under the trailing-arg key", async () => {
  const client = makeTestQueryClient();
  const page: Paginated<Booking> = {
    items: [makeWireBooking({ id: BOOKING_ID, status: "cancelled" })],
    nextCursor: null,
  };
  spyRequest().mockResolvedValue(page);
  const { result } = await renderHook(() => useCancelledBookings(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiClient.request).toHaveBeenCalledWith(
    bookingEndpoints.listBookings,
    { params: { tripId: TEST_TRIP_ID }, query: { status: "cancelled", limit: 100 } },
    expect.objectContaining({ signal: expect.anything() }),
  );
  expect(client.getQueryData(queryKeys.tripBookingsCancelled(TEST_TRIP_ID))).toEqual(page);
});

it("useUpdateBooking reconciles detail + list row to the post-state and invalidates root + itinerary (R-ib-18)", async () => {
  const client = makeTestQueryClient();
  seedItinerary(client, []);
  seedBookingList(client, [makeWireBooking({ id: BOOKING_ID, title: "Old title" })]);
  const postState: BookingWithItems = {
    ...makeWireBooking({ id: BOOKING_ID, title: "New title" }),
    items: [],
  };
  spyRequest().mockResolvedValue(postState);
  const onMutationSuccess = jest.fn();

  const { result } = await renderHook(() => useUpdateBooking(TEST_TRIP_ID, { onMutationSuccess }), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { title: "New title" } });
  });
  await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledWith(postState));

  expect(client.getQueryData(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID))).toEqual(postState);
  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items[0]?.title).toBe("New title");
  expect("items" in (list?.items[0] ?? {})).toBe(false);
  expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true);
});

it("useScheduleBooking is optimistic (R-itin-11): placeholder + badge advance, then server post-state swap", async () => {
  const client = makeTestQueryClient();
  const idea = makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null });
  seedBookingList(client, [idea]);
  seedItinerary(client, [
    makeItineraryItem({ id: OTHER_ITEM_ID, day: DAY, sort_order: 1024 }),
  ]);

  let resolve!: (value: BookingWithItems) => void;
  spyRequest().mockImplementation(() => new Promise((r) => (resolve = r)));
  const onMutationSuccess = jest.fn();

  const { result } = await renderHook(
    () => useScheduleBooking(TEST_TRIP_ID, { onMutationSuccess }),
    { wrapper: makeWrapper(client) },
  );
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY, start_time: "14:00" } });
  });

  // Optimistic arm: placeholder appended after the day's tail; badge advanced.
  const optimistic = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
  const placeholder = optimistic?.items.find(
    (item) => item.id === optimisticScheduleItemId(BOOKING_ID),
  );
  expect(placeholder).toMatchObject({
    kind: "booking",
    booking_id: BOOKING_ID,
    day: DAY,
    start_time: "14:00",
    sort_order: 2048,
  });
  const optimisticList = client.getQueryData<Paginated<Booking>>(
    queryKeys.tripBookings(TEST_TRIP_ID),
  );
  expect(optimisticList?.items[0]?.status).toBe("planned");

  // Server post-state swap (R-ib-18): real item replaces the placeholder.
  const serverItem = makeItineraryItem({
    id: SERVER_ITEM_ID,
    kind: "booking",
    booking_id: BOOKING_ID,
    title: null,
    day: DAY,
    start_time: "14:00",
    sort_order: 2048,
  });
  const postState: BookingWithItems = {
    ...idea,
    status: "planned",
    items: [serverItem],
  };
  await act(async () => resolve(postState));
  await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledWith(postState));

  const settled = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
  expect(
    settled?.items.find((item) => item.id === optimisticScheduleItemId(BOOKING_ID)),
  ).toBeUndefined();
  expect(settled?.items.find((item) => item.id === SERVER_ITEM_ID)).toEqual(serverItem);
  expect(client.getQueryData(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID))).toEqual(postState);
});

it("useScheduleBooking failure restores BOTH snapshots and invalidates (stale-premise recovery)", async () => {
  const client = makeTestQueryClient();
  const idea = makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null });
  const existing = makeItineraryItem({ id: OTHER_ITEM_ID, day: DAY, sort_order: 1024 });
  seedBookingList(client, [idea]);
  seedItinerary(client, [existing]);
  spyRequest().mockRejectedValue(new Error("409"));
  const onMutationError = jest.fn();

  const { result } = await renderHook(
    () => useScheduleBooking(TEST_TRIP_ID, { onMutationError }),
    { wrapper: makeWrapper(client) },
  );
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY } });
  });
  await waitFor(() => expect(onMutationError).toHaveBeenCalledTimes(1));

  const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
  expect(read?.items).toEqual([existing]);
  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items[0]?.status).toBe("idea");
  expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
});
