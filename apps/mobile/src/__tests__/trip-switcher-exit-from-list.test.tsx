/**
 * B-25 round 1 — the exit on the DOMINANT entry shape: pushed from the list.
 *
 * `trip-switcher-exit.test.tsx` covers cold launch (nothing under `[tripId]`),
 * where `replace` and `dismissTo` produce the same stack. This file covers the
 * shape that tells them apart: `(trips)/index` enters a trip with
 * `router.push`, so the app stack is `["(trips)", "[tripId]"]`, and
 * expo-router's REPLACE swaps the route AT `state.index` IN PLACE (vendored
 * `react-navigation/routers/StackRouter.js`, `case 'REPLACE'`) — it never pops
 * to an existing instance. Leaving with `replace` therefore yields
 * `["(trips)", "(trips)"]`: `stack-options.ts` keeps `gestureEnabled` on, so an
 * edge swipe off the trip list reveals a phantom identical trip list, and every
 * enter/exit cycle leaks one more live `(trips)/index` — SectionList and trips
 * infinite-query observer included — for the rest of the session.
 *
 * The stack-shape assertion below is the pin: it is RED on `replace` and GREEN
 * on `dismissTo`. Reaching the trip list at all is NOT sufficient evidence —
 * both primitives land there.
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

it("B-25: leaving a trip entered FROM THE LIST pops back to the one trip list — it never stacks a second", async () => {
  mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID)] });
  const result = await renderApp("/(trips)");
  const row = await screen.findByTestId(
    `trip-list-list-item-${TEST_TRIP_ID}`,
    {},
    { timeout: 10000 },
  );

  // Enter the way the app really does it — a PUSH from the list row.
  await fireEvent.press(row);
  expect(await screen.findByTestId("itinerary-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
  const enteredStack = result.getRouterState()?.routes[0]?.state;
  // The premise of the whole file: the list really is parked underneath.
  expect(enteredStack?.routes.map((route) => route.name)).toEqual(["(trips)", "[tripId]"]);

  await fireEvent.press(screen.getByTestId("trip-switcher-button"));
  expect(await screen.findByTestId("trip-switcher-sheet")).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId("trip-switcher-list-item-all-trips"));

  expect(await screen.findByTestId("trip-list-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
  // Route groups are transparent in the URL — `(trips)/index` is "/".
  await waitFor(() => expect(result.getPathname()).toBe("/"), { timeout: 10000 });
  // THE PIN. `dismissTo` pops to the `(trips)` already below → exactly one.
  // `replace` would swap `[tripId]` in place → `["(trips)", "(trips)"]`.
  const exitedStack = result.getRouterState()?.routes[0]?.state;
  expect(exitedStack?.routes.map((route) => route.name)).toEqual(["(trips)"]);
});
