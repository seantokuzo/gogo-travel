/**
 * B-25 — the trip shell is not a dead end, against the REAL route tree.
 *
 * `[tripId]/_layout` is a tab navigator and entering a trip replaces the
 * stack, so there is no back affordance: the switcher bar's "All trips" row
 * is the only exit. `TripSwitcher.test.tsx` pins what the component DOES;
 * this file pins that the press actually LANDS — mobile.md's 🔴 landmine is
 * that imperative navigation can silently no-op once inside the vendored tab
 * navigator, so a `router.replace` mock assertion alone would not be evidence.
 *
 * Fixtures are the exact account device QA hit: ONE trip, and a PLANNING one
 * — under the old `activeTrips.length < 2` gate the switcher rendered nothing
 * at all here, which is what made it a dead end.
 *
 * Quirk 3 (render-app.ts): a pressing walkthrough leaves scheduled transition
 * work that wedges any later mount in the same file, so this file holds
 * exactly one test.
 */
import { screen, fireEvent, waitFor } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("B-25: a single-trip account can leave the trip shell — switcher → All trips → the trip list", async () => {
  mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID)] });
  const result = await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("itinerary-screen", {}, { timeout: 10000 })).toBeOnTheScreen();

  // The affordance exists with ONE (non-active) trip — the regression itself.
  await fireEvent.press(screen.getByTestId("trip-switcher-button"));
  expect(await screen.findByTestId("trip-switcher-sheet")).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("trip-switcher-list-item-all-trips"));
  expect(await screen.findByTestId("trip-list-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
  // Route groups are transparent in the URL — `(trips)/index` is "/".
  await waitFor(() => expect(result.getPathname()).toBe("/"), { timeout: 10000 });
  // Replaced, not pushed: the root stack holds ONE route — the trip shell is
  // gone, not parked underneath waiting for a back gesture to re-enter it.
  // Replaced, not pushed — the app-level stack (inside `__root`) holds ONE
  // route. A push would leave `[tripId]` parked beneath it, one back gesture
  // from re-entering the trip the user just escaped.
  const appStack = result.getRouterState()?.routes[0]?.state;
  expect(appStack?.routes.map((route) => route.name)).toEqual(["(trips)"]);
});
