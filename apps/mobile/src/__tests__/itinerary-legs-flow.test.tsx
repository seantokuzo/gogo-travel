/**
 * Travel-time chips end-to-end (T-7.5 / IT-3 — R-itin-4/5/6) on the REAL
 * itinerary screen over the REAL data hooks (network mocked by descriptor),
 * so the composite read's `legs` reach the chip through the same path they
 * do in the app.
 *
 * Absent legs are the FIRST-CLASS path here, not an edge case: with the
 * Mapbox token parked the shipping configuration is transit-only, and a pair
 * with nothing computed must render a clean nothing — no chip, no spinner
 * row, no inline error, no retry prompt (R-itin-6). Every such assertion is
 * paired with a CONTROL arm that renders the SAME screen WITH legs and finds
 * the chip, so "nothing rendered" can never pass because the fixture was
 * incapable of rendering anything.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Linking from "expo-linking";

import ItineraryScreen from "@/app/[tripId]/itinerary/index";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_LODGING_ID,
  defaultBookings,
  defaultItineraryItems,
  defaultTravelLegs,
  ITEM_A_ID,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  makeItineraryItem,
  makeTravelLeg,
  TRIP_END,
  TRIP_START,
  itineraryApiOverrides,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

/**
 * `VirtualizedList` batches its cell-render updates behind
 * `updateCellsBatchingPeriod` (50 ms by default) — a `setTimeout(0)` drain
 * cannot reach it, so the drain window has to outlast the period.
 */
const VIRTUALIZED_LIST_BATCH_MS = 60;

/**
 * Drain every pending batch inside ONE act window.
 *
 * The plan list is a real `VirtualizedList`, and it schedules its own
 * cell-render updates on a timer independently of TanStack's notify batches.
 * A single drain absorbs one of the two; the other lands at the next `await`
 * in the test body — an un-acted `VirtualizedList` update that only appears
 * under worker contention (the B-2 class). Successive cycles INSIDE one act
 * window absorb whatever each previous cycle scheduled.
 */
const SETTLE_DELAYS = [0, 0, VIRTUALIZED_LIST_BATCH_MS, 0] as const;

async function settle(): Promise<void> {
  await act(async () => {
    for (const delay of SETTLE_DELAYS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  });
}

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
jest.mock("expo-linking", () => ({ openURL: jest.fn(async () => true) }));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

const openURLMock = Linking.openURL as jest.Mock;

async function renderItinerary(opts?: { api?: ItineraryApiOptions; role?: "owner" | "viewer" }) {
  seedAuthenticated();
  const trip = makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    destination_name: "Tokyo",
    role: opts?.role ?? "owner",
  });
  mockNavApi({ trips: [trip], overrides: itineraryApiOverrides(opts?.api) });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  // Settle BOTH queries' notify batches inside one act window (B-2 posture).
  await settle();
  return { trip, view };
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  openURLMock.mockClear();
  openURLMock.mockImplementation(async () => true);
});

describe("chip rendering (R-itin-4/5/6)", () => {
  it("renders the chip for a computed pair with the R-itin-5 duration", async () => {
    await renderItinerary({ api: { legs: defaultTravelLegs() } });
    const chip = await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`);
    expect(chip).toBeOnTheScreen();
    // Transit-only pair, 1080s → the chip shows the one computed mode.
    expect(screen.getByText("18 min")).toBeOnTheScreen();
  });

  it("ABSENT legs render nothing — no chip, no spinner, no error, no retry", async () => {
    await renderItinerary({ api: { legs: [] } });
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_A_ID}`)).toBeNull();
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_LODGING_ID}`)).toBeNull();
    // Nothing anywhere on the surface offers to fix it.
    expect(screen.queryByText("18 min")).toBeNull();
    expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull();
    expect(screen.queryByTestId("itinerary-error")).toBeNull();
    expect(screen.queryByTestId("itinerary-refresh-error")).toBeNull();
  });

  it("CONTROL for the above: the identical screen WITH legs does render the chip", async () => {
    await renderItinerary({ api: { legs: defaultTravelLegs() } });
    expect(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`)).toBeOnTheScreen();
  });

  it("a PARTIAL leg set chips only its own pair and leaves the rest silent", async () => {
    // Two located day-1 items and a day-3 item; only the day-1 pair computed.
    const items = [
      makeItineraryItem({ id: ITEM_A_ID, start_time: "09:00", sort_order: 1024 }),
      makeItineraryItem({ id: ITEM_C_ID, start_time: "11:00", sort_order: 2048 }),
      makeItineraryItem({ id: ITEM_LODGING_ID, day: TRIP_END, start_time: "10:00", sort_order: 1024 }),
    ];
    await renderItinerary({
      api: {
        items,
        bookings: [],
        legs: [makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "transit", { duration_seconds: 420 })],
      },
    });
    expect(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`)).toBeOnTheScreen();
    expect(screen.getByText("7 min")).toBeOnTheScreen();
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_C_ID}`)).toBeNull();
  });

  it("viewers see chips — a leg is read-only data, not a write affordance", async () => {
    await renderItinerary({ api: { legs: defaultTravelLegs() }, role: "viewer" });
    expect(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`)).toBeOnTheScreen();
  });
});

describe("mode sheet (R-itin-4/5)", () => {
  it("a chip tap lists every computed mode with the shown one marked", async () => {
    await renderItinerary({
      api: {
        legs: [
          makeTravelLeg(ITEM_A_ID, ITEM_LODGING_ID, "walking", { duration_seconds: 480 }),
          makeTravelLeg(ITEM_A_ID, ITEM_LODGING_ID, "driving", { duration_seconds: 300 }),
          makeTravelLeg(ITEM_A_ID, ITEM_LODGING_ID, "transit", {
            duration_seconds: 900,
            distance_meters: 4200,
          }),
        ],
      },
    });
    await fireEvent.press(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`));

    expect(screen.getByTestId("itinerary-leg-sheet")).toBeOnTheScreen();
    expect(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-mode-walking`)).toBeOnTheScreen();
    expect(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-mode-driving`)).toBeOnTheScreen();
    expect(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-mode-transit`)).toBeOnTheScreen();
    // Provenance rides the row so a nonsense transit result is legible.
    expect(screen.getByText("4.2 km · transitous")).toBeOnTheScreen();
    // R-itin-5: an 8-minute walk is the shown mode.
    expect(screen.getByText("Shown")).toBeOnTheScreen();
    expect(screen.getByText("Walk · 8 min")).toBeOnTheScreen();

    // Close through the BUTTON — the DS scrim is unqueryable in RNTL.
    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());
  });

  it("absent modes are simply missing — a transit-only pair lists one row", async () => {
    await renderItinerary({ api: { legs: defaultTravelLegs() } });
    await fireEvent.press(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`));
    expect(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-mode-transit`)).toBeOnTheScreen();
    // No placeholder / unavailable / error row for the three parked modes.
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_A_ID}-mode-driving`)).toBeNull();
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_A_ID}-mode-walking`)).toBeNull();
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_A_ID}-mode-cycling`)).toBeNull();
    expect(screen.queryByTestId("itinerary-leg-error")).toBeNull();

    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());
  });
});

describe("directions handoff (R-itin-4)", () => {
  it("opens the exact Maps URL for the shown mode, with the trip destination as context", async () => {
    await renderItinerary({ api: { legs: defaultTravelLegs() } });
    await fireEvent.press(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`));
    await fireEvent.press(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-directions`));

    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(1));
    expect(openURLMock).toHaveBeenCalledWith(
      "https://www.google.com/maps/dir/?api=1&origin=UA%20837%20SFO%E2%86%92NRT%2C%20Tokyo&destination=Park%20Hyatt%20Tokyo&travelmode=transit",
    );

    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());
  });

  it("an unnamed endpoint disables Directions with a hint instead of querying junk", async () => {
    const items = [
      makeItineraryItem({ id: ITEM_A_ID, title: "Museum", start_time: "09:00", sort_order: 1024 }),
      makeItineraryItem({
        id: ITEM_C_ID,
        kind: "place_visit",
        place_id: "44444444-4444-4444-8444-444444444444",
        title: null,
        start_time: "11:00",
        sort_order: 2048,
      }),
    ];
    await renderItinerary({
      api: { items, bookings: [], legs: [makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "walking")] },
    });
    await fireEvent.press(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`));

    const directions = screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-directions`);
    expect(directions).toBeDisabled();
    expect(
      screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-directions-hint`),
    ).toHaveTextContent("Needs a name or address for the destination");
    // The GUARD's effect, not the disabled attribute (RNTL won't fire a
    // handler on a disabled element, so pressing it proves nothing): no URL
    // was ever constructed for this pair.
    await fireEvent.press(directions);
    expect(openURLMock).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());
  });

  it("a refused open surfaces the banner and never leaves the sheet lying", async () => {
    openURLMock.mockImplementation(async () => {
      throw new Error("no handler");
    });
    await renderItinerary({ api: { legs: defaultTravelLegs() } });
    await fireEvent.press(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`));
    await fireEvent.press(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-directions`));

    expect(await screen.findByTestId("itinerary-leg-error")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());
  });

  it("reopening after a failed open starts clean (the banner does not persist)", async () => {
    openURLMock.mockImplementation(async () => {
      throw new Error("no handler");
    });
    await renderItinerary({ api: { legs: defaultTravelLegs() } });
    await fireEvent.press(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`));
    await fireEvent.press(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-directions`));
    await screen.findByTestId("itinerary-leg-error");

    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());

    await fireEvent.press(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}`));
    expect(screen.queryByTestId("itinerary-leg-error")).toBeNull();

    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());
  });
});

describe("leg data hygiene", () => {
  it("a leg whose pair is no longer adjacent is not rendered (stale-after-reorder)", async () => {
    // The server's legs still describe the OLD adjacency A→lodging, but the
    // cached items now order lodging BEFORE the flight. Nothing renders —
    // the chip self-heals to absent rather than showing a backwards ETA.
    const items = defaultItineraryItems().map((item) =>
      item.id === ITEM_A_ID
        ? { ...item, sort_order: 4096 }
        : item.id === ITEM_LODGING_ID
          ? { ...item, sort_order: 512 }
          : item,
    );
    await renderItinerary({ api: { items, legs: defaultTravelLegs() } });
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_A_ID}`)).toBeNull();
    expect(screen.queryByTestId(`itinerary-leg-${ITEM_LODGING_ID}`)).toBeNull();
  });

  it("legs for a booking the enrichment read never returned still render", async () => {
    // Enrichment gap: the chip is composite-read data, so it must not depend
    // on the bookings list having resolved the parent's title.
    await renderItinerary({
      api: { legs: defaultTravelLegs(), bookings: [defaultBookings()[0]!] },
    });
    expect(await screen.findByTestId(`itinerary-leg-${ITEM_A_ID}`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}`));
    // Unknown parent → generic label, and Directions degrades to disabled
    // rather than querying "Booking".
    expect(screen.getByTestId(`itinerary-leg-${ITEM_A_ID}-directions`)).toBeDisabled();
    expect(BOOKING_LODGING_ID).toBeTruthy();

    await fireEvent.press(screen.getByTestId("itinerary-leg-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-leg-sheet")).toBeNull());
  });
});
