/**
 * Offline map management flows at component grain (T-8.5 / MAP-5 —
 * R-map-19/20/21/22, map spec §2.5). The house split (trip-settings-form
 * precedent): renderRouter files carry ONE interactive flow each (harness
 * quirk 3), so the press-heavy management walkthroughs live here with
 * expo-router stubbed and the REAL settings screen + sheet + manager
 * composition rendered; the real-tree delete-trip hygiene walkthrough is
 * `trip-settings-offline-hygiene.test.tsx`. Load-bearing:
 *
 * - the settings row mirrors pack state and opens the management sheet
 *   (R-map-19's entry, `trip-settings-list-item-offline` →
 *   `trip-settings-sheet-offline`);
 * - download entry arms (R-map-19 + R-map-22): NO connection → degrade
 *   notice and NOTHING registered (pinned on the handler's effect —
 *   createPack never invoked — per the ungated-CONTROL rule); CELLULAR →
 *   the size-estimate ConfirmDialog fronts the download, cancel registers
 *   nothing (R-ds-18), confirm starts it and progress surfaces;
 * - lifecycle (R-map-19/20/21): ready (real MMKV annotation + SDK pack)
 *   → refresh on wifi starts immediately (no dialog) with REPLACE
 *   semantics → completion (captured SDK listener) lands back in ready →
 *   delete Confirm cancel keeps the pack → confirm removes pack +
 *   annotation and the surface falls back to `Not downloaded`.
 */
import type { TripListItem } from "@gogo/shared";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import TripSettingsScreen from "@/app/[tripId]/more/settings";
import { queryKeys } from "@/data";
import {
  clearPackAnnotationsForTests,
  packNameFor,
  packRegionKeyFor,
  readPackAnnotation,
  resetOfflinePacksForTests,
  writePackAnnotation,
} from "@/features/map";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeActiveTrip } from "@/test-utils/trip-fixtures";

jest.mock("expo-router", () => ({
  __esModule: true,
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));
jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// Synchronous TanStack notify (trip-settings-form convention): batches firing
// inside a waitFor sleep window land un-acted under CI contention (B-2).
beforeAll(() => {
  notifyManager.setScheduler((cb) => cb());
});
afterAll(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

interface OfflineManagerMock {
  createPack: jest.Mock;
  deletePack: jest.Mock;
  getPack: jest.Mock;
  getPacks: jest.Mock;
}
const om = (jest.requireMock("@rnmapbox/maps") as { __mock: { offlineManager: OfflineManagerMock } })
  .__mock.offlineManager;
const network = (
  jest.requireMock("expo-network") as { __mock: { getNetworkStateAsync: jest.Mock } }
).__mock;

const NO_CONNECTION = { type: "NONE", isConnected: false, isInternetReachable: false };
const CELLULAR = { type: "CELLULAR", isConnected: true, isInternetReachable: true };
const WIFI = { type: "WIFI", isConnected: true, isInternetReachable: true };
const LIGHT_STYLE = "mapbox://styles/mapbox/light-v11";

function seededClient(trip: TripListItem): QueryClient {
  const client = makeTestQueryClient();
  client.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryData(queryKeys.trip(TEST_TRIP_ID), trip);
  return client;
}

async function renderSettings(trip: TripListItem) {
  seedAuthenticated();
  return renderWithProviders(
    <TripProvider trip={trip}>
      <TripSettingsScreen />
    </TripProvider>,
    { queryClient: seededClient(trip) },
  );
}

/** Drain the controller's promise chains inside act (real timers here). */
async function drain(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOfflinePacksForTests();
  clearPackAnnotationsForTests();
  om.createPack.mockImplementation(async () => undefined);
  om.deletePack.mockImplementation(async () => undefined);
  om.getPack.mockImplementation(async () => undefined);
  om.getPacks.mockImplementation(async () => []);
  network.getNetworkStateAsync.mockImplementation(async () => NO_CONNECTION);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it("R-map-19/22: row → sheet → offline degrade → cellular ConfirmDialog → confirm starts the download", async () => {
  await renderSettings(makeActiveTrip(TEST_TRIP_ID));
  await drain();

  // The row mirrors pack state (R-map-19's management entry).
  expect(screen.getByText("Not downloaded")).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId("trip-settings-list-item-offline"));
  expect(screen.getByTestId("offline-pack-status")).toHaveTextContent("Not downloaded");
  // §2.5: the estimate shows BEFORE download, labeled as an approximation.
  expect(screen.getByText(/Estimated download: ~/)).toBeOnTheScreen();

  // Arm 1 — no connection: degrade notice, nothing registered (R-map-22).
  await fireEvent.press(screen.getByTestId("offline-pack-button-download"));
  await drain();
  expect(screen.getByTestId("offline-pack-offline-notice")).toBeOnTheScreen();
  expect(om.createPack).not.toHaveBeenCalled();

  // Arm 2 — cellular: the size-estimate ConfirmDialog fronts the download
  // (R-map-19); cancelling registers nothing (R-ds-18).
  network.getNetworkStateAsync.mockImplementation(async () => CELLULAR);
  await fireEvent.press(screen.getByTestId("offline-pack-button-download"));
  await drain();
  expect(screen.getByText(/over your cellular connection/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId("offline-pack-button-download-cancel"));
  await drain();
  expect(om.createPack).not.toHaveBeenCalled();

  // Arm 3 — cellular + confirm: download starts; progress surfaces in the
  // status line (the R-map-19 `downloading (progress)` state).
  await fireEvent.press(screen.getByTestId("offline-pack-button-download"));
  await drain();
  await fireEvent.press(screen.getByTestId("offline-pack-button-download-confirm"));
  await drain();
  expect(om.createPack).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("offline-pack-status")).toHaveTextContent("Saving… 0%");
});

it("lifecycle: ready → refresh (wifi, replaces) → complete → delete Confirm → none", async () => {
  writePackAnnotation({
    tripId: TEST_TRIP_ID,
    styleUrl: LIGHT_STYLE,
    regionKey: packRegionKeyFor(35.0116, 135.7681),
    completedAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 12_000_000,
  });
  // Coherent device state: the SDK holds the pack the annotation records
  // (the controller's reconcile clears annotation-without-pack — own pin).
  om.getPack.mockImplementation(async () => ({ name: packNameFor(TEST_TRIP_ID) }));
  await renderSettings(makeActiveTrip(TEST_TRIP_ID));
  await drain();

  // Ready renders from the REAL annotation: size + date in the row summary.
  expect(screen.getByText(/Ready — 12 MB · saved/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId("trip-settings-list-item-offline"));

  // Refresh on WIFI starts immediately — no ConfirmDialog (R-map-19's
  // dialog fronts CELLULAR only) — and REPLACES under the same id (§2.5
  // trigger 3: delete first, then createPack re-registers trip-{id}).
  network.getNetworkStateAsync.mockImplementation(async () => WIFI);
  await fireEvent.press(screen.getByTestId("offline-pack-button-refresh"));
  await drain();
  expect(screen.queryByTestId("offline-pack-button-refresh-confirm")).toBeNull();
  expect(om.createPack).toHaveBeenCalledTimes(1);
  expect(om.deletePack).toHaveBeenCalledWith(packNameFor(TEST_TRIP_ID));
  expect(screen.getByTestId("offline-pack-status")).toHaveTextContent("Saving… 0%");

  // Completion through the captured SDK listener — ready again, new size.
  const progress = om.createPack.mock.calls[0][1] as (
    pack: unknown,
    status: Record<string, number | string>,
  ) => void;
  await act(async () => {
    progress(null, {
      name: packNameFor(TEST_TRIP_ID),
      state: 1,
      percentage: 100,
      completedResourceSize: 9_000_000,
      completedTileCount: 0,
      completedResourceCount: 0,
      requiredResourceCount: 0,
      completedTileSize: 0,
    });
  });
  expect(screen.getByTestId("offline-pack-status")).toHaveTextContent(/Ready — 9 MB/);

  // Delete fronts the destructive Confirm; CANCEL keeps the pack (R-ds-18).
  om.deletePack.mockClear();
  await fireEvent.press(screen.getByTestId("offline-pack-button-delete"));
  await fireEvent.press(screen.getByTestId("offline-pack-button-delete-cancel"));
  await drain();
  expect(om.deletePack).not.toHaveBeenCalled();
  expect(readPackAnnotation(TEST_TRIP_ID)).toBeDefined();

  // Confirm removes pack + annotation; the surface falls back to none.
  await fireEvent.press(screen.getByTestId("offline-pack-button-delete"));
  await fireEvent.press(screen.getByTestId("offline-pack-button-delete-confirm"));
  await waitFor(() => expect(om.deletePack).toHaveBeenCalledWith(packNameFor(TEST_TRIP_ID)));
  await drain();
  expect(readPackAnnotation(TEST_TRIP_ID)).toBeUndefined();
  expect(screen.getByTestId("offline-pack-status")).toHaveTextContent("Not downloaded");
});
