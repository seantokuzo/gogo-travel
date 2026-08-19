/**
 * Place detail ↔ itinerary cross-tab flows against the REAL route tree
 * (T-8.4 / MAP-6 — R-map-12, R-map-14, R-map-23).
 *
 * WHAT THIS SUITE PINS: the user-visible outcome of the detail screen's two
 * itinerary-bound affordances on the real vendored navigator — pathname
 * flips, the target screen MOUNTS, prefill params ARRIVE and are consumed,
 * and linked rows land on the ITEM'S OWN DETAIL per kind (interp 17 / the
 * MAP-6 "lands on item detail with tab stacks intact" bullet): item-kind →
 * `item/[itemId]`, booking-kind → `booking/[bookingId]` directly. It is the
 * regression net for the whole chain (screen → jump → push → target).
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM (mutation-probe result, 2026-08-19 —
 * R1 tests lane confirmed the same on the PUSH shape): removing the
 * `jumpToTripTab` leg and firing the bare cross-tab `router.push`/
 * `router.navigate` STAYS GREEN under renderRouter — jest does NOT
 * reproduce the sim-confirmed "imperative navigate at another tab's URL
 * silently no-ops" landmine for these call shapes, so this suite cannot
 * prove the tab-jump leg is load-bearing. The two-step ships anyway: the
 * tab-bar-equivalent move is the one mechanic sim-verified to work
 * (mobile.md), and the ORDER of the two legs is pinned component-level in
 * place-detail-screen.test.tsx (callSequence). The jump leg's necessity
 * rests on the sim evidence, not on this file — phase-QA exercises it live.
 *
 * Quirk 3 (render-app.ts): pressing leaves scheduled transition work that
 * wedges later mounts in the same file — ALL presses live in the single
 * walkthrough test at the end; pure-URL renders come first.
 *
 * renderRouter suites share the PROD queryClient singleton — sanctioned
 * reset recipe in afterEach (mobile.md).
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

import { ApiRequestError } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_LODGING_ID,
  defaultBookings,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  itineraryApiOverrides,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { renderApp } from "@/test-utils/render-app";
import {
  makePlace,
  makeSavedPlaceWithPlace,
  makeTrip,
  mockNavApi,
  TEST_PLACE_ID,
} from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// The itinerary day list rides react-native-reorderable-list, whose REAL
// component needs reanimated APIs the sanctioned jest mock doesn't provide
// (`useComposedEventHandler`) — passthrough-FlatList mock, the
// itinerary-reorder-flow precedent. Drag behavior is not under pin here.
jest.mock("react-native-reorderable-list", () => {
  // jest.mock factories are hoisted above ES imports — require() is the only
  // way to reach modules from inside one (same shape as jest.setup.js).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FlatList } = require("react-native");
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      const { onReorder: _onReorder, dragEnabled: _dragEnabled, ...rest } = props;
      return React.createElement(FlatList, rest);
    },
    useReorderableDrag: () => () => undefined,
  };
});

/** The fixture place — ITEM_C (place_visit, day 3) points at it. */
const PLACE = makePlace({ name: "Fushimi Inari" });

/**
 * The lodging booking sits AT this place too — its booking-kind item
 * (ITEM_LODGING) resolves the place through the parent booking, so the
 * detail lists BOTH linked-row kinds (the interp-17 per-kind walkthrough).
 */
const BOOKINGS_AT_PLACE = defaultBookings().map((booking) =>
  booking.id === BOOKING_LODGING_ID ? { ...booking, place_id: TEST_PLACE_ID } : booking,
);

beforeEach(() => {
  mockNavApi({
    trips: [makeTrip({ id: TEST_TRIP_ID, start_date: TRIP_START, end_date: TRIP_END })],
    overrides: {
      ...itineraryApiOverrides({ bookings: BOOKINGS_AT_PLACE }),
      "GET /places/:placeId": () => Promise.resolve({ place: PLACE }),
      "GET /trips/:tripId/saved-places": () =>
        Promise.resolve({ items: [makeSavedPlaceWithPlace()], nextCursor: null }),
      // Booking detail's own read (the walkthrough's booking-kind leg).
      "GET /trips/:tripId/bookings/:bookingId": (input) => {
        const params = input.params as { bookingId?: string } | undefined;
        const booking = BOOKINGS_AT_PLACE.find((row) => row.id === params?.bookingId);
        return booking === undefined
          ? Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found"))
          : Promise.resolve({ ...booking, items: [] });
      },
    },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("cold URL entry mounts the place detail inside the map tab (R-map-4 push route)", async () => {
  const result = await renderApp(`/${TEST_TRIP_ID}/map/place/${TEST_PLACE_ID}`);
  expect(await screen.findByTestId("place-detail-screen")).toBeOnTheScreen();
  expect(await screen.findByText("Fushimi Inari")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/map/place/${TEST_PLACE_ID}`);
  // R-map-14: both linked-row kinds render — ITEM_C by its own place_id,
  // ITEM_LODGING through its parent booking (the SAME place resolution the
  // pin builder uses).
  expect(await screen.findByTestId(`place-detail-list-item-${ITEM_C_ID}`)).toBeOnTheScreen();
  expect(await screen.findByTestId(`place-detail-list-item-${ITEM_LODGING_ID}`)).toBeOnTheScreen();
});

it("WALKTHROUGH: linked rows land on ITEM DETAIL per kind with tab stacks intact (interp 17, MAP-6 bullet) → Add to day opens the prefilled modal (R-map-12)", async () => {
  const result = await renderApp(`/${TEST_TRIP_ID}/map/place/${TEST_PLACE_ID}`);
  await screen.findByTestId("place-detail-screen");

  // ---- Leg 1: ITEM-kind linked row → the item's OWN detail in the
  // itinerary tab's stack (§2.7's push mechanic — never the day list).
  await fireEvent.press(await screen.findByTestId(`place-detail-list-item-${ITEM_C_ID}`));
  await waitFor(() =>
    expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary/item/${ITEM_C_ID}`),
  );
  expect(await screen.findByTestId("itinerary-item-screen")).toBeOnTheScreen();

  // ---- Leg 2: tab-bar press back to the map tab — its stack is preserved
  // (R-nav-10), so the place detail is still the top of the map stack:
  // "with tab stacks intact", the bullet's second half.
  await fireEvent.press(screen.getByTestId("tab-bar-map"));
  await waitFor(() =>
    expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/map/place/${TEST_PLACE_ID}`),
  );
  expect(await screen.findByTestId("place-detail-screen")).toBeOnTheScreen();

  // ---- Leg 3: BOOKING-kind linked row → booking/[bookingId] DIRECTLY
  // (routing via item/[itemId] would only R-itin-27-replace itself there).
  await fireEvent.press(await screen.findByTestId(`place-detail-list-item-${ITEM_LODGING_ID}`));
  await waitFor(() =>
    expect(result.getPathname()).toBe(
      `/${TEST_TRIP_ID}/itinerary/booking/${BOOKING_LODGING_ID}`,
    ),
  );
  expect(await screen.findByTestId("booking-detail-screen")).toBeOnTheScreen();

  // ---- Leg 4: back to the map tab once more — the place detail survives
  // a second round trip.
  await fireEvent.press(screen.getByTestId("tab-bar-map"));
  await waitFor(() =>
    expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/map/place/${TEST_PLACE_ID}`),
  );
  expect(await screen.findByTestId("place-detail-screen")).toBeOnTheScreen();

  // ---- Leg 5: Add to day → the item/new modal in the itinerary stack,
  // prefilled place_visit + place (R-map-12).
  await fireEvent.press(screen.getByTestId("place-detail-button-add-to-day"));
  await waitFor(() =>
    expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary/item/new`),
  );
  expect(await screen.findByTestId("itinerary-item-new-screen")).toBeOnTheScreen();
  const params = result.getSearchParams();
  expect(params["category"]).toBe("place_visit");
  expect(params["placeId"]).toBe(TEST_PLACE_ID);
  expect(params["placeName"]).toBe("Fushimi Inari");
  // The form actually CONSUMED the preselect: the place picker's input
  // carries the place name as its value (PlacePickerField seeds `query`
  // from `selected.name`) instead of the empty search state.
  expect(await screen.findByDisplayValue("Fushimi Inari")).toBeOnTheScreen();
});
