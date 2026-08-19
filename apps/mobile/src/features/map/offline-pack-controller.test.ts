/**
 * Pack controller against the mocked SDK seam (T-8.5 / MAP-5 — R-map-18/20/21,
 * map spec §2.5). jest.setup mocks `@rnmapbox/maps` + `expo-network` wholesale;
 * these suites drive downloads by invoking the listeners `createPack` captured
 * (the machine carries the pins — P-8 prep ruling). Load-bearing:
 *  - createPack carries the §2.5 contract (trip-{id} name, style URL, the
 *    shared-grid envelope, z6–15, tripId metadata) with replace semantics;
 *  - the exactly-once latch (R-map-18 "starts download exactly once") holds
 *    under synchronous double-entry — the pill + settings race;
 *  - progress/complete/failed arms drive the store + annotation; late events
 *    after settle are ignored;
 *  - R-map-20 hygiene: ceiling purge (past-only, unknown-safe), delete, the
 *    once-per-session orphan sweep;
 *  - the controller hook's R-map-18 wifi gate: wifi starts, cellular defers
 *    then resumes on the wifi event, planning/annotated trips never start,
 *    the deferred listener is removed on unmount.
 */
import { ThemeProvider } from "@gogo/tokens/react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { createElement } from "react";

import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeActiveTrip, makePlanningTrip } from "@/test-utils/trip-fixtures";

import {
  clearPackAnnotationsForTests,
  readPackAnnotation,
  writePackAnnotation,
} from "./offline-pack-annotation";
import {
  deleteTripPack,
  offlinePackStateFor,
  reconcilePackState,
  resetOfflinePacksForTests,
  runOrphanPackSweep,
  startPackDownload,
  useOfflinePackController,
  type PackDownloadTarget,
} from "./offline-pack-controller";
import { packBoundsFor, packNameFor, packRegionKeyFor } from "./offline-packs";

type MockFn = jest.Mock;
interface OfflineManagerMock {
  createPack: MockFn;
  getPacks: MockFn;
  getPack: MockFn;
  deletePack: MockFn;
  unsubscribe: MockFn;
}
const om = (jest.requireMock("@rnmapbox/maps") as { __mock: { offlineManager: OfflineManagerMock } })
  .__mock.offlineManager;
const network = (
  jest.requireMock("expo-network") as {
    __mock: { getNetworkStateAsync: MockFn; addNetworkStateListener: MockFn };
  }
).__mock;

const KYOTO = { lat: 35.0116, lng: 135.7681 };
const LIGHT_STYLE = "mapbox://styles/mapbox/light-v11";

const target = (tripId = TEST_TRIP_ID): PackDownloadTarget => ({
  tripId,
  destinationLat: KYOTO.lat,
  destinationLng: KYOTO.lng,
  styleUrl: LIGHT_STYLE,
});

/** Full SDK progress-status shape (only percentage/size are load-bearing). */
const status = (percentage: number, completedResourceSize = 0) => ({
  name: packNameFor(TEST_TRIP_ID),
  state: 1,
  percentage,
  completedResourceSize,
  completedTileCount: 0,
  completedResourceCount: 0,
  requiredResourceCount: 0,
  completedTileSize: 0,
});

/** Drain the controller's promise chains (real timers — pure microtasks + one macrotask). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const capturedProgressListener = (call = 0) =>
  om.createPack.mock.calls[call][1] as (pack: unknown, s: ReturnType<typeof status>) => void;
const capturedErrorListener = (call = 0) =>
  om.createPack.mock.calls[call][2] as (
    pack: unknown,
    err: { name: string; message: string },
  ) => void;

beforeEach(() => {
  jest.clearAllMocks();
  resetOfflinePacksForTests();
  clearPackAnnotationsForTests();
  om.createPack.mockImplementation(async () => undefined);
  om.getPacks.mockImplementation(async () => []);
  om.getPack.mockImplementation(async () => undefined);
  om.deletePack.mockImplementation(async () => undefined);
  network.getNetworkStateAsync.mockImplementation(async () => ({
    type: "NONE",
    isConnected: false,
    isInternetReachable: false,
  }));
  network.addNetworkStateListener.mockImplementation(() => ({ remove: jest.fn() }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("startPackDownload — §2.5 createPack contract", () => {
  it("registers trip-{id} with the style URL, shared-grid envelope, z6–15, and tripId metadata; replaces any previous pack first", async () => {
    expect(startPackDownload(target())).toBe(true);
    await flush();

    expect(om.createPack).toHaveBeenCalledTimes(1);
    expect(om.createPack.mock.calls[0][0]).toEqual({
      name: packNameFor(TEST_TRIP_ID),
      styleURL: LIGHT_STYLE,
      bounds: packBoundsFor(KYOTO.lat, KYOTO.lng),
      minZoom: 6,
      maxZoom: 15,
      metadata: { tripId: TEST_TRIP_ID },
    });
    // Replace semantics: the old pack is deleted BEFORE createPack re-registers.
    expect(om.deletePack).toHaveBeenCalledWith(packNameFor(TEST_TRIP_ID));
    expect(om.deletePack.mock.invocationCallOrder[0]).toBeLessThan(
      om.createPack.mock.invocationCallOrder[0],
    );
  });

  it("exactly-once: a synchronous double-entry (pill + settings race) starts ONE download", async () => {
    expect(startPackDownload(target())).toBe(true);
    expect(startPackDownload(target())).toBe(false);
    await flush();
    expect(om.createPack).toHaveBeenCalledTimes(1);
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({ phase: "downloading", progress: 0 });
  });

  it("progress events drive the store; completion writes the annotation + ready state and unsubscribes", async () => {
    startPackDownload(target());
    await flush();

    capturedProgressListener()(null, status(41.7));
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({ phase: "downloading", progress: 42 });

    capturedProgressListener()(null, status(100, 5_000_000));
    const state = offlinePackStateFor(TEST_TRIP_ID);
    expect(state).toMatchObject({ phase: "ready", sizeBytes: 5_000_000 });

    const annotation = readPackAnnotation(TEST_TRIP_ID);
    expect(annotation).toMatchObject({
      tripId: TEST_TRIP_ID,
      styleUrl: LIGHT_STYLE,
      regionKey: packRegionKeyFor(KYOTO.lat, KYOTO.lng),
      sizeBytes: 5_000_000,
    });
    expect(om.unsubscribe).toHaveBeenCalledWith(packNameFor(TEST_TRIP_ID));

    // Late event after settle is IGNORED — ready never regresses.
    capturedProgressListener()(null, status(50));
    expect(offlinePackStateFor(TEST_TRIP_ID).phase).toBe("ready");
  });

  it("failure marks failed(message) and releases the latch — retry starts a fresh download (R-map-21)", async () => {
    startPackDownload(target());
    await flush();
    capturedErrorListener()(null, { name: "err", message: "tile fetch failed" });
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({
      phase: "failed",
      message: "tile fetch failed",
    });

    expect(startPackDownload(target())).toBe(true);
    await flush();
    expect(om.createPack).toHaveBeenCalledTimes(2);
  });

  it("a createPack rejection (tokenless device today) lands in failed, never a hang", async () => {
    om.createPack.mockImplementation(async () => {
      throw new Error("no access token");
    });
    startPackDownload(target());
    await flush();
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({
      phase: "failed",
      message: "no access token",
    });
  });
});

describe("ceiling purge — R-map-20", () => {
  it("purges past-trip packs (oldest-first) before the new download; unknown trips untouched", async () => {
    const filler = Array.from({ length: 699 }, (_, i) => ({ name: `trip-f${i}` }));
    om.getPacks.mockImplementation(async () => [
      ...filler,
      { name: "trip-old" },
      { name: "trip-new" },
    ]);
    writePackAnnotation({
      tripId: "old",
      styleUrl: LIGHT_STYLE,
      regionKey: "r:70:271",
      completedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 1,
    });
    writePackAnnotation({
      tripId: "new",
      styleUrl: LIGHT_STYLE,
      regionKey: "r:70:271",
      completedAt: "2026-06-01T00:00:00.000Z",
      sizeBytes: 1,
    });

    startPackDownload(target(), {
      tripStatusFor: (id) => (id === "old" || id === "new" ? "past" : undefined),
    });
    await flush();

    // 701 existing + 1 incoming − threshold 700 = 2 to purge — exactly the
    // two PAST packs; the 699 unknown-status packs are never eligible.
    const deleted = om.deletePack.mock.calls.map(([name]) => name as string);
    expect(deleted).toContain("trip-old");
    expect(deleted).toContain("trip-new");
    expect(deleted.filter((name) => name.startsWith("trip-f"))).toHaveLength(0);
    expect(readPackAnnotation("old")).toBeUndefined();
    expect(readPackAnnotation("new")).toBeUndefined();
    expect(om.createPack).toHaveBeenCalledTimes(1);
  });
});

describe("deleteTripPack + reconcile — SDK is the source of truth", () => {
  it("delete removes pack + annotation and settles to none", async () => {
    writePackAnnotation({
      tripId: TEST_TRIP_ID,
      styleUrl: LIGHT_STYLE,
      regionKey: packRegionKeyFor(KYOTO.lat, KYOTO.lng),
      completedAt: "2026-08-18T00:00:00.000Z",
      sizeBytes: 9,
    });
    await deleteTripPack(TEST_TRIP_ID);
    expect(om.deletePack).toHaveBeenCalledWith(packNameFor(TEST_TRIP_ID));
    expect(readPackAnnotation(TEST_TRIP_ID)).toBeUndefined();
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({ phase: "none" });
  });

  it("an annotation whose SDK pack vanished is cleared — state falls to none", async () => {
    const fingerprint = {
      styleUrl: LIGHT_STYLE,
      regionKey: packRegionKeyFor(KYOTO.lat, KYOTO.lng),
    };
    writePackAnnotation({
      tripId: TEST_TRIP_ID,
      ...fingerprint,
      completedAt: "2026-08-18T00:00:00.000Z",
      sizeBytes: 9,
    });
    await reconcilePackState(TEST_TRIP_ID, fingerprint);
    expect(readPackAnnotation(TEST_TRIP_ID)).toBeUndefined();
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({ phase: "none" });
  });

  it("an unannotated pack for this trip is removed (unaccounted on this install)", async () => {
    om.getPack.mockImplementation(async () => ({ name: packNameFor(TEST_TRIP_ID) }));
    await reconcilePackState(TEST_TRIP_ID, { styleUrl: LIGHT_STYLE, regionKey: "r:70:271" });
    expect(om.deletePack).toHaveBeenCalledWith(packNameFor(TEST_TRIP_ID));
  });
});

describe("orphan sweep — §2.5, once per session", () => {
  it("removes unannotated trip-* packs only; foreign packs untouched; latched per session", async () => {
    om.getPacks.mockImplementation(async () => [
      { name: "trip-orphan" },
      { name: "trip-kept" },
      { name: "style-cache" },
    ]);
    writePackAnnotation({
      tripId: "kept",
      styleUrl: LIGHT_STYLE,
      regionKey: "r:70:271",
      completedAt: "2026-08-18T00:00:00.000Z",
      sizeBytes: 1,
    });

    await runOrphanPackSweep();
    expect(om.deletePack.mock.calls.map(([name]) => name)).toEqual(["trip-orphan"]);

    await runOrphanPackSweep();
    expect(om.getPacks).toHaveBeenCalledTimes(1); // session latch
  });
});

describe("useOfflinePackController — R-map-18 activation trigger", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ThemeProvider, { defaultAppearancePref: "light" }, children);
  const activeTrip = () => makeActiveTrip(TEST_TRIP_ID);

  const wifi = { type: "WIFI", isConnected: true, isInternetReachable: true };
  const cellular = { type: "CELLULAR", isConnected: true, isInternetReachable: true };

  it("active trip on wifi auto-starts exactly once — even with the pill AND settings mounted", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const first = await renderHook(() => useOfflinePackController(activeTrip()), { wrapper });
    const second = await renderHook(() => useOfflinePackController(activeTrip()), { wrapper });

    await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
    await act(flush);
    expect(om.createPack).toHaveBeenCalledTimes(1);
    await first.unmount();
    await second.unmount();
  });

  it("cellular DEFERS, then resumes on the wifi network event (R-map-18)", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => cellular);
    const { unmount } = await renderHook(() => useOfflinePackController(activeTrip()), {
      wrapper,
    });
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    await waitFor(() => expect(network.addNetworkStateListener).toHaveBeenCalledTimes(1));

    const listener = network.addNetworkStateListener.mock.calls[0][0] as (
      event: typeof wifi,
    ) => void;
    // A non-wifi change keeps deferring.
    await act(async () => listener(cellular));
    expect(om.createPack).not.toHaveBeenCalled();
    await act(async () => listener(wifi));
    await act(flush);
    expect(om.createPack).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("planning trips never auto-download (activation = effective status active)", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const { unmount } = await renderHook(
      () => useOfflinePackController(makePlanningTrip(TEST_TRIP_ID)),
      { wrapper },
    );
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    await unmount();
  });

  it("an annotated (ready) trip renders ready on the FIRST frame and never re-downloads", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    // Coherent device state: the SDK holds the pack the annotation records
    // (reconcile clears an annotation whose pack vanished — its own pin).
    om.getPack.mockImplementation(async () => ({ name: packNameFor(TEST_TRIP_ID) }));
    writePackAnnotation({
      tripId: TEST_TRIP_ID,
      styleUrl: LIGHT_STYLE,
      regionKey: packRegionKeyFor(KYOTO.lat, KYOTO.lng),
      completedAt: "2026-08-18T00:00:00.000Z",
      sizeBytes: 7_000_000,
    });
    const { result, unmount } = await renderHook(
      () => useOfflinePackController(activeTrip()),
      { wrapper },
    );
    expect(result.current).toEqual({
      phase: "ready",
      sizeBytes: 7_000_000,
      completedAt: "2026-08-18T00:00:00.000Z",
    });
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    await unmount();
  });

  it("the deferred wifi listener is removed on unmount — no leak", async () => {
    const remove = jest.fn();
    network.getNetworkStateAsync.mockImplementation(async () => cellular);
    network.addNetworkStateListener.mockImplementation(() => ({ remove }));
    const { unmount } = await renderHook(() => useOfflinePackController(activeTrip()), {
      wrapper,
    });
    await waitFor(() => expect(network.addNetworkStateListener).toHaveBeenCalledTimes(1));
    await unmount();
    expect(remove).toHaveBeenCalled();
  });
});
