/**
 * R-map-20 hygiene against the REAL tree (T-8.5 / MAP-5 — map spec §2.5
 * "delete pack on trip delete/leave"): deleting the trip drops its offline
 * pack + MMKV annotation alongside the T-6.6 subtree scrub. Single
 * interactive walkthrough, own file (harness quirk 3 — this one navigates).
 *
 * The LEAVE arm shares the same exit hook (`exitToTripList` is the only
 * caller surface for both flows — settings.tsx module doc), so the delete
 * walkthrough pins the shared line; leave's own navigation walkthrough
 * stays in trip-settings-leave.test.tsx.
 */
import { fireEvent, screen, waitFor } from "expo-router/testing-library";

import { queryClient } from "@/data";
import {
  clearPackAnnotationsForTests,
  packNameFor,
  packRegionKeyFor,
  readPackAnnotation,
  resetOfflinePacksForTests,
  writePackAnnotation,
} from "@/features/map";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makeActiveTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

interface OfflineManagerMock {
  deletePack: jest.Mock;
  getPack: jest.Mock;
}
const om = (jest.requireMock("@rnmapbox/maps") as { __mock: { offlineManager: OfflineManagerMock } })
  .__mock.offlineManager;

beforeEach(() => {
  resetOfflinePacksForTests();
  clearPackAnnotationsForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("deleting the trip deletes its pack + annotation (R-map-20)", async () => {
  writePackAnnotation({
    tripId: TEST_TRIP_ID,
    styleUrl: "mapbox://styles/mapbox/light-v11",
    regionKey: packRegionKeyFor(35.0116, 135.7681),
    completedAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 12_000_000,
  });
  // Coherent device state (the controller's reconcile clears
  // annotation-without-pack — the delete walkthrough needs a real pack).
  om.getPack.mockImplementation(async () => ({ name: packNameFor(TEST_TRIP_ID) }));
  mockNavApi({
    trips: [makeActiveTrip(TEST_TRIP_ID, { role: "owner" })],
    overrides: {
      "DELETE /trips/:tripId": () => Promise.resolve(undefined),
    },
  });
  await renderApp(`/${TEST_TRIP_ID}/more/settings`);
  await screen.findByTestId("trip-settings-screen");

  await fireEvent.press(screen.getByTestId("trip-settings-button-delete"));
  await fireEvent.press(screen.getByTestId("trip-settings-button-delete-confirm"));

  // Exit lands on the list; the pack + annotation went with the trip.
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
  await waitFor(() =>
    expect(om.deletePack).toHaveBeenCalledWith(packNameFor(TEST_TRIP_ID)),
  );
  expect(readPackAnnotation(TEST_TRIP_ID)).toBeUndefined();
});
