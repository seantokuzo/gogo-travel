/**
 * Leave-trip walkthrough against the REAL tree (T-6.9 / CT-5 — trips spec
 * §2.5, R-tripui-20): a NON-owner member → Confirm → DELETE
 * /trips/:tripId/members/:me (the caller's OWN membership row) → trip list +
 * subtree scrub. Owner never reaches this flow — their row is the
 * transfer-first hint (covered in the settings screen suite).
 *
 * renderRouter suite — single interactive flow, own file (harness quirk 3).
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

import { queryClient, queryKeys } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { TEST_USER } from "@/test-utils/session-fixtures";
import { makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-tripui-20: leave (editor) = Confirm → DELETE members/:me → trip list + scrub", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID, { role: "editor", member_count: 2 });
  const removed: Record<string, unknown>[] = [];
  mockNavApi({
    trips: [trip],
    overrides: {
      "DELETE /trips/:tripId/members/:userId": (input) => {
        removed.push(input);
        return Promise.resolve(undefined);
      },
    },
  });
  await renderApp(`/${TEST_TRIP_ID}/more/settings`);
  await screen.findByTestId("trip-settings-screen");
  // Warm the list entry so the post-leave invalidation is observable.
  queryClient.setQueryData(queryKeys.trips, { items: [trip], nextCursor: null });
  const listUpdatesBefore = queryClient.getQueryState(queryKeys.trips)?.dataUpdateCount ?? 0;

  await fireEvent.press(screen.getByTestId("trip-settings-button-leave"));
  await fireEvent.press(screen.getByTestId("trip-settings-button-leave-confirm"));

  // The wire call targets the CALLER's own membership row.
  await waitFor(() => expect(removed).toHaveLength(1));
  expect(removed[0]).toEqual({
    params: { tripId: TEST_TRIP_ID, userId: TEST_USER.id },
  });

  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
  // The teardown's deferred macrotask evicts; waitFor advances fake timers.
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined(),
  );
  // Stale flag OR the trip switcher's active observer already refetched —
  // either proves the list refreshed after leaving (see the delete suite).
  const listState = queryClient.getQueryState(queryKeys.trips);
  expect(
    (listState?.isInvalidated ?? false) || (listState?.dataUpdateCount ?? 0) > listUpdatesBefore,
  ).toBe(true);
});
