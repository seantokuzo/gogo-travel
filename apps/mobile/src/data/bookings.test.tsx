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
  byBookingListOrder,
  optimisticScheduleItemId,
  optimisticStatusItemId,
  useBooking,
  useCancelledBookings,
  useCreateBooking,
  useDeleteBooking,
  useScheduleBooking,
  useSetBookingStatus,
  useTripBookings,
  useUpdateBooking,
} from "@/data/bookings";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  makeBooking as makeWireBooking,
  makeItineraryItem,
  rentalBooking,
} from "@/test-utils/itinerary-fixtures";
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
  expect(client.getQueryState(queryKeys.tripBooking(TEST_TRIP_ID, "b-0"))?.isInvalidated).toBe(
    true,
  );
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

  // Endpoint identity at hook grain (siblings pin theirs): a descriptor swap
  // to createBooking would otherwise only fail in the screen suite.
  expect(apiClient.request).toHaveBeenCalledWith(bookingEndpoints.updateBooking, {
    params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_ID },
    body: { title: "New title" },
  });
  expect(client.getQueryData(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID))).toEqual(postState);
  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items[0]?.title).toBe("New title");
  expect("items" in (list?.items[0] ?? {})).toBe(false);
  expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true);
});

describe("byBookingListOrder (R-ib-10 list order, mirrored)", () => {
  const at = (id: string, starts: string | null, updated: string): Booking =>
    makeWireBooking({ id, starts_at: starts, updated_at: updated });

  it("orders starts_at ASC with NULLS LAST", () => {
    const timeless = at("b-null", null, "2026-07-01T00:00:00.000Z");
    const early = at("b-early", "2027-03-01T09:00:00.000Z", "2026-07-01T00:00:00.000Z");
    const late = at("b-late", "2027-03-05T09:00:00.000Z", "2026-07-01T00:00:00.000Z");
    expect([timeless, late, early].sort(byBookingListOrder).map((b) => b.id)).toEqual([
      "b-early",
      "b-late",
      "b-null",
    ]);
  });

  it("breaks starts_at ties by updated_at DESC (freshest first), then id", () => {
    const start = "2027-03-01T09:00:00.000Z";
    const stale = at("b-stale", start, "2026-07-01T00:00:00.000Z");
    const fresh = at("b-fresh", start, "2026-07-09T00:00:00.000Z");
    expect([stale, fresh].sort(byBookingListOrder).map((b) => b.id)).toEqual([
      "b-fresh",
      "b-stale",
    ]);
    // Fully tied → deterministic id order (no unstable shuffling).
    const tiedA = at("b-a", start, "2026-07-01T00:00:00.000Z");
    const tiedB = at("b-b", start, "2026-07-01T00:00:00.000Z");
    expect([tiedB, tiedA].sort(byBookingListOrder).map((b) => b.id)).toEqual(["b-a", "b-b"]);
  });

  it("compares INSTANTS, not strings: mixed offsets and precisions order chronologically", () => {
    // The wire scalar is `z.iso.datetime({ offset: true })` — all three are
    // schema-legal spellings; lexicographic compare would order them
    // "+09:00" < "Z" (offset) and ".000Z" < "Z" (precision), i.e. wrong.
    const tokyo = at("b-tokyo", "2027-03-01T18:00:00+09:00", "2026-07-01T00:00:00.000Z"); // 09:00Z
    const utc = at("b-utc", "2027-03-01T10:00:00Z", "2026-07-01T00:00:00.000Z");
    expect([utc, tokyo].sort(byBookingListOrder).map((b) => b.id)).toEqual(["b-tokyo", "b-utc"]);

    // Same instant, two precisions → a pure updated_at tiebreak, not a
    // spelling comparison. The `updated_at` values are deliberately set so
    // ONLY instant comparison satisfies this (round-2): the FRESHER row is
    // the coarse spelling, so instant compare answers ["b-coarse","b-precise"]
    // while string compare (`.` 0x2E < `Z` 0x5A ⇒ precise sorts first on
    // starts_at, and the updated_at tiebreak never runs) answers the reverse.
    const precise = at("b-precise", "2027-03-01T10:00:00.000Z", "2026-07-01T00:00:00.000Z");
    const coarse = at("b-coarse", "2027-03-01T10:00:00Z", "2026-07-09T00:00:00.000Z");
    expect([precise, coarse].sort(byBookingListOrder).map((b) => b.id)).toEqual([
      "b-coarse",
      "b-precise",
    ]);
  });

  it("folds an UNPARSEABLE instant to unknown (trailing), never NaN-ordered", () => {
    // The fold exists because a NaN comparison would silently corrupt the
    // total order (every comparison false ⇒ arbitrary output). Corrupt input
    // is treated like a timeless row: it trails.
    const junk = at("b-junk", "not-a-date", "2026-07-01T00:00:00.000Z");
    const real = at("b-real", "2027-03-01T09:00:00.000Z", "2026-07-01T00:00:00.000Z");
    expect([junk, real].sort(byBookingListOrder).map((b) => b.id)).toEqual(["b-real", "b-junk"]);
    expect([real, junk].sort(byBookingListOrder).map((b) => b.id)).toEqual(["b-real", "b-junk"]);
  });
});

it("schedule reconcile INSERTS a booking missing from the list (create→schedule strand, round-1 blocker)", async () => {
  const client = makeTestQueryClient();
  // The exact post-create state: create's root invalidation refetch was
  // aborted by schedule's own cancelQueries, so the new row never reached
  // the list cache. A map-replace-only reconcile leaves it missing forever
  // (day list renders the enrichment-gap fallback with a FALSE day lock).
  const existing = makeWireBooking({
    id: "b-existing",
    starts_at: "2027-03-01T09:00:00.000Z",
  });
  seedBookingList(client, [existing]);
  seedItinerary(client, []);

  const created = makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null });
  const postState: BookingWithItems = { ...created, status: "planned", items: [] };
  spyRequest().mockResolvedValue(postState);

  const { result } = await renderHook(() => useScheduleBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY } });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  const row = list?.items.find((item) => item.id === BOOKING_ID);
  expect(row).toBeDefined();
  expect(row?.status).toBe("planned");
  // Timeless ⇒ NULLS LAST: inserted AFTER the scheduled row, and the
  // pre-existing row keeps its place (insert never reshuffles).
  expect(list?.items.map((item) => item.id)).toEqual(["b-existing", BOOKING_ID]);
});

it("the insert lands at its SORTED position, not appended (round-2: always-append survived the suite)", async () => {
  const client = makeTestQueryClient();
  // Two scheduled rows straddling the inserted one — the mid-list branch
  // (`at !== -1`). The previous insert pin only covered the append case
  // (its post-state was timeless, so NULLS-LAST put it at the end anyway),
  // which let `splice(items.length, …)` survive the whole 763-test suite.
  const early = makeWireBooking({ id: "b-early", starts_at: "2027-03-01T09:00:00.000Z" });
  const late = makeWireBooking({ id: "b-late", starts_at: "2027-03-05T09:00:00.000Z" });
  seedBookingList(client, [early, late]);
  seedItinerary(client, []);

  const middle = makeWireBooking({
    id: BOOKING_ID,
    status: "planned",
    starts_at: "2027-03-03T09:00:00.000Z",
  });
  spyRequest().mockResolvedValue({ ...middle, items: [] } as BookingWithItems);

  const { result } = await renderHook(() => useScheduleBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY } });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items.map((item) => item.id)).toEqual(["b-early", BOOKING_ID, "b-late"]);
});

it("a CANCELLED booking is never inserted into the default list (R-ib-10 predicate, round-2)", async () => {
  const client = makeTestQueryClient();
  // R-ib-10: the default list is "all except cancelled". Editing a cancelled
  // booking (deep-link reachable now, T-7.9-reachable next) must not splice
  // it in — the Ideas bucket would render it as a live card with a
  // guaranteed-403 "Add to day" (cancelled bookings have zero items).
  const existing = makeWireBooking({ id: "b-existing", starts_at: "2027-03-01T09:00:00.000Z" });
  seedBookingList(client, [existing]);
  seedItinerary(client, []);
  const postState: BookingWithItems = {
    ...makeWireBooking({ id: BOOKING_ID, status: "cancelled", title: "Cancelled" }),
    items: [],
  };
  spyRequest().mockResolvedValue(postState);

  const { result } = await renderHook(() => useUpdateBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { title: "Cancelled" } });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items.map((item) => item.id)).toEqual(["b-existing"]);
});

it("a listed booking that BECOMES cancelled is REMOVED from the default list (round-2)", async () => {
  const client = makeTestQueryClient();
  // The other direction of the same invariant: map-replace would have left
  // a cancelled row sitting in the non-cancelled list.
  const other = makeWireBooking({ id: "b-other", starts_at: "2027-03-01T09:00:00.000Z" });
  const doomed = makeWireBooking({ id: BOOKING_ID, status: "planned", starts_at: null });
  seedBookingList(client, [other, doomed]);
  seedItinerary(client, []);
  const postState: BookingWithItems = {
    ...makeWireBooking({ id: BOOKING_ID, status: "cancelled", starts_at: null }),
    items: [],
  };
  spyRequest().mockResolvedValue(postState);

  const { result } = await renderHook(() => useUpdateBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { status: "cancelled" } });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items.map((item) => item.id)).toEqual(["b-other"]);
});

it("update reconcile REPLACES in place — server order is preserved byte-exactly", async () => {
  const client = makeTestQueryClient();
  // Deliberately seeded in an order the client comparator would NOT produce
  // (timeless first): a re-sorting reconcile would reshuffle these rows.
  const timeless = makeWireBooking({ id: "b-timeless", starts_at: null, title: "Idea" });
  const scheduled = makeWireBooking({ id: BOOKING_ID, starts_at: "2027-03-01T09:00:00.000Z" });
  seedBookingList(client, [timeless, scheduled]);
  seedItinerary(client, []);
  const postState: BookingWithItems = {
    ...makeWireBooking({ id: BOOKING_ID, starts_at: "2027-03-01T09:00:00.000Z", title: "Renamed" }),
    items: [],
  };
  spyRequest().mockResolvedValue(postState);

  const { result } = await renderHook(() => useUpdateBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { title: "Renamed" } });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items.map((item) => item.id)).toEqual(["b-timeless", BOOKING_ID]);
  expect(list?.items[1]?.title).toBe("Renamed");
});

it("useScheduleBooking is optimistic (R-itin-11): placeholder + badge advance, then server post-state swap", async () => {
  const client = makeTestQueryClient();
  const idea = makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null });
  seedBookingList(client, [idea]);
  seedItinerary(client, [makeItineraryItem({ id: OTHER_ITEM_ID, day: DAY, sort_order: 1024 })]);

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

it("the optimistic badge advance is idea-ONLY: a timeless booked card keeps its status mid-flight (R-ib-8)", async () => {
  const client = makeTestQueryClient();
  // "Needs a day" card whose parent is already `booked` — R-ib-8 advances
  // only `idea`; an unconditional "planned" write would visibly DOWNGRADE
  // its badge until the server post-state landed.
  const booked = makeWireBooking({ id: BOOKING_ID, status: "booked", starts_at: null });
  seedBookingList(client, [booked]);
  seedItinerary(client, []);
  // Held (not never-resolving — a dangling mutation trips jest's worker
  // teardown): asserted MID-FLIGHT, then settled before the test ends.
  let resolve!: (value: BookingWithItems) => void;
  spyRequest().mockImplementation(() => new Promise((r) => (resolve = r)));

  const { result } = await renderHook(() => useScheduleBooking(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY } });
  });

  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items[0]?.status).toBe("booked");

  await act(async () => resolve({ ...booked, items: [] }));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
});

it("useScheduleBooking failure restores BOTH snapshots and invalidates (stale-premise recovery)", async () => {
  const client = makeTestQueryClient();
  const idea = makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null });
  const existing = makeItineraryItem({ id: OTHER_ITEM_ID, day: DAY, sort_order: 1024 });
  seedBookingList(client, [idea]);
  seedItinerary(client, [existing]);
  spyRequest().mockRejectedValue(new Error("409"));
  const onMutationError = jest.fn();

  const { result } = await renderHook(() => useScheduleBooking(TEST_TRIP_ID, { onMutationError }), {
    wrapper: makeWrapper(client),
  });
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

// ---------------------------------------------------------------------------
// T-7.15 — Ideas bucket status actions: `useScheduleBooking` forwards the
// T-7.10 `status` field; `useSetBookingStatus` is the known-times PATCH route.
// Every mid-flight assertion below holds the request GENUINELY in flight (a
// deferred promise settled in `finally`, after the asserts) — a pre-settled
// promise flushes the optimistic write and the rollback in one notify batch
// and the intermediate state never commits (mobile.md vacuous-pin taxonomy).
// ---------------------------------------------------------------------------

/** The B-16 known-times fixture: an `idea` carrying date/times (derived `starts_at` known). */
function ideaWithKnownTimes(overrides?: Partial<Booking>): Booking {
  return makeWireBooking({
    id: BOOKING_ID,
    category: "activity",
    status: "idea",
    title: "Sumo tournament",
    details: {
      category: "activity",
      starts_at: "2027-03-02T14:30:00+09:00",
      ends_at: "2027-03-02T16:00:00+09:00",
    },
    starts_at: "2027-03-02T05:30:00.000Z",
    ends_at: "2027-03-02T07:00:00.000Z",
    ...overrides,
  });
}

function requestBody(): unknown {
  const call = (apiClient.request as unknown as jest.Mock).mock.calls[0] as
    [unknown, { body?: unknown }] | undefined;
  return call?.[1].body;
}

describe("useScheduleBooking forwards the T-7.10 `status` (T-7.15)", () => {
  // Falsify: have `scheduleTargetStatus` ignore the explicit status (the
  // pre-T-7.15 `idea → planned` blanket write) ⇒ the mid-flight badge reads
  // "planned" ⇒ RED.
  it("idea + status 'booked': the body carries it verbatim and the optimistic badge lands on BOOKED mid-flight", async () => {
    const client = makeTestQueryClient();
    const idea = makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null });
    seedBookingList(client, [idea]);
    seedItinerary(client, []);
    const resolvers: ((value: BookingWithItems) => void)[] = [];
    spyRequest().mockImplementation(() => new Promise((r) => resolvers.push(r)));

    const { result } = await renderHook(() => useScheduleBooking(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY, status: "booked" } });
    });
    try {
      expect(requestBody()).toEqual({ day: DAY, status: "booked" });
      const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
      expect(list?.items[0]?.status).toBe("booked");
      // …and the card really is in flight (the placeholder is the optimistic move).
      const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
      expect(read?.items.map((item) => item.id)).toEqual([optimisticScheduleItemId(BOOKING_ID)]);
    } finally {
      await act(async () => resolvers.forEach((resolve) => resolve({ ...idea, items: [] })));
    }
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("a timeless PLANNED card + status 'booked' advances planned → booked mid-flight (not only idea cards)", async () => {
    const client = makeTestQueryClient();
    const planned = makeWireBooking({ id: BOOKING_ID, status: "planned", starts_at: null });
    seedBookingList(client, [planned]);
    seedItinerary(client, []);
    const resolvers: ((value: BookingWithItems) => void)[] = [];
    spyRequest().mockImplementation(() => new Promise((r) => resolvers.push(r)));

    const { result } = await renderHook(() => useScheduleBooking(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY, status: "booked" } });
    });
    try {
      const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
      expect(list?.items[0]?.status).toBe("booked");
    } finally {
      await act(async () => resolvers.forEach((resolve) => resolve({ ...planned, items: [] })));
    }
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  // The pre-change path: the hook adds nothing the caller didn't send, so an
  // omitted `status` reaches the server omitted ("omitted ⇒ unchanged").
  it("omitted status stays OMITTED on the wire (the byte-identical pre-change request)", async () => {
    const client = makeTestQueryClient();
    const booked = makeWireBooking({ id: BOOKING_ID, status: "booked", starts_at: null });
    seedBookingList(client, [booked]);
    seedItinerary(client, []);
    spyRequest().mockResolvedValue({ ...booked, items: [] });

    const { result } = await renderHook(() => useScheduleBooking(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY } });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestBody()).toEqual({ day: DAY });
    expect(requestBody()).not.toHaveProperty("status");
  });

  it("failure with an explicit status rolls the badge back (booked → idea) and invalidates, after a genuinely in-flight request", async () => {
    const client = makeTestQueryClient();
    const idea = makeWireBooking({ id: BOOKING_ID, status: "idea", starts_at: null });
    seedBookingList(client, [idea]);
    seedItinerary(client, []);
    const rejecters: ((error: Error) => void)[] = [];
    spyRequest().mockImplementation(
      () => new Promise((_resolve, reject) => rejecters.push(reject)),
    );
    const onMutationError = jest.fn();

    const { result } = await renderHook(
      () => useScheduleBooking(TEST_TRIP_ID, { onMutationError }),
      { wrapper: makeWrapper(client) },
    );
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, input: { day: DAY, status: "booked" } });
    });
    try {
      const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
      expect(list?.items[0]?.status).toBe("booked"); // mid-flight, not yet rolled back
    } finally {
      await act(async () => rejecters.forEach((reject) => reject(new Error("400"))));
    }
    await waitFor(() => expect(onMutationError).toHaveBeenCalledTimes(1));
    const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
    expect(list?.items[0]?.status).toBe("idea");
    expect(
      client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID))?.items,
    ).toEqual([]);
    expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  });
});

describe("useSetBookingStatus — the known-times status-only PATCH (T-7.15 / R-itin-41)", () => {
  // Falsify: send the schedule endpoint instead (the pre-T-7.15 route) or add
  // day/times to the body ⇒ the descriptor/body pin goes RED.
  it("PATCHes exactly `{ status }` — no day/times — and the B-16 fixture lands optimistically then reconciles to the server post-state", async () => {
    const client = makeTestQueryClient();
    const idea = ideaWithKnownTimes();
    const existing = makeItineraryItem({ id: OTHER_ITEM_ID, day: DAY, sort_order: 1024 });
    seedBookingList(client, [idea]);
    seedItinerary(client, [existing]);
    const resolvers: ((value: BookingWithItems) => void)[] = [];
    spyRequest().mockImplementation(() => new Promise((r) => resolvers.push(r)));
    const onMutationSuccess = jest.fn();

    const { result } = await renderHook(
      () => useSetBookingStatus(TEST_TRIP_ID, { onMutationSuccess }),
      { wrapper: makeWrapper(client) },
    );
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, status: "booked" });
    });

    const serverItem = makeItineraryItem({
      id: SERVER_ITEM_ID,
      kind: "booking",
      booking_id: BOOKING_ID,
      title: null,
      day: DAY,
      start_time: "14:30",
      end_time: "16:00",
      sort_order: 2048,
    });
    const postState: BookingWithItems = { ...idea, status: "booked", items: [serverItem] };
    try {
      // Endpoint identity + body: the status PATCH, status ONLY.
      expect(apiClient.request).toHaveBeenCalledWith(bookingEndpoints.updateBooking, {
        params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_ID },
        body: { status: "booked" },
      });
      // Optimistic arm: badge on the target; the I-2 placeholder derived from the
      // booking's own details (wall values of the LOCAL strings) after the day's tail.
      const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
      expect(list?.items[0]?.status).toBe("booked");
      const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
      expect(
        read?.items.find((item) => item.id === optimisticStatusItemId(BOOKING_ID, 0)),
      ).toMatchObject({
        kind: "booking",
        booking_id: BOOKING_ID,
        day: DAY,
        end_day: null,
        start_time: "14:30",
        end_time: "16:00",
        sort_order: 2048,
      });
      expect(read?.items).toHaveLength(2); // the existing row is untouched
    } finally {
      await act(async () => resolvers.forEach((resolve) => resolve(postState)));
    }
    await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledWith(postState));

    // Settled: placeholder gone, real item in, list row + detail reconciled.
    const settled = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
    expect(settled?.items.map((item) => item.id).sort()).toEqual(
      [OTHER_ITEM_ID, SERVER_ITEM_ID].sort(),
    );
    expect(client.getQueryData(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID))).toEqual(postState);
    const reconciled = client.getQueryData<Paginated<Booking>>(
      queryKeys.tripBookings(TEST_TRIP_ID),
    );
    expect("items" in (reconciled?.items[0] ?? {})).toBe(false);
    // Fan-out parity with useUpdateBooking: the booking root + composite read.
    expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  });

  it("the placeholders mirror the §3.3 derivation: a car rental lands TWO point rows (pickup + drop-off), a lodging ONE spanning row", async () => {
    const client = makeTestQueryClient();
    const rental = rentalBooking({ id: BOOKING_ID, status: "idea" });
    seedBookingList(client, [rental]);
    seedItinerary(client, []);
    const resolvers: ((value: BookingWithItems) => void)[] = [];
    spyRequest().mockImplementation(() => new Promise((r) => resolvers.push(r)));

    const { result } = await renderHook(() => useSetBookingStatus(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, status: "planned" });
    });
    try {
      const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
      expect(read?.items.map((item) => [item.id, item.day, item.start_time])).toEqual([
        [optimisticStatusItemId(BOOKING_ID, 0), "2027-03-01", "09:00"],
        [optimisticStatusItemId(BOOKING_ID, 1), "2027-03-02", "17:30"],
      ]);
    } finally {
      await act(async () => resolvers.forEach((resolve) => resolve({ ...rental, items: [] })));
    }
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Lodging: one spanning row (check-in day, check-out as end_day).
    const lodging = makeWireBooking({
      id: BOOKING_ID,
      category: "lodging",
      status: "idea",
      details: {
        category: "lodging",
        check_in: "2027-03-01T15:00:00+09:00",
        check_out: "2027-03-03T11:00:00+09:00",
      },
      starts_at: "2027-03-01T06:00:00.000Z",
    });
    const lodgingClient = makeTestQueryClient();
    seedBookingList(lodgingClient, [lodging]);
    seedItinerary(lodgingClient, []);
    const lodgingResolvers: ((value: BookingWithItems) => void)[] = [];
    spyRequest().mockImplementation(() => new Promise((r) => lodgingResolvers.push(r)));
    const second = await renderHook(() => useSetBookingStatus(TEST_TRIP_ID), {
      wrapper: makeWrapper(lodgingClient),
    });
    await act(async () => {
      second.result.current.mutate({ bookingId: BOOKING_ID, status: "booked" });
    });
    try {
      const read = lodgingClient.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
      expect(read?.items).toHaveLength(1);
      expect(read?.items[0]).toMatchObject({ day: "2027-03-01", end_day: "2027-03-03" });
    } finally {
      await act(async () =>
        lodgingResolvers.forEach((resolve) => resolve({ ...lodging, items: [] })),
      );
    }
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
  });

  // The control arm of the placeholder pins: planned → booked has its items
  // already and the server leaves them be (§3.2 matrix note) — badge only.
  it("planned → booked on a booking that already has items advances the badge ONLY (no placeholder rows)", async () => {
    const client = makeTestQueryClient();
    const planned = ideaWithKnownTimes({ status: "planned" });
    const own = makeItineraryItem({
      id: OTHER_ITEM_ID,
      kind: "booking",
      booking_id: BOOKING_ID,
      title: null,
      day: DAY,
      start_time: "14:30",
    });
    seedBookingList(client, [planned]);
    seedItinerary(client, [own]);
    const resolvers: ((value: BookingWithItems) => void)[] = [];
    spyRequest().mockImplementation(() => new Promise((r) => resolvers.push(r)));

    const { result } = await renderHook(() => useSetBookingStatus(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, status: "booked" });
    });
    try {
      const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
      expect(list?.items[0]?.status).toBe("booked");
      const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
      expect(read?.items).toEqual([own]);
    } finally {
      await act(async () =>
        resolvers.forEach((resolve) => resolve({ ...planned, status: "booked", items: [own] })),
      );
    }
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  // Falsify: drop the snapshot restore from `onError` ⇒ the placeholder +
  // badge survive the failure ⇒ RED (asserted after a REAL in-flight window).
  it("failure restores BOTH snapshots, invalidates, and rides the hook-level seam (rolled back after a genuinely in-flight request)", async () => {
    const client = makeTestQueryClient();
    const idea = ideaWithKnownTimes();
    const existing = makeItineraryItem({ id: OTHER_ITEM_ID, day: DAY, sort_order: 1024 });
    seedBookingList(client, [idea]);
    seedItinerary(client, [existing]);
    const rejecters: ((error: Error) => void)[] = [];
    spyRequest().mockImplementation(
      () => new Promise((_resolve, reject) => rejecters.push(reject)),
    );
    const onMutationError = jest.fn();
    const failure = new Error("403");

    const { result } = await renderHook(
      () => useSetBookingStatus(TEST_TRIP_ID, { onMutationError }),
      { wrapper: makeWrapper(client) },
    );
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, status: "planned" });
    });
    try {
      // Mid-flight: the optimistic write is visible…
      const mid = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
      expect(mid?.items).toHaveLength(2);
      expect(onMutationError).not.toHaveBeenCalled();
    } finally {
      await act(async () => rejecters.forEach((reject) => reject(failure)));
    }
    await waitFor(() => expect(onMutationError).toHaveBeenCalledWith(failure));

    // …and rolled back.
    const read = client.getQueryData<ItineraryRead>(queryKeys.tripItinerary(TEST_TRIP_ID));
    expect(read?.items).toEqual([existing]);
    const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
    expect(list?.items[0]?.status).toBe("idea");
    expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  });

  it("hook-level onMutationSuccess fires for BOTH of two in-flight calls (superseded-call law)", async () => {
    const client = makeTestQueryClient();
    const first = ideaWithKnownTimes();
    const second = ideaWithKnownTimes({ id: OTHER_ITEM_ID });
    seedBookingList(client, [first, second]);
    seedItinerary(client, []);
    const resolvers: ((value: BookingWithItems) => void)[] = [];
    spyRequest().mockImplementation(() => new Promise((r) => resolvers.push(r)));
    const onMutationSuccess = jest.fn();

    const { result } = await renderHook(
      () => useSetBookingStatus(TEST_TRIP_ID, { onMutationSuccess }),
      { wrapper: makeWrapper(client) },
    );
    await act(async () => {
      result.current.mutate({ bookingId: BOOKING_ID, status: "planned" });
    });
    await act(async () => {
      result.current.mutate({ bookingId: OTHER_ITEM_ID, status: "booked" });
    });
    try {
      expect(resolvers).toHaveLength(2);
    } finally {
      await act(async () => {
        resolvers[0]?.({ ...first, status: "planned", items: [] });
        resolvers[1]?.({ ...second, status: "booked", items: [] });
      });
    }
    await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// useDeleteBooking (T-7.9 / IT-9 — R-itin-26 delete arm, API §3.4 DELETE)
// ---------------------------------------------------------------------------

function seedCancelledList(client: QueryClient, bookings: Booking[]): void {
  client.setQueryDefaults(queryKeys.tripBookingsCancelled(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryData<Paginated<Booking>>(queryKeys.tripBookingsCancelled(TEST_TRIP_ID), {
    items: bookings,
    nextCursor: null,
  });
}

it("useDeleteBooking prunes the row from BOTH list caches and drops the detail key", async () => {
  const client = makeTestQueryClient();
  const target = makeWireBooking({ id: BOOKING_ID, title: "Doomed" });
  const survivor = makeWireBooking({ id: OTHER_ITEM_ID, title: "Keeper" });
  seedItinerary(client, []);
  seedBookingList(client, [target, survivor]);
  // A cancelled booking lives in its OWN list; deleting it must clear that one
  // too — `reconcileBookingRow` never touches that key, which is exactly why
  // the delete arm is a separate function rather than a reconcile with a
  // tombstone.
  seedCancelledList(client, [makeWireBooking({ id: BOOKING_ID, status: "cancelled" })]);
  client.setQueryDefaults(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID), { gcTime: Infinity });
  client.setQueryData<BookingWithItems>(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID), {
    ...target,
    items: [],
  });
  spyRequest().mockResolvedValue(undefined);
  const onMutationSuccess = jest.fn();

  const { result } = await renderHook(() => useDeleteBooking(TEST_TRIP_ID, { onMutationSuccess }), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate(BOOKING_ID);
  });
  await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledWith(BOOKING_ID));

  expect(apiClient.request).toHaveBeenCalledWith(bookingEndpoints.deleteBooking, {
    params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_ID },
  });
  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  // The SURVIVOR is the control: the filter is targeted, not a cache wipe.
  expect(list?.items.map((row) => row.id)).toEqual([OTHER_ITEM_ID]);
  const cancelled = client.getQueryData<Paginated<Booking>>(
    queryKeys.tripBookingsCancelled(TEST_TRIP_ID),
  );
  expect(cancelled?.items).toEqual([]);
  expect(client.getQueryData(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_ID))).toBeUndefined();
  expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.tripItinerary(TEST_TRIP_ID))?.isInvalidated).toBe(true);
});

it("a FAILED delete leaves every cache untouched (nothing optimistic to resurrect)", async () => {
  const client = makeTestQueryClient();
  const target = makeWireBooking({ id: BOOKING_ID, title: "Doomed" });
  seedItinerary(client, []);
  seedBookingList(client, [target]);
  spyRequest().mockRejectedValue(new Error("500"));
  const onMutationError = jest.fn();

  const { result } = await renderHook(() => useDeleteBooking(TEST_TRIP_ID, { onMutationError }), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate(BOOKING_ID);
  });
  await waitFor(() => expect(onMutationError).toHaveBeenCalledTimes(1));

  const list = client.getQueryData<Paginated<Booking>>(queryKeys.tripBookings(TEST_TRIP_ID));
  expect(list?.items.map((row) => row.id)).toEqual([BOOKING_ID]);
  expect(client.getQueryState(queryKeys.tripBookings(TEST_TRIP_ID))?.isInvalidated).toBe(false);
});
