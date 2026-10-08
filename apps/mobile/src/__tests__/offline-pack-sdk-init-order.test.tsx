/**
 * Native-SDK init order against the REAL tree (PR #98 round 2 — merge-judge
 * finding, a release-build defect no jest lane could see before this file).
 *
 * The offline-pack controller is mounted by the `[tripId]` layout and fires
 * `offlineManager` calls from the TODAY tab. The Mapbox runtime token and the
 * telemetry opt-out were configured ONLY at module scope of the map route
 * (`app/[tripId]/map/index.tsx`). expo-router evaluates a LEAF route module
 * (layout modules load eagerly) only when its screen first renders
 * (`useScreens.js` `getComponent` -> `loadRoute()`; `BottomTabView.js` renders
 * lazy tabs only once visited; only DEV loads every route up front —
 * `getRoutesCore.js` `validateRouteTreeExports`), so in a RELEASE build the
 * first `createPack` WOULD run with no token (inferred from the sources, never
 * observed on a device: the download would fail -> `failed`; auto-download
 * arms only from `none`, Q2-272 -> the retry pill on every cold start) and
 * hygiene would touch TileStore before the telemetry opt-out. Dev builds and
 * jest-with-a-mocked-SDK both hide it — which is why this suite makes the
 * premise EXPLICIT:
 *
 * the map route module is replaced by a sentinel that records being loaded, so
 * "the map route was never imported" is asserted, not assumed. Both tests then
 * read jest's cross-mock invocation order.
 *
 * Falsification (recorded in the PR body): drop the configure / telemetry
 * calls from the controller's SDK door (`sdk()` in offline-pack-controller.ts)
 * -> the corresponding test goes red.
 */
import { screen, waitFor } from "expo-router/testing-library";

import { queryClient } from "@/data";
import {
  clearPackAnnotationsForTests,
  resetMapboxAccessTokenForTests,
  resetMapboxTelemetryForTests,
  resetOfflinePacksForTests,
} from "@/features/map";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { settleFake } from "@/test-utils/settle";
import { makeActiveTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// Sentinel for the map route: records a load, renders nothing. The Today tab
// never needs it; if anything evaluates it, the premise below is gone. A plain
// counter, NOT a `jest.fn()`: the `beforeEach` `clearAllMocks` would wipe a mock
// while the module registry (and so a load that already happened — at import
// time or in an earlier test) persists. The final test asserts it stayed 0
// through the WHOLE file.
const mockMapRouteLoads = { count: 0 };
jest.mock("@/app/[tripId]/map/index", () => {
  mockMapRouteLoads.count += 1;
  return { __esModule: true, default: () => null };
});

const mapbox = jest.requireMock("@rnmapbox/maps") as {
  __mock: {
    setAccessToken: jest.Mock;
    setTelemetryEnabled: jest.Mock;
    offlineManager: {
      createPack: jest.Mock;
      getPack: jest.Mock;
      getPacks: jest.Mock;
      deletePack: jest.Mock;
    };
  };
};
const om = mapbox.__mock.offlineManager;
const network = (
  jest.requireMock("expo-network") as {
    __mock: { getNetworkStateAsync: jest.Mock; addNetworkStateListener: jest.Mock };
  }
).__mock;

const WIFI = { type: "WIFI", isConnected: true, isInternetReachable: true };
const TOKEN = "pk.test-real-tree-init-order";
const previousToken = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;

/** Global invocation order of a mock's FIRST call (jest's counter spans every mock). */
const firstCall = (fn: jest.Mock): number => Math.min(...fn.mock.invocationCallOrder);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = TOKEN;
  resetMapboxAccessTokenForTests();
  resetMapboxTelemetryForTests();
  resetOfflinePacksForTests();
  clearPackAnnotationsForTests();
  mapbox.__mock.setAccessToken.mockImplementation(async () => TOKEN);
  om.createPack.mockImplementation(async () => undefined);
  om.getPack.mockImplementation(async () => undefined);
  om.getPacks.mockImplementation(async () => []);
  om.deletePack.mockImplementation(async () => undefined);
  network.getNetworkStateAsync.mockImplementation(async () => WIFI);
  network.addNetworkStateListener.mockImplementation(() => ({ remove: jest.fn() }));
  mockNavApi({ trips: [makeActiveTrip(TEST_TRIP_ID)] });
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;
  else process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = previousToken;
  resetMapboxAccessTokenForTests();
  resetMapboxTelemetryForTests();
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

// Falsification: drop `configureMapboxAccessToken()` from the controller's SDK
// door -> the map route (mocked away here) is the only remaining caller, so
// the SDK never gets a token and the download would fail on device -> red.
it("TODAY tab, wifi, map route never loaded: the token reaches the SDK BEFORE the first createPack", async () => {
  await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("today-screen")).toBeOnTheScreen();

  await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
  expect(mockMapRouteLoads.count).toBe(0); // the premise, asserted
  expect(screen.queryByTestId("map-screen")).toBeNull();

  expect(mapbox.__mock.setAccessToken).toHaveBeenCalledTimes(1);
  expect(mapbox.__mock.setAccessToken).toHaveBeenCalledWith(TOKEN);
  expect(firstCall(mapbox.__mock.setAccessToken)).toBeLessThan(firstCall(om.createPack));
});

// Falsification: drop `disableMapboxTelemetry()` from the SDK door -> never
// called -> red; or call a bare `offlineManager.getPacks()` in the orphan
// sweep (bypassing the door) -> the first SDK touch precedes the opt-out -> red.
it("TODAY tab, map route never loaded: the telemetry opt-out precedes the FIRST SDK read (hygiene getPacks / getPack)", async () => {
  await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("today-screen")).toBeOnTheScreen();
  await settleFake();

  await waitFor(() => expect(om.getPacks).toHaveBeenCalled());
  await waitFor(() => expect(om.getPack).toHaveBeenCalled());
  expect(mockMapRouteLoads.count).toBe(0);

  expect(mapbox.__mock.setTelemetryEnabled).toHaveBeenCalledWith(false);
  const optOut = firstCall(mapbox.__mock.setTelemetryEnabled);
  expect(optOut).toBeLessThan(firstCall(om.getPacks));
  expect(optOut).toBeLessThan(firstCall(om.getPack));
});

// PR #98 round-2 verifier Adv 3: the per-test checks above only see loads that
// happen after `beforeEach` (a `jest.fn` sentinel would have been wiped by its
// `clearAllMocks`). This one reads the never-cleared counter after EVERY test
// in the file, so a module-scope load or an earlier test's load is visible.
// Falsification: a module-scope `require("@/app/[tripId]/map/index")` placed
// AFTER the counter is declared -> red (`Expected: 0 / Received: 1`). Note a
// hoisted top-of-file `import` of the route does NOT reach this assertion: the
// hoisted import runs the mock factory before the counter exists, so it fails
// the whole suite by crashing it (`TypeError … reading 'count'`) — also loud,
// just not through this test.
it("the map route module was never loaded anywhere in this file (module-scope loads included)", () => {
  expect(mockMapRouteLoads.count).toBe(0);
});
