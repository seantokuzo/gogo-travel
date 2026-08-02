/**
 * Itinerary tab — plan-mode day list (T-7.4 / IT-1; R-itin-1/8/9/28/31/30).
 * Component-level over the REAL data hooks (network mocked by descriptor)
 * and the REAL drag list — react-native-reorderable-list is deliberately
 * NOT mocked here, so a render-time fault in the library integration
 * (worklets/gesture wiring) fails THIS suite, not just the simulator
 * (the T-5.7 crash-masked-by-mocks landmine). Reorder BEHAVIOR is driven in
 * itinerary-reorder-flow.test.tsx (gestures can't be synthesized in jest).
 *
 * Pins: day sections span the trip range with empty-day add rows (R-itin-1),
 * booking-derived cards carry title + status badge (R-itin-8), spanning
 * lodging synthesizes check-in/check-out point rows both routing to ONE
 * booking detail (R-itin-31), view toggle persists per trip (R-itin-9),
 * skeleton/empty/error states (R-itin-28), §2.9 testIDs (R-itin-30).
 */
import type { TripListItem } from "@gogo/shared";
import { act, fireEvent, screen } from "@testing-library/react-native";

import ItineraryScreen from "@/app/[tripId]/itinerary/index";
import { ApiRequestError } from "@/auth";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID, TRIP_C_ID } from "@/test-utils/ids";
import {
  BOOKING_LODGING_ID,
  defaultBookings,
  defaultItineraryItems,
  ITEM_B_ID,
  ITEM_LODGING_ID,
  itineraryApiOverrides,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

function tripFixture(overrides?: Partial<TripListItem>): TripListItem {
  return makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    ...overrides,
  });
}

async function renderItinerary(opts?: {
  trip?: TripListItem;
  api?: ItineraryApiOptions;
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}) {
  seedAuthenticated();
  const trip = opts?.trip ?? tripFixture();
  const request = mockNavApi({
    trips: [trip],
    overrides: { ...itineraryApiOverrides(opts?.api), ...opts?.overrides },
  });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  // Settle BOTH queries' notify batches (setTimeout 0) inside an act window:
  // with two mounted queries, the second's notification otherwise lands
  // during a later findBy poll sleep — an un-acted update under contention
  // (B-2 class; surfaced in full-suite runs only).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { request, trip, view };
}

afterEach(async () => {
  // Absorb any tail-of-test TanStack notify batch (setTimeout(0)) into an
  // act scope BEFORE the next test starts — a notification scheduled by this
  // test's last settled op otherwise fires inside the next test's window
  // (the B-2 floating-update class; surfaced only in full-file runs).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
  mockPush.mockReset();
});

describe("day sections (R-itin-1)", () => {
  it("renders the screen root, header chrome, and a section per trip day", async () => {
    await renderItinerary();
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
    expect(screen.getByTestId("itinerary-screen")).toBeTruthy();
    expect(screen.getByTestId("itinerary-header")).toBeTruthy();
    expect(screen.getByTestId("itinerary-view-toggle")).toBeTruthy();
    expect(screen.getByTestId("itinerary-fab-add")).toBeTruthy();
    expect(screen.getByTestId(`itinerary-day-header-${TRIP_DAY_2}`)).toBeTruthy();
    expect(screen.getByTestId(`itinerary-day-header-${TRIP_END}`)).toBeTruthy();
    // Day-jump strip carries a chip per day (§2.9).
    expect(screen.getByTestId(`itinerary-day-jump-${TRIP_START}`)).toBeTruthy();
    expect(screen.getByTestId(`itinerary-day-jump-${TRIP_DAY_2}`)).toBeTruthy();
    expect(screen.getByTestId(`itinerary-day-jump-${TRIP_END}`)).toBeTruthy();
  });

  it("an empty day renders the tappable add row prefilled with its date", async () => {
    await renderItinerary();
    const addRow = await screen.findByTestId(`itinerary-day-add-${TRIP_DAY_2}`);
    await fireEvent.press(addRow);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/itinerary/item/new",
      params: { tripId: TEST_TRIP_ID, day: TRIP_DAY_2 },
    });
  });

  it("booking-derived cards render the parent's title and status badge (R-itin-8)", async () => {
    await renderItinerary();
    await screen.findByText("UA 837 SFO→NRT");
    expect(screen.getByText("Booked")).toBeTruthy();
    // The lodging parent is `planned` → accent badge label, carried by BOTH
    // synthesized rows (check-in + check-out).
    expect(screen.getAllByText("Planned")).toHaveLength(2);
    // Direct items render their own titles.
    expect(screen.getByText("Walk Shibuya")).toBeTruthy();
  });
});

describe("spanning lodging (R-itin-31)", () => {
  it("synthesizes check-in and check-out point rows; no row on the night between", async () => {
    await renderItinerary();
    await screen.findByTestId(`itinerary-list-item-${ITEM_LODGING_ID}-check-in`);
    expect(screen.getByTestId(`itinerary-list-item-${ITEM_LODGING_ID}-check-out`)).toBeTruthy();
    // ONE data row, TWO render rows — no unqualified card exists.
    expect(screen.queryByTestId(`itinerary-list-item-${ITEM_LODGING_ID}`)).toBeNull();
    expect(screen.getByText("Check-in")).toBeTruthy();
    expect(screen.getByText("Check-out")).toBeTruthy();
  });

  it("both synthesized rows route to the SAME booking detail", async () => {
    await renderItinerary();
    const checkIn = await screen.findByTestId(`itinerary-list-item-${ITEM_LODGING_ID}-check-in`);
    await fireEvent.press(checkIn);
    const checkOut = screen.getByTestId(`itinerary-list-item-${ITEM_LODGING_ID}-check-out`);
    await fireEvent.press(checkOut);
    const bookingPush = {
      pathname: "/[tripId]/itinerary/booking/[bookingId]",
      params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_LODGING_ID },
    };
    expect(mockPush).toHaveBeenNthCalledWith(1, bookingPush);
    expect(mockPush).toHaveBeenNthCalledWith(2, bookingPush);
  });

  it("non-booking cards route to the item detail instead (R-itin-27 half)", async () => {
    await renderItinerary();
    const custom = await screen.findByTestId(`itinerary-list-item-${ITEM_B_ID}`);
    await fireEvent.press(custom);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/itinerary/item/[itemId]",
      params: { tripId: TEST_TRIP_ID, itemId: ITEM_B_ID },
    });
  });
});

describe("view toggle (R-itin-9)", () => {
  // MMKV state persists across the tests in this file by design (that IS the
  // behavior under test); each test therefore restores list mode on exit.
  it("switches to the grid shell and persists per trip across a remount", async () => {
    const first = await renderItinerary();
    const toggle = await screen.findByTestId("itinerary-view-toggle");
    await fireEvent.press(toggle);
    expect(await screen.findByTestId("itinerary-grid-surface")).toBeTruthy();
    expect(screen.queryByTestId(`itinerary-day-header-${TRIP_START}`)).toBeNull();
    await first.view.unmount();

    // Same trip, fresh mount (fresh query client): grid restored from MMKV.
    await renderItinerary();
    expect(await screen.findByTestId("itinerary-grid-surface")).toBeTruthy();

    // Toggling back persists list mode again.
    await fireEvent.press(screen.getByTestId("itinerary-view-toggle"));
    expect(await screen.findByTestId(`itinerary-day-header-${TRIP_START}`)).toBeTruthy();
  });

  it("the choice is PER trip — another trip still opens in list mode", async () => {
    // Flip TEST_TRIP_ID to grid…
    const first = await renderItinerary();
    await fireEvent.press(await screen.findByTestId("itinerary-view-toggle"));
    await screen.findByTestId("itinerary-grid-surface");
    await first.view.unmount();

    // …another trip is unaffected: opens in the list default.
    const other = tripFixture({ id: TRIP_C_ID });
    const second = await renderItinerary({ trip: other });
    expect(await screen.findByTestId(`itinerary-day-header-${TRIP_START}`)).toBeTruthy();
    expect(screen.queryByTestId("itinerary-grid-surface")).toBeNull();
    await second.view.unmount();

    // Restore list mode for TEST_TRIP_ID (file-order hygiene).
    await renderItinerary();
    await screen.findByTestId("itinerary-grid-surface");
    await fireEvent.press(screen.getByTestId("itinerary-view-toggle"));
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
  });
});

describe("states (R-itin-28)", () => {
  it("skeleton day sections while the reads are in flight", async () => {
    await renderItinerary({
      overrides: {
        "GET /trips/:tripId/itinerary": () => new Promise(() => undefined), // hang
      },
    });
    expect(screen.getByTestId("itinerary-loading")).toBeTruthy();
    expect(screen.queryByTestId(`itinerary-day-header-${TRIP_START}`)).toBeNull();
  });

  it("zero items AND zero unscheduled bookings → EmptyState with the add CTA", async () => {
    await renderItinerary({ api: { items: [], bookings: [] } });
    await screen.findByTestId("itinerary-empty");
    await fireEvent.press(screen.getByTestId("itinerary-empty-add"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/itinerary/item/new",
      params: { tripId: TEST_TRIP_ID },
    });
  });

  it("zero items but unscheduled bookings exist → day sections, not EmptyState", async () => {
    await renderItinerary({ api: { items: [], bookings: defaultBookings() } });
    await screen.findByTestId(`itinerary-day-add-${TRIP_START}`);
    expect(screen.queryByTestId("itinerary-empty")).toBeNull();
  });

  it("a failed initial read renders the ErrorBanner; retry recovers the list", async () => {
    let calls = 0;
    await renderItinerary({
      overrides: {
        "GET /trips/:tripId/itinerary": () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"))
            : Promise.resolve({ items: defaultItineraryItems(), legs: [] });
        },
      },
    });
    await screen.findByTestId("itinerary-error");
    await fireEvent.press(screen.getByTestId("itinerary-error-retry"));
    // Absorb the refetch's notify batch inside act (same B-2 posture as the
    // post-mount flush in renderItinerary).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
    expect(screen.queryByTestId("itinerary-error")).toBeNull();
  });
});
