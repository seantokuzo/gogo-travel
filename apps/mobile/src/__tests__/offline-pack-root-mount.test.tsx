/**
 * R-map-18 activation trigger at the TRIP ROOT, against the REAL tree
 * (Q2-186 ruling, 2026-10-06 — map spec §2.5 / R-map-18). The offline-pack
 * controller is mounted once by the `[tripId]` layout's `TripShell`, so a trip
 * that turns `active` downloads (wifi-gated) wherever the user is inside it —
 * not "on the next map/settings visit". The pill and the settings row only
 * READ the controller's store (`useOfflinePackState`). Named per cell:
 *
 *   happy        active trip on the Today tab, on wifi → ONE download, with
 *                neither the map nor the settings surface ever mounted;
 *                a planning trip flipping `active` while the user SITS on
 *                Today fires the controller live (the literal Q2-186 gap)
 *   empty        planning / past trip → nothing starts, no network read
 *   offline      no connection → stand-down (no download, no crash, ONE
 *                deferred listener); a non-wifi event keeps deferring; wifi
 *                finally starts exactly one download
 *   adversarial  double-mount guard: settings (row mounted) + map (pill
 *                mounted) live in ONE tree → still ONE controller instance,
 *                ONE network read, ONE createPack (walkthrough, LAST — harness
 *                quirk 3)
 *
 * Falsification (what makes each red) is stated per test and recorded in the
 * PR body. Pure-URL renders first; the single pressing walkthrough is last.
 */
import type { TripListItem } from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";

import { queryClient, queryKeys } from "@/data";
import {
  clearPackAnnotationsForTests,
  liveOfflinePackControllers,
  packNameFor,
  resetOfflinePacksForTests,
} from "@/features/map";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { rememberTab, resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { settleFake } from "@/test-utils/settle";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
  mockNavApi,
} from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

interface OfflineManagerMock {
  createPack: jest.Mock;
  getPack: jest.Mock;
  getPacks: jest.Mock;
  deletePack: jest.Mock;
}
const om = (
  jest.requireMock("@rnmapbox/maps") as { __mock: { offlineManager: OfflineManagerMock } }
).__mock.offlineManager;
const network = (
  jest.requireMock("expo-network") as {
    __mock: { getNetworkStateAsync: jest.Mock; addNetworkStateListener: jest.Mock };
  }
).__mock;

const WIFI = { type: "WIFI", isConnected: true, isInternetReachable: true };
const CELLULAR = { type: "CELLULAR", isConnected: true, isInternetReachable: true };
const NO_CONNECTION = { type: "NONE", isConnected: false, isInternetReachable: false };

function mockTrips(trips: TripListItem[]) {
  mockNavApi({ trips });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOfflinePacksForTests();
  clearPackAnnotationsForTests();
  om.createPack.mockImplementation(async () => undefined);
  om.getPack.mockImplementation(async () => undefined);
  om.getPacks.mockImplementation(async () => []);
  om.deletePack.mockImplementation(async () => undefined);
  network.getNetworkStateAsync.mockImplementation(async () => WIFI);
  network.addNetworkStateListener.mockImplementation(() => ({ remove: jest.fn() }));
});

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

// Falsification: revert the `<OfflinePackController />` mount in
// `app/[tripId]/_layout.tsx` (the pre-ruling shape — controller only on the
// map pill / settings row) and NOTHING mounts it on the Today tab -> createPack
// never fires -> red.
it("HAPPY: an ACTIVE trip on the Today tab, on wifi, downloads at the trip root — map and settings never visited", async () => {
  mockTrips([makeActiveTrip(TEST_TRIP_ID)]);
  const result = await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("today-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/today`);

  await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
  expect(om.createPack.mock.calls[0][0]).toMatchObject({
    name: packNameFor(TEST_TRIP_ID),
    styleURL: "mapbox://styles/mapbox/light-v11",
  });
  // Neither pack surface exists in this tree — the controller is the root's.
  expect(screen.queryByTestId("map-screen")).toBeNull();
  expect(screen.queryByTestId("trip-settings-screen")).toBeNull();
  expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);
});

// The literal Q2-186 gap: the trip turns `active` AFTER the user is already
// sitting on Today, before either pack surface mounted. Falsification: same
// revert as above — the status flip reaches no controller -> red.
it("HAPPY: a PLANNING trip flipping `active` while the user sits on Today fires the controller live", async () => {
  mockTrips([makePlanningTrip(TEST_TRIP_ID)]);
  rememberTab(TEST_TRIP_ID, "today"); // a planning trip would default to itinerary
  await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("today-screen")).toBeOnTheScreen();

  // Planning: nothing starts, and the status gate precedes the network read
  // (drained first — an absence read before the effect ran would be vacuous).
  await settleFake();
  expect(om.createPack).not.toHaveBeenCalled();
  expect(network.getNetworkStateAsync).not.toHaveBeenCalled();

  // The effective status flips (server refetch / owner override): the shell
  // re-renders with the new trip row — no tab change, no surface visit.
  await act(async () => {
    queryClient.setQueryData<TripListItem>(queryKeys.trip(TEST_TRIP_ID), (trip) =>
      trip === undefined ? trip : { ...trip, status: "active" },
    );
  });
  await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId("today-screen")).toBeOnTheScreen();
  expect(screen.queryByTestId("map-screen")).toBeNull();
  expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);
});

// Falsification: drop the `shouldAutoDownloadPack` status gate in the
// controller effect (arm on any status) -> the planning/past trip reads the
// network and starts -> red.
it.each([
  ["planning", () => makePlanningTrip(TEST_TRIP_ID)],
  ["past", () => makePastTrip(TEST_TRIP_ID)],
])(
  "EMPTY: a %s trip never starts a download at the root (and reads no network)",
  async (_, make) => {
    mockTrips([make()]);
    await renderApp(`/${TEST_TRIP_ID}`);
    expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
    // Let the controller's effect chain drain before asserting absence
    // (renderRouter runs FAKE timers — `settleFake` is the sanctioned drain).
    await settleFake();

    expect(om.createPack).not.toHaveBeenCalled();
    expect(network.getNetworkStateAsync).not.toHaveBeenCalled();
    expect(network.addNetworkStateListener).not.toHaveBeenCalled();
    // The controller IS mounted (one per scope) — it just has nothing to do.
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);
  },
);

// Falsification: start on `isConnected` instead of the wifi gate -> the
// cellular event starts a download -> red; drop the deferral listener ->
// `addNetworkStateListener` never fires -> red.
it("OFFLINE: no connection stands down at the root — no download, no crash, ONE deferred listener; cellular keeps deferring; wifi starts ONE", async () => {
  network.getNetworkStateAsync.mockImplementation(async () => NO_CONNECTION);
  mockTrips([makeActiveTrip(TEST_TRIP_ID)]);
  await renderApp(`/${TEST_TRIP_ID}`);
  // The shell rendered (no crash) and the controller armed its deferral.
  expect(await screen.findByTestId("today-screen")).toBeOnTheScreen();
  await waitFor(() => expect(network.addNetworkStateListener).toHaveBeenCalledTimes(1));
  expect(om.createPack).not.toHaveBeenCalled();
  expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);

  const listener = network.addNetworkStateListener.mock.calls[0][0] as (event: {
    type: string;
    isConnected: boolean;
    isInternetReachable: boolean;
  }) => void;
  await act(async () => listener(NO_CONNECTION)); // still offline
  await act(async () => listener(CELLULAR)); // connected, not unmetered wifi
  expect(om.createPack).not.toHaveBeenCalled();

  await act(async () => listener(WIFI)); // the next wifi window
  await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
  expect(network.addNetworkStateListener).toHaveBeenCalledTimes(1);
});

// ADVERSARIAL double-mount guard — the single interactive walkthrough, LAST
// (harness quirk 3). Both pack surfaces end up live in ONE tree: the settings
// stack (row mounted) stays mounted underneath while the tab bar switches to
// the map tab (pill mounted). Falsification: re-add `useOfflinePackController`
// (the effect-bearing hook) to the pill, the settings row or the sheet body,
// or a second `<OfflinePackController />` anywhere in the trip scope ->
// `liveOfflinePackControllers` reads 2 and `getNetworkStateAsync` is called
// twice -> red.
it("ADVERSARIAL: settings row + map pill live in ONE tree — still exactly ONE controller, ONE network read, ONE download", async () => {
  mockTrips([makeActiveTrip(TEST_TRIP_ID)]);
  await renderApp(`/${TEST_TRIP_ID}/more/settings`);
  expect(await screen.findByTestId("trip-settings-screen")).toBeOnTheScreen();
  // Surface 1 (settings row) is mounted; the root controller already started.
  await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
  expect(await screen.findByTestId("trip-settings-list-item-offline")).toBeOnTheScreen();

  // Surface 2 (map pill) mounts through the real tab bar — the settings stack
  // stays alive underneath.
  await fireEvent.press(screen.getByTestId("tab-bar-map"));
  expect(await screen.findByTestId("map-screen")).toBeOnTheScreen();
  const pill = await screen.findByTestId("map-pill-offline");
  expect(pill).toHaveTextContent("Saving map… 0%"); // the pill READS the root's download

  expect(
    screen.getByTestId("trip-settings-list-item-offline", { includeHiddenElements: true }),
  ).toBeTruthy();
  expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);
  expect(network.getNetworkStateAsync).toHaveBeenCalledTimes(1);
  expect(om.createPack).toHaveBeenCalledTimes(1);
});
