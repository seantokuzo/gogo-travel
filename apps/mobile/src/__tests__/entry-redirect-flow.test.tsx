/**
 * Entry redirect against the REAL route tree (T-6.6 / NAV-3; §2.2 ladder) —
 * the trip-list-landing half. Named per acceptance line:
 *   - no active trip → trip list                              (R-nav-5)
 *   - 2+ active, never viewed → trip list                     (R-nav-23)
 *   - stale stamp → trip list                                 (R-nav-23)
 *
 * The land-INSIDE-a-trip cases (R-nav-6 / R-nav-23 most-recently-viewed)
 * live in entry-redirect-active.test.tsx / entry-redirect-multi.test.tsx:
 * a two-hop mount (entry query → replace → guard query → tab mount) only
 * sequences reliably as the FIRST mount of its file — an earlier navigating
 * mount wedges it (harness quirk 3; every entry test navigates on mount).
 */
import { screen } from "expo-router/testing-library";

import { ApiRequestError } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip, stampLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID, TRIP_B_ID, TRIP_C_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
  mockNavApi,
} from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-nav-5: launch with no active trip lands on the trip list", async () => {
  mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID), makePastTrip(TRIP_B_ID)] });
  await renderApp("/");
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
});

it("R-nav-23: 2+ active trips, never viewed → trip list", async () => {
  mockNavApi({ trips: [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)] });
  const result = await renderApp("/");
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe("/");
});

it("R-nav-23: a stamp pointing outside the active set behaves like never-viewed", async () => {
  mockNavApi({
    trips: [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID), makePastTrip(TEST_TRIP_ID)],
  });
  stampLastViewedTrip(TEST_TRIP_ID); // most-recently-viewed trip has since ended
  await renderApp("/");
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
});

it("R-nav-5 posture: a failed trips read falls back to the trip list (its own error surface owns retry)", async () => {
  // A 4xx settles immediately (shouldRetry pins 4xx = no retry in its own
  // unit tests); this flow only cares that error → the R-nav-5 default.
  mockNavApi({
    overrides: {
      "GET /trips": () =>
        Promise.reject(new ApiRequestError(400, "VALIDATION_FAILED", "bad request")),
    },
  });
  await renderApp("/");
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
});
