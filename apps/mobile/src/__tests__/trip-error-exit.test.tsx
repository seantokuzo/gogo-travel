/**
 * B-25 round 1 — the dead end on the TRIP-LOAD ERROR path.
 *
 * The switcher fix only covers screens that reach `TripShell`. `[tripId]`'s
 * retry surface renders OUTSIDE it, so the switcher — the only exit — is not
 * mounted behind it. Cold launch makes that terminal: `GET /trips` succeeds, so
 * `app/index` redirects straight into the last-viewed trip and the app stack
 * holds only `[tripId]`; then `GET /trips/:tripId` 5xxs or times out and the
 * user has a Retry banner, no route underneath, and no back gesture. That is
 * B-25 verbatim, on a different surface.
 *
 * Quirk 3 (render-app.ts): a pressing walkthrough leaves scheduled transition
 * work that wedges any later mount in the same file, so this file holds
 * exactly one test.
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

import { ApiRequestError } from "@/auth";
import { queryClient, queryKeys } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  // clear() does NOT remove per-key defaults — drop the retryDelay override.
  queryClient.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), {});
  resetTabMemory();
  clearLastViewedTrip();
});

it("B-25: a failed trip read is not a dead end — 'Back to trips' leaves for the trip list", async () => {
  // 5xx retries before settling; collapse the backoff (retry COUNT semantics
  // are the shouldRetry unit tests' business, not this flow's).
  queryClient.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { retryDelay: 1 });
  mockNavApi({
    trips: [makePlanningTrip(TEST_TRIP_ID)],
    overrides: {
      "GET /trips/:tripId": () => Promise.reject(new ApiRequestError(503, "UNKNOWN", "down")),
    },
  });

  const result = await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("trip-error-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
  // The trap, asserted: TripShell never mounted, so there is no switcher, and
  // cold launch left nothing on the stack below this screen to go back to.
  expect(screen.queryByTestId("trip-switcher-button")).toBeNull();
  const trappedStack = result.getRouterState()?.routes[0]?.state;
  expect(trappedStack?.routes.map((route) => route.name)).toEqual(["[tripId]"]);

  await fireEvent.press(screen.getByTestId("trip-error-button-trips"));

  expect(await screen.findByTestId("trip-list-screen", {}, { timeout: 10000 })).toBeOnTheScreen();
  await waitFor(() => expect(result.getPathname()).toBe("/"), { timeout: 10000 });
  const exitedStack = result.getRouterState()?.routes[0]?.state;
  expect(exitedStack?.routes.map((route) => route.name)).toEqual(["(trips)"]);
});
