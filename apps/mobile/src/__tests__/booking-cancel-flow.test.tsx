/**
 * PHASE ACCEPTANCE (P-7, IT-9): "Cancel flow: confirm → booking off calendar,
 * visible under show-cancelled."
 *
 * Two screens, ONE QueryClient, one stateful fake server — because that is
 * exactly what the requirement spans: R-itin-26 cancels on the DETAIL screen,
 * API R-ib-7 deletes the items server-side, and R-itin-12 shows the result in
 * the Ideas bucket on the ITINERARY screen. A per-screen test can pin either
 * half and miss the join.
 *
 * The client-side half of the join is the FROZEN `reconcileBookingRow`
 * invariant (data/bookings.ts): the cached default list must keep satisfying
 * the server's R-ib-10 predicate, so a booking that becomes `cancelled` is
 * REMOVED from it rather than left behind as a live-looking card with a
 * guaranteed-403 "Add to day". This suite is the reachability event for that
 * removal arm — the data-layer suite proves the arm works, this one proves the
 * cancel action actually reaches it.
 */
import type { Booking, BookingWithItems, ItineraryItem, TripListItem } from "@gogo/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react-native";

import BookingDetailScreen from "@/app/[tripId]/itinerary/booking/[bookingId]";
import ItineraryScreen from "@/app/[tripId]/itinerary/index";
import { queryKeys } from "@/data";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_LODGING_ID,
  ITEM_LODGING_ID,
  makeBooking,
  makeItineraryItem,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
jest.mock("@/theme/clipboard", () => ({ copyToClipboard: jest.fn() }));

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockNavigate = jest.fn();
/** Inlined: a jest.mock factory may not close over an imported binding. */
const mockLodgingBookingId = "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
    navigate: mockNavigate,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ bookingId: mockLodgingBookingId }),
  useNavigation: () => ({
    navigate: jest.fn(),
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

/**
 * A booking server that actually applies the transition: PATCH `cancelled`
 * moves the row out of the default list into the cancelled list and DELETES
 * its items (R-ib-7 / I-4), so the second screen reads the same post-state a
 * real server would return.
 */
function makeStatefulApi(trip: TripListItem) {
  const lodging = makeBooking({
    id: BOOKING_LODGING_ID,
    category: "lodging",
    status: "planned",
    title: "Park Hyatt Tokyo",
    details: { category: "lodging", property_name: "Park Hyatt Tokyo" },
    starts_at: "2027-03-01T06:00:00.000Z",
  });
  const item = makeItineraryItem({
    id: ITEM_LODGING_ID,
    kind: "booking",
    booking_id: BOOKING_LODGING_ID,
    title: null,
    day: TRIP_START,
    start_time: "15:00",
  });

  const state = {
    bookings: [lodging] as Booking[],
    cancelled: [] as Booking[],
    items: [item] as ItineraryItem[],
  };
  const patchCalls: Record<string, unknown>[] = [];

  const request = mockNavApi({
    trips: [trip],
    overrides: {
      "GET /trips/:tripId/itinerary": () => Promise.resolve({ items: state.items, legs: [] }),
      "GET /trips/:tripId/bookings": (input) => {
        const query = input.query as { status?: string } | undefined;
        return Promise.resolve({
          items: query?.status === "cancelled" ? state.cancelled : state.bookings,
          nextCursor: null,
        });
      },
      "GET /trips/:tripId/bookings/:bookingId": () => {
        const row = [...state.bookings, ...state.cancelled].find(
          (b) => b.id === BOOKING_LODGING_ID,
        );
        const items = state.items.filter((i) => i.booking_id === BOOKING_LODGING_ID);
        return Promise.resolve({ ...(row ?? lodging), items } as BookingWithItems);
      },
      "PATCH /trips/:tripId/bookings/:bookingId": (input) => {
        patchCalls.push(input);
        const body = input.body as { status?: Booking["status"] };
        if (body.status === "cancelled") {
          const row: Booking = { ...lodging, status: "cancelled" };
          state.bookings = state.bookings.filter((b) => b.id !== BOOKING_LODGING_ID);
          state.cancelled = [row];
          // R-ib-7 / I-4: cancelling DELETES the itinerary items in the same
          // transaction — the booking leaves the calendar.
          state.items = state.items.filter((i) => i.booking_id !== BOOKING_LODGING_ID);
          return Promise.resolve({ ...row, items: [] } as BookingWithItems);
        }
        return Promise.resolve({ ...lodging, items: state.items } as BookingWithItems);
      },
    },
  });
  return { state, patchCalls, request };
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
  mockBack.mockReset();
  mockReplace.mockReset();
  mockNavigate.mockReset();
});

it("cancel → confirm → off the calendar, visible under Show cancelled", async () => {
  seedAuthenticated();
  const trip = makeTrip({ id: TEST_TRIP_ID, start_date: TRIP_START, end_date: TRIP_END });
  const api = makeStatefulApi(trip);
  // ONE cache across both screens — the whole point of the pin. ISOLATED like
  // `makeTestQueryClient` (never the prod singleton), but with
  // `gcTime: Infinity` instead of 0: the invariant assert below reads the
  // booking list with NO observer mounted (the detail screen doesn't mount it),
  // and a gcTime-0 entry is collected the moment its last observer unmounts —
  // the P-6 observer-less-cache-assert landmine. Infinity schedules no timer,
  // so jest still exits clean; `staleTime: 0` keeps every remount refetching.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });

  // --- 1. BEFORE: the booking is on the calendar ---------------------------
  await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryScreen />
    </TripProvider>,
    { queryClient: client },
  );
  await settle();
  expect(await screen.findByTestId(`itinerary-list-item-${ITEM_LODGING_ID}`)).toBeTruthy();
  // ...and NOT in the Ideas bucket (it is scheduled, R-ib-10/R-itin-10).
  expect(screen.queryByTestId("itinerary-ideas")).toBeNull();

  // --- 2. CANCEL from the detail screen ------------------------------------
  await cleanup();
  await renderWithProviders(
    <TripProvider trip={trip}>
      <BookingDetailScreen />
    </TripProvider>,
    { queryClient: client },
  );
  await settle();
  await fireEvent.press(await screen.findByTestId("booking-detail-button-cancel"));
  await settle();
  await fireEvent.press(screen.getByTestId("booking-detail-button-cancel-confirm"));
  await waitFor(() => expect(api.patchCalls).toHaveLength(1));
  await settle();

  expect(api.patchCalls[0]?.body).toEqual({ status: "cancelled" });

  // CLIENT CACHE INVARIANT (frozen `reconcileBookingRow` removal arm): the
  // cached DEFAULT list must already satisfy R-ib-10 — before any refetch.
  const cachedList = client.getQueryData<{ items: Booking[] }>(
    queryKeys.tripBookings(TEST_TRIP_ID),
  );
  expect(cachedList?.items.map((row) => row.id)).not.toContain(BOOKING_LODGING_ID);

  // --- 3. AFTER: off the calendar, present under Show cancelled ------------
  await cleanup();
  await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryScreen />
    </TripProvider>,
    { queryClient: client },
  );
  await settle();
  await screen.findByTestId("itinerary-screen");

  // Off the calendar (R-ib-7: the items were deleted in the same transaction).
  await waitFor(() =>
    expect(screen.queryByTestId(`itinerary-list-item-${ITEM_LODGING_ID}`)).toBeNull(),
  );

  // Visible under "Show cancelled" (R-itin-12 — the bucket is a cancelled
  // booking's ONLY surface).
  await fireEvent.press(await screen.findByTestId("itinerary-ideas-toggle"));
  await settle();
  // Hidden by default — the toggle is what reveals it, which is also the
  // CONTROL for the assertion after it.
  expect(screen.queryByTestId(`itinerary-ideas-item-${BOOKING_LODGING_ID}`)).toBeNull();
  await fireEvent.press(await screen.findByTestId("itinerary-ideas-show-cancelled"));
  await settle();
  expect(await screen.findByTestId(`itinerary-ideas-item-${BOOKING_LODGING_ID}`)).toBeTruthy();
  expect(screen.getByText("Park Hyatt Tokyo")).toBeTruthy();
});
