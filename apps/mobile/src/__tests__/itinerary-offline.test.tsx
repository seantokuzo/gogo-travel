/**
 * Offline degradation of the itinerary tab (T-7.9 / IT-10 — R-itin-29):
 * "render the itinerary (items, bookings, last-computed legs) from cache …
 * and disable deeplink-out buttons with an offline hint."
 *
 * Every offline assertion here is paired with a SERVER-ERROR control on the
 * identical fixture — a 500 must produce the ordinary retry surface, not the
 * offline one. Without that pairing, a degrade surface that fired on ANY
 * failure would pass every offline test in this file.
 */
import type { Booking, BookingWithItems, ItineraryItem, TripListItem } from "@gogo/shared";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react-native";

import BookingDetailScreen from "@/app/[tripId]/itinerary/booking/[bookingId]";
import ItineraryScreen from "@/app/[tripId]/itinerary/index";
import { ApiRequestError } from "@/auth";
import { queryKeys } from "@/data";
import { DEEPLINK_OFFLINE_HINT } from "@/features/deeplinks";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_LODGING_ID,
  ITEM_B_ID,
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

const mockLodgingBookingId = "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ bookingId: mockLodgingBookingId }),
  useNavigation: () => ({
    navigate: jest.fn(),
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

const NETWORK = () => new ApiRequestError(0, "NETWORK", "network request failed");
const SERVER = () => new ApiRequestError(500, "UNKNOWN", "boom");

function tripFixture(): TripListItem {
  return makeTrip({ id: TEST_TRIP_ID, start_date: TRIP_START, end_date: TRIP_END });
}

/** Isolated client with `gcTime: Infinity` — seeded entries must survive to the render. */
function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

/**
 * Arm the trip-wide signal the way the app really does: the `[tripId]`
 * membership guard's own read fails at the transport layer. `useTripOffline`
 * reads the whole `["trips", tripId, …]` detail subtree, so this is enough —
 * and it is deliberately NOT the itinerary key, which proves the signal is
 * subtree-wide rather than a per-query `isError` read in disguise.
 */
async function armGuardFailure(client: QueryClient, error: unknown): Promise<void> {
  await client
    .fetchQuery({ queryKey: queryKeys.trip(TEST_TRIP_ID), queryFn: () => Promise.reject(error) })
    .catch(() => undefined);
}

function cachedItems(): ItineraryItem[] {
  return [makeItineraryItem({ id: ITEM_B_ID, title: "Walk Shibuya", day: TRIP_START })];
}

function lodgingBooking(): Booking {
  return makeBooking({
    id: BOOKING_LODGING_ID,
    category: "lodging",
    status: "planned",
    title: "Park Hyatt Tokyo",
    details: {
      category: "lodging",
      property_name: "Park Hyatt Tokyo",
      address: "1-2-3 Nishi-Shinjuku",
      check_in: "2027-03-01T15:00:00Z",
      check_out: "2027-03-03T11:00:00Z",
    },
  });
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
});

describe("R-itin-29 — the plan surface renders from cache", () => {
  it("keeps the cached day rows and shows the OFFLINE banner (no retry, no error banner)", async () => {
    seedAuthenticated();
    const trip = tripFixture();
    const client = makeClient();
    client.setQueryData(queryKeys.tripItinerary(TEST_TRIP_ID), {
      items: cachedItems(),
      legs: [],
    });
    client.setQueryData(queryKeys.tripBookings(TEST_TRIP_ID), { items: [], nextCursor: null });
    client.setQueryData(queryKeys.tripBookingsCancelled(TEST_TRIP_ID), {
      items: [],
      nextCursor: null,
    });
    await armGuardFailure(client, NETWORK());
    // Every tab read also fails at the transport layer, as it would offline.
    mockNavApi({
      trips: [trip],
      overrides: {
        "GET /trips/:tripId/itinerary": () => Promise.reject(NETWORK()),
        "GET /trips/:tripId/bookings": () => Promise.reject(NETWORK()),
      },
    });

    await renderWithProviders(
      <TripProvider trip={trip}>
        <ItineraryScreen />
      </TripProvider>,
      { queryClient: client },
    );
    await settle();

    // The cached plan is STILL on screen — a failed refetch never blanks it.
    expect(await screen.findByTestId(`itinerary-list-item-${ITEM_B_ID}`)).toBeTruthy();
    expect(await screen.findByTestId("itinerary-banner-offline")).toBeTruthy();
    // Offline outranks the refresh error and offers no retry (the transport is
    // down — a retry button would be a lie).
    expect(screen.queryByTestId("itinerary-refresh-error")).toBeNull();
  });

  it("CONTROL: the identical fixture with a 500 shows the REFRESH ERROR, not the offline banner", async () => {
    seedAuthenticated();
    const trip = tripFixture();
    const client = makeClient();
    client.setQueryData(queryKeys.tripItinerary(TEST_TRIP_ID), {
      items: cachedItems(),
      legs: [],
    });
    client.setQueryData(queryKeys.tripBookings(TEST_TRIP_ID), { items: [], nextCursor: null });
    client.setQueryData(queryKeys.tripBookingsCancelled(TEST_TRIP_ID), {
      items: [],
      nextCursor: null,
    });
    await armGuardFailure(client, SERVER());
    mockNavApi({
      trips: [trip],
      overrides: {
        "GET /trips/:tripId/itinerary": () => Promise.reject(SERVER()),
        "GET /trips/:tripId/bookings": () => Promise.reject(SERVER()),
      },
    });

    await renderWithProviders(
      <TripProvider trip={trip}>
        <ItineraryScreen />
      </TripProvider>,
      { queryClient: client },
    );
    await settle();

    expect(await screen.findByTestId(`itinerary-list-item-${ITEM_B_ID}`)).toBeTruthy();
    expect(await screen.findByTestId("itinerary-refresh-error")).toBeTruthy();
    expect(screen.queryByTestId("itinerary-banner-offline")).toBeNull();
  });

  it("says OFFLINE rather than 'couldn't load' when there is no cache at all", async () => {
    seedAuthenticated();
    const trip = tripFixture();
    const client = makeClient();
    mockNavApi({
      trips: [trip],
      overrides: {
        "GET /trips/:tripId/itinerary": () => Promise.reject(NETWORK()),
        "GET /trips/:tripId/bookings": () => Promise.reject(NETWORK()),
      },
    });

    await renderWithProviders(
      <TripProvider trip={trip}>
        <ItineraryScreen />
      </TripProvider>,
      { queryClient: client },
    );
    await settle();

    const banner = await screen.findByTestId("itinerary-error");
    expect(banner).toHaveTextContent(/offline/i);
  });

  it("CONTROL: no cache + 500 keeps the ordinary copy", async () => {
    seedAuthenticated();
    const trip = tripFixture();
    const client = makeClient();
    mockNavApi({
      trips: [trip],
      overrides: {
        "GET /trips/:tripId/itinerary": () => Promise.reject(SERVER()),
        "GET /trips/:tripId/bookings": () => Promise.reject(SERVER()),
      },
    });

    await renderWithProviders(
      <TripProvider trip={trip}>
        <ItineraryScreen />
      </TripProvider>,
      { queryClient: client },
    );
    await settle();

    const banner = await screen.findByTestId("itinerary-error");
    expect(banner).toHaveTextContent(/Couldn't load the itinerary/);
    expect(banner).not.toHaveTextContent(/offline/i);
  });
});

describe("R-itin-29 — deeplink-out buttons disable with an offline hint", () => {
  async function renderBookingDetail(opts: { offline: boolean }) {
    seedAuthenticated();
    const trip = tripFixture();
    const client = makeClient();
    const detail: BookingWithItems = { ...lodgingBooking(), items: [] };
    client.setQueryData(queryKeys.tripBooking(TEST_TRIP_ID, BOOKING_LODGING_ID), detail);
    if (opts.offline) await armGuardFailure(client, NETWORK());
    mockNavApi({
      trips: [trip],
      overrides: {
        "GET /trips/:tripId/bookings/:bookingId": () => Promise.resolve(detail),
        "GET /trips/:tripId/bookings": () => Promise.resolve({ items: [], nextCursor: null }),
      },
    });
    await renderWithProviders(
      <TripProvider trip={trip}>
        <BookingDetailScreen />
      </TripProvider>,
      { queryClient: client },
    );
    await settle();
    await screen.findByTestId("booking-detail-screen");
  }

  it("disables every partner button and shows the offline hint", async () => {
    await renderBookingDetail({ offline: true });
    const airbnb = await screen.findByTestId("booking-detail-button-deeplink-airbnb");
    expect(airbnb.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId("booking-detail-button-deeplink-airbnb-hint")).toHaveTextContent(
      DEEPLINK_OFFLINE_HINT,
    );
    // Not just one partner — the whole panel.
    for (const partner of ["booking", "expedia", "vrbo"]) {
      expect(
        screen.getByTestId(`booking-detail-button-deeplink-${partner}`).props.accessibilityState
          ?.disabled,
      ).toBe(true);
    }
  });

  it("CONTROL: the identical booking ONLINE renders the same buttons ENABLED, with no hint", async () => {
    await renderBookingDetail({ offline: false });
    const airbnb = await screen.findByTestId("booking-detail-button-deeplink-airbnb");
    // If this were disabled too, the pin above would hold for a panel that is
    // simply always disabled — which is the whole failure mode being excluded.
    await waitFor(() => expect(airbnb.props.accessibilityState?.disabled).toBe(false));
    expect(screen.queryByTestId("booking-detail-button-deeplink-airbnb-hint")).toBeNull();
  });
});
