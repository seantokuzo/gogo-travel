/**
 * Management sheet content — component pins (T-8.5 / MAP-5 — R-map-19/20/22).
 * The download/refresh/delete FLOWS are walked through the real tree in
 * `src/__tests__/trip-settings-offline*.test.tsx`; this file pins the sheet
 * copy the walkthroughs can't reach cheaply:
 *  - R-map-20 past-trip offer: non-blocking free-up-space line, only for a
 *    saved pack on a `past` trip;
 *  - stale: "Update available" + the drift explainer, refresh/delete present;
 *  - PROACTIVE offline degrade (R-map-22): the derived signal already true
 *    renders the notice without any press.
 */
import { screen } from "@testing-library/react-native";

import { ApiRequestError } from "@/auth";
import { queryKeys } from "@/data";
import { TripProvider } from "@/navigation/trip-context";
import type { TripListItem } from "@gogo/shared";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { makeActiveTrip, makePastTrip } from "@/test-utils/trip-fixtures";

import { OfflinePackManager } from "./OfflinePackManager";
import {
  clearPackAnnotationsForTests,
  writePackAnnotation,
} from "./offline-pack-annotation";
import { resetOfflinePacksForTests } from "./offline-pack-controller";
import { packRegionKeyFor } from "./offline-packs";

const LIGHT_STYLE = "mapbox://styles/mapbox/light-v11";

interface OfflineManagerMock {
  getPack: jest.Mock;
}
const om = (jest.requireMock("@rnmapbox/maps") as { __mock: { offlineManager: OfflineManagerMock } })
  .__mock.offlineManager;

/**
 * Saved-pack device state = annotation AND the SDK pack it records
 * (coherent — the controller's reconcile clears annotation-without-pack).
 */
const seedPack = (styleUrl = LIGHT_STYLE) => {
  writePackAnnotation({
    tripId: TEST_TRIP_ID,
    styleUrl,
    regionKey: packRegionKeyFor(35.0116, 135.7681),
    completedAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 12_000_000,
  });
  om.getPack.mockImplementation(async () => ({ name: `trip-${TEST_TRIP_ID}` }));
};

function renderManager(
  trip: TripListItem,
  opts?: { queryClient?: ReturnType<typeof makeTestQueryClient> },
) {
  return renderWithProviders(
    <TripProvider trip={trip}>
      <OfflinePackManager />
    </TripProvider>,
    opts,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOfflinePacksForTests();
  clearPackAnnotationsForTests();
  om.getPack.mockImplementation(async () => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it("R-map-20: a PAST trip with a saved pack gets the non-blocking free-up-space offer", async () => {
  seedPack();
  await renderManager(makePastTrip(TEST_TRIP_ID));
  await settle();

  expect(screen.getByTestId("offline-pack-past-offer")).toBeOnTheScreen();
  expect(screen.getByTestId("offline-pack-button-delete")).toBeOnTheScreen();
  // Non-blocking: an offer line, never a self-opened dialog.
  expect(screen.queryByTestId("offline-pack-button-delete-confirm")).toBeNull();
});

it("no offer while the trip is still active — same pack, different status", async () => {
  seedPack();
  await renderManager(makeActiveTrip(TEST_TRIP_ID));
  await settle();
  expect(screen.queryByTestId("offline-pack-past-offer")).toBeNull();
});

it("stale (style drift): 'Update available' + explainer, refresh/delete present, no download button", async () => {
  seedPack("mapbox://styles/mapbox/dark-v11");
  await renderManager(makeActiveTrip(TEST_TRIP_ID));
  await settle();

  expect(screen.getByTestId("offline-pack-status")).toHaveTextContent(/Update available/);
  expect(screen.getByText(/changed since this was saved/)).toBeOnTheScreen();
  expect(screen.getByTestId("offline-pack-button-refresh")).toBeOnTheScreen();
  expect(screen.getByTestId("offline-pack-button-delete")).toBeOnTheScreen();
  expect(screen.queryByTestId("offline-pack-button-download")).toBeNull();
});

it("UNUSABLE destination coords (the world degrade arm): renders degraded — no crash, no download affordance", async () => {
  // The R-map-1 fallback renders with NaN coords; the region grid throws on
  // them. Round 1 (N7): the unguarded estimate memo CRASHED this surface
  // where the pill's guard survived — the render itself is the pin.
  const degraded = {
    ...makeActiveTrip(TEST_TRIP_ID),
    destination_lat: Number.NaN,
    destination_lng: Number.NaN,
  };
  await renderManager(degraded);
  await settle();

  expect(screen.getByTestId("offline-pack-status")).toHaveTextContent("Not downloaded");
  expect(screen.queryByTestId("offline-pack-button-download")).toBeNull();
});

it("R-map-22 proactive degrade: the derived offline signal renders the notice with no press", async () => {
  // Seeded via cache.build + setState with gcTime: Infinity — under the
  // test client's default gcTime: 0 an unobserved query is GC'd one
  // macrotask after construction, before the render settles.
  const client = makeTestQueryClient();
  const query = client
    .getQueryCache()
    .build(client, { queryKey: queryKeys.trip(TEST_TRIP_ID), gcTime: Infinity });
  query.setState({ status: "error", error: new ApiRequestError(0, "NETWORK", "offline") });
  await renderManager(makeActiveTrip(TEST_TRIP_ID), { queryClient: client });
  await settle();
  expect(screen.getByTestId("offline-pack-offline-notice")).toBeOnTheScreen();
});
