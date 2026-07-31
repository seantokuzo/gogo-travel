/**
 * Delete-trip walkthrough against the REAL tree (T-6.9 / CT-5 —
 * R-tripui-20/21): owner → hard Confirm → DELETE /trips/:tripId → lands on
 * the trip list → the trip's cached SUBTREE is evicted (detail + members +
 * invites) while the list survives invalidated (the T-6.6 scrub pattern —
 * eviction rides the screen's unmount teardown, after navigation).
 *
 * renderRouter suite — single interactive flow, own file (harness quirk 3:
 * a pressing/navigating test wedges any later mount in the same file).
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

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
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-tripui-20: delete = Confirm → DELETE → trip list, with the dead trip's subtree scrubbed", async () => {
  const trip = makePlanningTrip(TEST_TRIP_ID, { role: "owner" });
  const request = mockNavApi({
    trips: [trip],
    overrides: {
      "DELETE /trips/:tripId": () => Promise.resolve(undefined),
    },
  });
  await renderApp(`/${TEST_TRIP_ID}/more/settings`);
  await screen.findByTestId("trip-settings-screen");

  // Warm the caches the eviction must scrub (members/invites land with
  // CT-4's screens; entries here stand in for their cached lists).
  queryClient.setQueryData(queryKeys.trips, { items: [trip], nextCursor: null });
  queryClient.setQueryData(queryKeys.tripMembers(TEST_TRIP_ID), []);
  queryClient.setQueryData(queryKeys.tripInvites(TEST_TRIP_ID), []);

  // Cancel first — a cancelled dialog must NOT delete (R-ds-18).
  await fireEvent.press(screen.getByTestId("trip-settings-button-delete"));
  await fireEvent.press(screen.getByTestId("trip-settings-button-delete-cancel"));
  expect(
    request.mock.calls.filter(
      ([descriptor]) => (descriptor as { method: string }).method === "DELETE",
    ),
  ).toHaveLength(0);

  const listUpdatesBefore = queryClient.getQueryState(queryKeys.trips)?.dataUpdateCount ?? 0;
  await fireEvent.press(screen.getByTestId("trip-settings-button-delete"));
  await fireEvent.press(screen.getByTestId("trip-settings-button-delete-confirm"));

  await waitFor(() =>
    expect(
      request.mock.calls.filter(
        ([descriptor]) => (descriptor as { method: string; path: string }).method === "DELETE",
      ),
    ).toHaveLength(1),
  );
  // Post-delete navigation: back on the trip list, out of the dead trip.
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();

  // Eviction rides the unmount teardown's deferred macrotask — waitFor
  // advances the suite's fake timers until it lands; then the whole subtree
  // is gone while the list survives (invalidated).
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined(),
  );
  expect(queryClient.getQueryState(queryKeys.tripMembers(TEST_TRIP_ID))).toBeUndefined();
  expect(queryClient.getQueryState(queryKeys.tripInvites(TEST_TRIP_ID))).toBeUndefined();
  // List freshness: the exact invalidate either left the stale flag, or the
  // trip switcher's ACTIVE useTrips observer already refetched it (which
  // clears the flag) — either proves the list refreshed post-delete.
  const listState = queryClient.getQueryState(queryKeys.trips);
  expect(listState).toBeDefined();
  expect(
    (listState?.isInvalidated ?? false) || (listState?.dataUpdateCount ?? 0) > listUpdatesBefore,
  ).toBe(true);
});
