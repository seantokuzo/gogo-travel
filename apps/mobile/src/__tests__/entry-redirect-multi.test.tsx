/**
 * Entry redirect, multi-active case (T-6.6 / NAV-3; R-nav-23): with 2+
 * concurrently active trips, a cold launch lands on the MOST-RECENTLY-VIEWED
 * active trip's today tab (the one-slot MMKV stamp), and the trip header
 * offers the switcher affordance between active trips.
 *
 * Own file, FIRST mount — two-hop flow (see entry-redirect-active.test.tsx
 * for the quirk-3 rationale; findBy budget is fake milliseconds).
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip, stampLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TRIP_B_ID, TRIP_C_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makeActiveTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-nav-23: 2+ active trips land on the most-recently-viewed one's today tab; the hosted switcher moves between active trips", async () => {
  mockNavApi({ trips: [makeActiveTrip(TRIP_B_ID), makeActiveTrip(TRIP_C_ID)] });
  stampLastViewedTrip(TRIP_C_ID);
  const result = await renderApp("/");
  expect(await screen.findByTestId("today-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TRIP_C_ID}/today`);

  // R-nav-23 second half: with 2+ active trips the layout hosts the header
  // trip-switcher affordance for moving between them WITHOUT the trip list.
  // (Presses in the same single mount — harness quirk 3 keeps this test last.)
  await fireEvent.press(screen.getByTestId("trip-switcher-button"));
  expect(await screen.findByTestId("trip-switcher-sheet")).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId(`trip-switcher-list-item-${TRIP_B_ID}`));
  await waitFor(() => expect(result.getPathname()).toBe(`/${TRIP_B_ID}/today`), {
    timeout: 10000,
  });
  expect(await screen.findByTestId("today-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
});
