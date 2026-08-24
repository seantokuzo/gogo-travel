/**
 * Filled offline pill slot (T-8.5 — the T-8.2 frozen seam b; R-map-18/21/22).
 * Load-bearing:
 *  - hidden online with a settled pack (the pill never nags);
 *  - downloading renders progress (R-map-18's "surfacing progress");
 *  - failed renders the retry pill and the tap starts a REAL download
 *    (through `startPackDownload` — createPack observable, no bespoke
 *    callback to fake);
 *  - offline (the DERIVED `useTripOffline` signal — a transport-failed query
 *    in the trip subtree, exactly what production produces) composes with
 *    pack state (R-map-22): saved map vs limited map;
 *  - the pill renders no blocking surface in any state (R-map-21: a View /
 *    one Pressable — never a modal, never a spinner overlay).
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { ApiRequestError } from "@/auth";
import { queryKeys } from "@/data";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { makeActiveTrip } from "@/test-utils/trip-fixtures";

import { MapOfflinePillSlot } from "./MapOfflinePillSlot";
import {
  clearPackAnnotationsForTests,
  writePackAnnotation,
} from "./offline-pack-annotation";
import {
  resetOfflinePacksForTests,
  useOfflinePackStore,
} from "./offline-pack-controller";
import { packNameFor, packRegionKeyFor } from "./offline-packs";

interface OfflineManagerMock {
  createPack: jest.Mock;
  getPack: jest.Mock;
}
const om = (jest.requireMock("@rnmapbox/maps") as { __mock: { offlineManager: OfflineManagerMock } })
  .__mock.offlineManager;

const trip = () => makeActiveTrip(TEST_TRIP_ID);
const LIGHT_STYLE = "mapbox://styles/mapbox/light-v11";

/**
 * Ready device state = annotation AND the SDK pack it records (coherent —
 * the controller's reconcile clears an annotation whose pack vanished).
 */
const seedReadyPack = () => {
  writePackAnnotation({
    tripId: TEST_TRIP_ID,
    styleUrl: LIGHT_STYLE,
    regionKey: packRegionKeyFor(trip().destination_lat, trip().destination_lng),
    completedAt: "2026-08-18T00:00:00.000Z",
    sizeBytes: 7_000_000,
  });
  om.getPack.mockImplementation(async () => ({ name: packNameFor(TEST_TRIP_ID) }));
};

/**
 * An OFFLINE query cache: a transport failure (`status 0` — api-client's
 * marker) parked under the trip's detail subtree, exactly the state
 * `useTripOffline` derives from in production (data/offline.ts). Seeded via
 * `cache.build` + `setState` with `gcTime: Infinity` — under the test
 * client's default `gcTime: 0` an unobserved query is GC'd one macrotask
 * after construction, before the render settles.
 */
function offlineClient() {
  const client = makeTestQueryClient();
  const query = client
    .getQueryCache()
    .build(client, { queryKey: queryKeys.trip(TEST_TRIP_ID), gcTime: Infinity });
  query.setState({ status: "error", error: new ApiRequestError(0, "NETWORK", "offline") });
  return client;
}

function renderPill(opts?: { queryClient?: ReturnType<typeof makeTestQueryClient> }) {
  return renderWithProviders(
    <TripProvider trip={trip()}>
      <MapOfflinePillSlot tripId={TEST_TRIP_ID} />
    </TripProvider>,
    opts,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOfflinePacksForTests();
  clearPackAnnotationsForTests();
  om.createPack.mockImplementation(async () => undefined);
  om.getPack.mockImplementation(async () => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it("hidden online — no pack, nothing to say (and nothing blocking the map)", async () => {
  await renderPill();
  await settle();
  expect(screen.queryByTestId("map-pill-offline")).toBeNull();
});

it("hidden online with a READY pack — the pill never nags (R-map-21 spirit)", async () => {
  seedReadyPack();
  await renderPill();
  await settle();
  expect(screen.queryByTestId("map-pill-offline")).toBeNull();
});

it("surfaces download progress (R-map-18)", async () => {
  useOfflinePackStore.setState({
    packs: { [TEST_TRIP_ID]: { phase: "downloading", progress: 37 } },
  });
  await renderPill();
  await settle();
  expect(screen.getByTestId("map-pill-offline")).toBeOnTheScreen();
  expect(screen.getByText("Saving map… 37%")).toBeOnTheScreen();
});

it("failed → retry pill; the tap starts a real download (R-map-21)", async () => {
  useOfflinePackStore.setState({
    packs: { [TEST_TRIP_ID]: { phase: "failed", message: "tile fetch failed" } },
  });
  await renderPill();
  await settle();
  expect(screen.getByText("Map save failed — tap to retry")).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("map-pill-offline"));
  await settle();
  expect(om.createPack).toHaveBeenCalledTimes(1);
  expect(om.createPack.mock.calls[0][0]).toMatchObject({
    name: packNameFor(TEST_TRIP_ID),
    styleURL: LIGHT_STYLE,
  });
});

it("offline with a saved map: 'using saved map' (R-map-22)", async () => {
  seedReadyPack();
  const client = offlineClient();
  await renderPill({ queryClient: client });
  await settle();
  expect(screen.getByText("Offline — using saved map")).toBeOnTheScreen();
});

it("offline without a pack: 'map may be limited' (R-map-22 degrade, no dead spinner)", async () => {
  const client = offlineClient();
  await renderPill({ queryClient: client });
  await settle();
  expect(screen.getByText("Offline — map may be limited")).toBeOnTheScreen();
});

it("UNUSABLE destination coords (the screen's world degrade arm): machine stands down, no crash, no SDK touch", async () => {
  // The map screen's R-map-1 world-view fallback renders with NaN coords —
  // the region grid throws on them, so the pill must never fingerprint.
  // Caught live: the map-screen degrade CONTROL crashed on an unguarded
  // packRegionKeyFor before this guard existed.
  const degraded = { ...trip(), destination_lat: Number.NaN, destination_lng: Number.NaN };
  await renderWithProviders(
    <TripProvider trip={degraded}>
      <MapOfflinePillSlot tripId={TEST_TRIP_ID} />
    </TripProvider>,
  );
  await settle();
  expect(screen.queryByTestId("map-pill-offline")).toBeNull();
  expect(om.createPack).not.toHaveBeenCalled();
});
