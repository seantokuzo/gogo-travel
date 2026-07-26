/**
 * Entry redirect, single-active-trip case (T-6.6 / NAV-3; R-nav-6): a cold
 * launch with exactly one active trip lands directly on ITS today tab.
 *
 * Own file, FIRST mount: this is a two-hop flow (entry query → replace →
 * guard query → tab mount) and only sequences reliably as the first mount of
 * its file — an earlier navigating mount wedges it (harness quirk 3). The
 * findBy budget is FAKE milliseconds under renderRouter's fake timers
 * (advanced instantly, zero wall-clock), not a real-race mask (B-2 guard is
 * act-warnings=0).
 */
import { screen } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makeActiveTrip, makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-nav-6: launch with exactly one active trip lands on ITS today tab", async () => {
  mockNavApi({ trips: [makePlanningTrip(TEST_TRIP_ID), makeActiveTrip(TRIP_B_ID)] });
  const result = await renderApp("/");
  expect(await screen.findByTestId("today-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TRIP_B_ID}/today`);
});
