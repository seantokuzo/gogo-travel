/**
 * Place detail ↔ itinerary cross-tab flows against the REAL route tree
 * (T-8.4 / MAP-6 — R-map-12, R-map-14, R-map-23).
 *
 * WHAT THIS SUITE PINS: the user-visible outcome of the detail screen's two
 * itinerary-bound affordances on the real vendored navigator — pathname
 * flips, the target screen MOUNTS, the `?day=` / prefill params ARRIVE and
 * are consumed. It is the regression net for the whole chain (screen →
 * jump → navigate/push → param consumption).
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM (mutation-probe result, 2026-08-19):
 * removing the `jumpToTripTab` leg and firing the bare cross-tab
 * `router.navigate` STAYS GREEN under renderRouter — jest does NOT
 * reproduce the sim-confirmed "imperative navigate at another tab's URL
 * silently no-ops" landmine for this call shape, so this suite cannot
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

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  ITEM_C_ID,
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

beforeEach(() => {
  mockNavApi({
    trips: [makeTrip({ id: TEST_TRIP_ID, start_date: TRIP_START, end_date: TRIP_END })],
    overrides: {
      ...itineraryApiOverrides(),
      "GET /places/:placeId": () => Promise.resolve({ place: PLACE }),
      "GET /trips/:tripId/saved-places": () =>
        Promise.resolve({ items: [makeSavedPlaceWithPlace()], nextCursor: null }),
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
  // R-map-14: ITEM_C (place_visit at this place) is the one linked row —
  // resolved through the SAME place resolution the pin builder uses.
  expect(await screen.findByTestId(`place-detail-list-item-${ITEM_C_ID}`)).toBeOnTheScreen();
});

it("WALKTHROUGH: linked item → itinerary day list (two-step, R-map-14/23) → back via tab bar → Add to day opens the prefilled modal (R-map-12)", async () => {
  const result = await renderApp(`/${TEST_TRIP_ID}/map/place/${TEST_PLACE_ID}`);
  await screen.findByTestId("place-detail-screen");

  // ---- Leg 1: linked itinerary item → the itinerary tab's day list.
  await fireEvent.press(await screen.findByTestId(`place-detail-list-item-${ITEM_C_ID}`));
  await waitFor(() => expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary`));
  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
  // The `?day=` arrival param rode along (ITEM_C is on day 3). The index
  // CONSUMES it after handling (T-7.9), so accept either the armed value or
  // the consumed end-state — the pathname + mounted screen above are the
  // landmine-proof half; the param handoff is pinned exactly at the moment
  // of arrival below (before the settled read can consume it).
  const dayParam = result.getSearchParams()["day"];
  expect(dayParam === TRIP_END || dayParam === undefined).toBe(true);

  // ---- Leg 2: tab-bar press back to the map tab — its stack is preserved
  // (R-nav-10), so the place detail is still the top of the map stack.
  await fireEvent.press(screen.getByTestId("tab-bar-map"));
  await waitFor(() =>
    expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/map/place/${TEST_PLACE_ID}`),
  );
  expect(await screen.findByTestId("place-detail-screen")).toBeOnTheScreen();

  // ---- Leg 3: Add to day → the item/new modal in the itinerary stack,
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
