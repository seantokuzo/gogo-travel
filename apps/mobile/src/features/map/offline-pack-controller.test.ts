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
 *    the deferred listener is removed on unmount;
 *  - Q2-186 single-controller scope: ONE `useOfflinePackController` per trip
 *    (surfaces read `useOfflinePackState`, effect-free), `liveOfflinePackControllers`
 *    pins the count, two racing instances still start ONE download, and a
 *    trip switch mid-download neither cancels nor cross-talks.
 */
import { ThemeProvider } from "@gogo/tokens/react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { createElement } from "react";

import { TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { makeActiveTrip, makePlanningTrip } from "@/test-utils/trip-fixtures";

import {
  clearPackAnnotationsForTests,
  readPackAnnotation,
  writePackAnnotation,
} from "./offline-pack-annotation";
import {
  deleteTripPack,
  liveOfflinePackControllers,
  offlinePackStateFor,
  reconcilePackState,
  resetOfflinePacksForTests,
  runOrphanPackSweep,
  startPackDownload,
  useOfflinePackController,
  useOfflinePackState,
  useOfflinePackStore,
  type OfflinePackTrip,
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
const om = (
  jest.requireMock("@rnmapbox/maps") as { __mock: { offlineManager: OfflineManagerMock } }
).__mock.offlineManager;
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

  /**
   * Both failure arms seed a PRIOR completed download (the REFRESH scenario)
   * and pin the annotation lifecycle (round 1): the replace-time delete drops
   * the old annotation, and a failure must leave NO record — a surviving
   * "ready" annotation would seed a lying row for a pack the SDK no longer
   * holds on next launch AND suppress the R-map-18 re-attempt. Also kills the
   * eager-annotation mutant (annotation written at start survived all pins).
   */
  const seedPriorDownload = () =>
    writePackAnnotation({
      tripId: TEST_TRIP_ID,
      styleUrl: LIGHT_STYLE,
      regionKey: packRegionKeyFor(KYOTO.lat, KYOTO.lng),
      completedAt: "2026-08-01T00:00:00.000Z",
      sizeBytes: 5_000_000,
    });

  it("failure marks failed(message), leaves NO annotation, and releases the latch — retry starts a fresh download (R-map-21)", async () => {
    seedPriorDownload();
    startPackDownload(target());
    await flush();
    capturedErrorListener()(null, { name: "err", message: "tile fetch failed" });
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({
      phase: "failed",
      message: "tile fetch failed",
    });
    expect(readPackAnnotation(TEST_TRIP_ID)).toBeUndefined();

    expect(startPackDownload(target())).toBe(true);
    await flush();
    expect(om.createPack).toHaveBeenCalledTimes(2);
  });

  it("a createPack rejection (tokenless device today) lands in failed with NO stale annotation, never a hang", async () => {
    seedPriorDownload();
    om.createPack.mockImplementation(async () => {
      throw new Error("no access token");
    });
    startPackDownload(target());
    await flush();
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({
      phase: "failed",
      message: "no access token",
    });
    expect(readPackAnnotation(TEST_TRIP_ID)).toBeUndefined();
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

  it("a REFRESH at exactly the threshold purges NOTHING — the trip's own pack never double-counts (replace nets zero)", async () => {
    // 700 packs on device INCLUDING this trip's own — the refresh replaces
    // it, so the count stays at the threshold and no past trip loses its
    // saved map (round 1: counting the own pack purged one download early).
    const filler = Array.from({ length: 698 }, (_, i) => ({ name: `trip-f${i}` }));
    om.getPacks.mockImplementation(async () => [
      ...filler,
      { name: "trip-past" },
      { name: packNameFor(TEST_TRIP_ID) },
    ]);
    writePackAnnotation({
      tripId: "past",
      styleUrl: LIGHT_STYLE,
      regionKey: "r:70:271",
      completedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 1,
    });

    startPackDownload(target(), {
      tripStatusFor: (id) => (id === "past" ? "past" : undefined),
    });
    await flush();

    // Only the replace-time delete of OUR OWN pack — the eligible past pack
    // and its annotation survive.
    expect(om.deletePack.mock.calls.map(([name]) => name as string)).toEqual([
      packNameFor(TEST_TRIP_ID),
    ]);
    expect(readPackAnnotation("past")).toBeDefined();
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

  /** One trip scope as the app mounts it: the root controller + a surface reader. */
  const useScope = (trip: OfflinePackTrip) => {
    useOfflinePackController(trip);
    return useOfflinePackState(trip);
  };

  const wifi = { type: "WIFI", isConnected: true, isInternetReachable: true };
  const cellular = { type: "CELLULAR", isConnected: true, isInternetReachable: true };
  const none = { type: "NONE", isConnected: false, isInternetReachable: false };

  it("active trip on wifi auto-starts exactly once — ONE controller, the pill AND settings readers both mounted", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const root = await renderHook(() => useOfflinePackController(activeTrip()), { wrapper });
    const pill = await renderHook(() => useOfflinePackState(activeTrip()), { wrapper });
    const settings = await renderHook(() => useOfflinePackState(activeTrip()), { wrapper });

    await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
    await act(flush);
    expect(om.createPack).toHaveBeenCalledTimes(1);
    expect(network.getNetworkStateAsync).toHaveBeenCalledTimes(1);
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);
    // Both readers see the controller's download — one store, many readers.
    expect(pill.result.current).toEqual({ phase: "downloading", progress: 0 });
    expect(settings.result.current).toEqual({ phase: "downloading", progress: 0 });
    await root.unmount();
    await pill.unmount();
    await settings.unmount();
  });

  // Q2-186 duplicate-download pin. Falsification: delete the in-flight /
  // `downloading` guard at the top of `startPackDownload` and BOTH racing
  // instances call createPack -> 2 -> red. (The structural single-mount pins
  // are `liveOfflinePackControllers` here + the real-tree file
  // `src/__tests__/offline-pack-root-mount.test.tsx`.)
  it("two controller instances racing one wifi activation still start ONE download (latch backstop)", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const first = await renderHook(() => useOfflinePackController(activeTrip()), { wrapper });
    const second = await renderHook(() => useOfflinePackController(activeTrip()), { wrapper });

    await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
    await act(flush);
    expect(om.createPack).toHaveBeenCalledTimes(1);
    // The observable the single-mount pins read: two live instances is the bug.
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(2);
    await first.unmount();
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);
    await second.unmount();
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(0);
  });

  // Q2-186: surfaces consume, never mount. Falsification: put the activation
  // effect (or the live-instance registration) back into `useOfflinePackState`
  // and the SDK / network reads below fire -> red.
  it("useOfflinePackState is effect-free — an active trip on wifi never touches the SDK, the network or the store", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const { unmount } = await renderHook(() => useOfflinePackState(activeTrip()), { wrapper });
    await act(flush);

    expect(om.createPack).not.toHaveBeenCalled();
    expect(om.getPack).not.toHaveBeenCalled();
    expect(om.getPacks).not.toHaveBeenCalled();
    expect(network.getNetworkStateAsync).not.toHaveBeenCalled();
    expect(network.addNetworkStateListener).not.toHaveBeenCalled();
    expect(useOfflinePackStore.getState().packs).toEqual({});
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(0);
    await unmount();
  });

  it("live-instance accounting follows the controller's trip: switching A to B moves the count, unmount zeroes it", async () => {
    const { rerender, unmount } = await renderHook(
      (trip: OfflinePackTrip) => useOfflinePackController(trip),
      { wrapper, initialProps: activeTrip() },
    );
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(1);
    await rerender(makeActiveTrip(TRIP_B_ID));
    expect(liveOfflinePackControllers(TEST_TRIP_ID)).toBe(0);
    expect(liveOfflinePackControllers(TRIP_B_ID)).toBe(1);
    await unmount();
    expect(liveOfflinePackControllers(TRIP_B_ID)).toBe(0);
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

  // Q2-186 offline cell: NO connection is the stand-down arm — nothing
  // starts, nothing throws, ONE deferred listener waits, and wifi dropping
  // again mid-defer (a non-wifi event) neither downloads nor drops the
  // listener. Falsification: start on `isConnected` instead of the wifi gate
  // -> createPack fires on the cellular event; drop the `subscription` arm ->
  // no listener is ever armed.
  it("OFFLINE (no connection): stands down — no download, no crash, ONE deferred listener that survives non-wifi events", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => none);
    const remove = jest.fn();
    network.addNetworkStateListener.mockImplementation(() => ({ remove }));
    const { result, unmount } = await renderHook(() => useScope(activeTrip()), { wrapper });
    await act(flush);

    expect(result.current).toEqual({ phase: "none" });
    expect(om.createPack).not.toHaveBeenCalled();
    expect(network.addNetworkStateListener).toHaveBeenCalledTimes(1);

    const listener = network.addNetworkStateListener.mock.calls[0][0] as (
      event: typeof wifi,
    ) => void;
    await act(async () => listener(none)); // still offline
    await act(async () => listener(cellular)); // connected, not wifi
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    await act(async () => listener(wifi)); // wifi finally
    await act(flush);
    expect(om.createPack).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
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
    // The status gate precedes the network read — a planning trip costs none.
    expect(network.getNetworkStateAsync).not.toHaveBeenCalled();
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
    const { result, unmount } = await renderHook(() => useScope(activeTrip()), {
      wrapper,
    });
    expect(result.current).toEqual({
      phase: "ready",
      sizeBytes: 7_000_000,
      completedAt: "2026-08-18T00:00:00.000Z",
    });
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    await unmount();
  });

  it("a STALE pack never auto-refreshes at the HOOK grain — §2.5 trigger 3, even on wifi", async () => {
    // Machine-grain shouldAutoDownloadPack already pins stale-never-auto; this
    // pin holds it where the effect actually decides — an inlined phase check
    // in the hook that also arms on "stale" must fail HERE (round 1: the
    // machine pin alone let that hook edit silently re-download every mount).
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    om.getPack.mockImplementation(async () => ({ name: packNameFor(TEST_TRIP_ID) }));
    writePackAnnotation({
      tripId: TEST_TRIP_ID,
      styleUrl: "mapbox://styles/mapbox/dark-v11", // style drift => stale
      regionKey: packRegionKeyFor(KYOTO.lat, KYOTO.lng),
      completedAt: "2026-08-01T00:00:00.000Z",
      sizeBytes: 7_000_000,
    });
    const { result, unmount } = await renderHook(() => useScope(activeTrip()), {
      wrapper,
    });
    expect(result.current.phase).toBe("stale");
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    await unmount();
  });

  // B-7 part 3 (R-map-18 amendment, M9): a coordinate-less trip (a custom
  // destination with no location) stands the WHOLE machine down — same
  // degrade arm as NaN, but the REAL live signal now, not a defensive-only
  // arm. Falsification: revert the widened `OfflinePackTrip` type / the
  // `usable` guard's null check, and this throws inside `packRegionKeyFor`
  // -> `regionCellsForDestination` (NaN.toFixed-style crash on null math).
  it("NULL destination coords: never fingerprints, never auto-downloads, renders none", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const coordless = { ...activeTrip(), destination_lat: null, destination_lng: null };
    const { result, unmount } = await renderHook(() => useScope(coordless), {
      wrapper,
    });
    expect(result.current).toEqual({ phase: "none" });
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    expect(network.addNetworkStateListener).not.toHaveBeenCalled();
    await unmount();
  });

  // Round-1 architecture fix: both the controller and `OfflinePackManager`
  // now route usability through the ONE `usableDestinationCoords` helper
  // instead of three hand-rolled null-checks — this pins the FULL rule
  // (the out-of-range branch, not just null/NaN) at the controller, and
  // `OfflinePackManager.test.tsx` pins the SAME boundary input to the SAME
  // outcome. Mutation: revert either consumer to a bare
  // `lat === null || lng === null` check (dropping the range bound) and
  // that consumer alone starts treating this out-of-range pair as usable —
  // this test (or its OfflinePackManager sibling) goes RED while the other
  // stays green, exposing the disagreement.
  it("out-of-range (non-null) coords stand the machine down too — not just null/NaN", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const outOfRange = { ...activeTrip(), destination_lat: 91, destination_lng: 0 };
    const { result, unmount } = await renderHook(() => useScope(outOfRange), {
      wrapper,
    });
    expect(result.current).toEqual({ phase: "none" });
    await act(flush);
    expect(om.createPack).not.toHaveBeenCalled();
    expect(network.addNetworkStateListener).not.toHaveBeenCalled();
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

  // Q2-186 adversarial: switching trips (the trip switcher REPLACES the
  // `[tripId]` route, so the shell — and its controller — remounts on the new
  // trip) must neither cancel the in-flight download of the trip being left
  // nor leak its progress into the new trip. Falsification: have the
  // controller's effect cleanup call `deleteTripPack(tripId)` (cancel-on-
  // leave) -> A drops to `none` and its completion below never lands -> red.
  it("a trip switch mid-download keeps A's download alive and keyed to A; B starts on its own", async () => {
    network.getNetworkStateAsync.mockImplementation(async () => wifi);
    const { rerender, unmount } = await renderHook(
      (trip: OfflinePackTrip) => useOfflinePackController(trip),
      { wrapper, initialProps: activeTrip() },
    );
    await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(1));
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({ phase: "downloading", progress: 0 });

    await rerender(makeActiveTrip(TRIP_B_ID));
    await waitFor(() => expect(om.createPack).toHaveBeenCalledTimes(2));
    await act(flush);
    // A was neither restarted nor cancelled; B is its own download. The only
    // deletePack calls are each start's own replace-semantics delete.
    expect(om.createPack).toHaveBeenCalledTimes(2);
    expect(om.createPack.mock.calls[0][0]).toMatchObject({ name: packNameFor(TEST_TRIP_ID) });
    expect(om.createPack.mock.calls[1][0]).toMatchObject({ name: packNameFor(TRIP_B_ID) });
    expect(om.deletePack.mock.calls.map(([name]) => name as string)).toEqual([
      packNameFor(TEST_TRIP_ID),
      packNameFor(TRIP_B_ID),
    ]);
    expect(offlinePackStateFor(TEST_TRIP_ID)).toEqual({ phase: "downloading", progress: 0 });
    expect(offlinePackStateFor(TRIP_B_ID)).toEqual({ phase: "downloading", progress: 0 });

    // A's SDK listener — captured BEFORE the switch — still lands on A only.
    capturedProgressListener(0)(null, status(100, 4_000_000));
    expect(offlinePackStateFor(TEST_TRIP_ID)).toMatchObject({
      phase: "ready",
      sizeBytes: 4_000_000,
    });
    expect(readPackAnnotation(TEST_TRIP_ID)).toBeDefined();
    expect(offlinePackStateFor(TRIP_B_ID)).toEqual({ phase: "downloading", progress: 0 });
    expect(readPackAnnotation(TRIP_B_ID)).toBeUndefined();
    await unmount();
  });
});
