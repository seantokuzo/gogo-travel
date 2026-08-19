/**
 * Foreground location state machine (T-8.3 / MAP-4 — R-map-16/17, §2.6;
 * the P-8 foreground-only LOCK). Load-bearing pins:
 *  - LAZY: importing/mounting requests NOTHING (R-map-16 "no request on
 *    mount") — the system prompt fires only through tap → rationale →
 *    confirm.
 *  - The rationale FRONTS the prompt: the first tap on undetermined raises
 *    the dialog and does NOT call the system API.
 *  - Denied never loops: a system denial records state and stops (no
 *    chained dialog); a tap in denied state raises the Settings dialog.
 *  - Settings-return RECOVERY: the permission read is per-tap FRESH —
 *    cached `denied` is never trusted (deny → grant in Settings → the next
 *    tap acquires, no dialog).
 *  - Grant → single-shot position → camera intent armed (R-map-17) with
 *    [lng, lat] order (the Mapbox wire order — a swap flies to the ocean).
 *  - Single-flight: a second tap while a read is in flight is a no-op
 *    (deferred promises, resolver ARRAY per mobile.md — the request can
 *    fire more than once across tests).
 */
import { consumePendingCameraIntent, useMapCameraIntentStore } from "./camera-intent";
import {
  confirmLocateRationale,
  dismissLocateDialog,
  handleLocatePress,
  LOCATE_CAMERA_ZOOM,
  resetMapLocationForTests,
  useMapLocationStore,
} from "./location";

const locationMock = jest.requireMock("expo-location") as {
  __mock: {
    getForegroundPermissionsAsync: jest.Mock;
    requestForegroundPermissionsAsync: jest.Mock;
    getCurrentPositionAsync: jest.Mock;
  };
};

/**
 * IMPORT-TIME snapshot, taken before any beforeEach can mockClear: a
 * module-scope location-API touch in location.ts fires during the import
 * graph above, so asserting on live mock state inside a test is VACUOUS
 * against it (probe-caught: an eager `void getForegroundPermissionsAsync()`
 * at module scope left every test green until this snapshot existed; R1
 * probe P2 caught the same gap for an eager POSITION read — "importing
 * requests NOTHING" covers ALL THREE APIs, so all three are snapshotted).
 */
const importTimeLocationApiCalls =
  locationMock.__mock.getForegroundPermissionsAsync.mock.calls.length +
  locationMock.__mock.requestForegroundPermissionsAsync.mock.calls.length +
  locationMock.__mock.getCurrentPositionAsync.mock.calls.length;

const permission = (
  status: "granted" | "undetermined" | "denied",
  overrides?: { canAskAgain?: boolean },
) => ({
  status,
  granted: status === "granted",
  canAskAgain: overrides?.canAskAgain ?? status !== "denied",
  expires: "never",
});

const position = (lat: number, lng: number) => ({
  coords: {
    latitude: lat,
    longitude: lng,
    altitude: null,
    accuracy: 5,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: 0,
});

beforeEach(() => {
  resetMapLocationForTests();
  useMapCameraIntentStore.setState({ pending: null });
  locationMock.__mock.getForegroundPermissionsAsync.mockClear();
  locationMock.__mock.requestForegroundPermissionsAsync.mockClear();
  locationMock.__mock.getCurrentPositionAsync.mockClear();
});

it("R-map-16 LAZY: module import + initial state touch no permission API", () => {
  expect(useMapLocationStore.getState()).toEqual({
    permission: "unknown",
    position: null,
    busy: false,
    dialog: null,
  });
  // The import-time snapshot — NOT the live (clearable) mock state.
  expect(importTimeLocationApiCalls).toBe(0);
  expect(locationMock.__mock.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(locationMock.__mock.getCurrentPositionAsync).not.toHaveBeenCalled();
});

it("first tap on undetermined: rationale dialog up, system prompt NOT fired", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValueOnce(
    permission("undetermined"),
  );

  await handleLocatePress();

  expect(useMapLocationStore.getState().dialog).toBe("rationale");
  expect(useMapLocationStore.getState().permission).toBe("undetermined");
  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(locationMock.__mock.getCurrentPositionAsync).not.toHaveBeenCalled();
});

it("rationale confirmed → ONE system prompt → grant → position + camera intent", async () => {
  locationMock.__mock.requestForegroundPermissionsAsync.mockResolvedValueOnce(
    permission("granted"),
  );
  locationMock.__mock.getCurrentPositionAsync.mockResolvedValueOnce(position(35.01, 135.77));

  await confirmLocateRationale();

  const state = useMapLocationStore.getState();
  expect(locationMock.__mock.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(state.permission).toBe("granted");
  expect(state.dialog).toBeNull();
  expect(state.position).toEqual({ lat: 35.01, lng: 135.77 });
  // R-map-17: fly-to armed for the screen's rider drain — [lng, lat] order.
  expect(consumePendingCameraIntent()).toEqual({
    center: [135.77, 35.01],
    zoom: LOCATE_CAMERA_ZOOM,
  });
});

it("rationale confirmed → system DENIAL records denied and STOPS (no chained dialog)", async () => {
  locationMock.__mock.requestForegroundPermissionsAsync.mockResolvedValueOnce(
    permission("denied", { canAskAgain: false }),
  );

  await confirmLocateRationale();

  const state = useMapLocationStore.getState();
  expect(state.permission).toBe("denied");
  expect(state.dialog).toBeNull(); // §2.6 non-blocking — Settings waits for the next tap
  expect(state.position).toBeNull();
  expect(locationMock.__mock.getCurrentPositionAsync).not.toHaveBeenCalled();
});

it("tap while denied: Settings dialog, never a re-prompt", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValueOnce(
    permission("denied", { canAskAgain: false }),
  );

  await handleLocatePress();

  expect(useMapLocationStore.getState().dialog).toBe("settings");
  expect(useMapLocationStore.getState().permission).toBe("denied");
  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
});

it("Settings-return recovery: cached denied is NOT trusted — the per-tap fresh read observes the grant", async () => {
  // Denied earlier this session (the store remembers)…
  useMapLocationStore.setState({ permission: "denied" });
  // …the user flips the toggle in Settings and returns. The NEXT tap's
  // FRESH read must see the grant — an early return trusting the cached
  // `denied` raises the Settings dialog FOREVER (R-map-16 recovery
  // dead-end; review B2 / probe N1).
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValueOnce(permission("granted"));
  locationMock.__mock.getCurrentPositionAsync.mockResolvedValueOnce(position(35.02, 135.76));

  await handleLocatePress();

  const state = useMapLocationStore.getState();
  expect(state.permission).toBe("granted");
  expect(state.position).toEqual({ lat: 35.02, lng: 135.76 });
  expect(state.dialog).toBeNull(); // recovery completes — NO Settings dialog
});

it("tap while already granted: straight to position, no dialogs", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValueOnce(permission("granted"));
  locationMock.__mock.getCurrentPositionAsync.mockResolvedValueOnce(position(34.9, 135.7));

  await handleLocatePress();

  const state = useMapLocationStore.getState();
  expect(state.permission).toBe("granted");
  expect(state.dialog).toBeNull();
  expect(state.position).toEqual({ lat: 34.9, lng: 135.7 });
});

it("granted but the position read FAILS (location services off) → Settings dialog", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValueOnce(permission("granted"));
  locationMock.__mock.getCurrentPositionAsync.mockRejectedValueOnce(
    new Error("location unavailable"),
  );

  await handleLocatePress();

  const state = useMapLocationStore.getState();
  expect(state.dialog).toBe("settings");
  expect(state.position).toBeNull();
  expect(consumePendingCameraIntent()).toBeNull(); // no fly-to on failure
});

it("single-flight: a re-tap during an in-flight read is a no-op", async () => {
  // Deferred permission read, resolvers COLLECTED (mobile.md resolver-array
  // rule — the read fires once here, but the pattern must not strand a
  // second in-flight promise if a regression double-fires it).
  const resolvers: ((value: unknown) => void)[] = [];
  locationMock.__mock.getForegroundPermissionsAsync.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  locationMock.__mock.getCurrentPositionAsync.mockResolvedValue(position(35, 135));

  const first = handleLocatePress();
  try {
    // The store is busy while the first read holds — the second tap must
    // not reach the permission API again.
    expect(useMapLocationStore.getState().busy).toBe(true);
    const second = handleLocatePress();
    await second; // returns immediately (busy gate)
    expect(locationMock.__mock.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  } finally {
    for (const resolve of resolvers) resolve(permission("granted"));
  }
  await first;
  expect(useMapLocationStore.getState().busy).toBe(false);
});

it("dismissing a dialog changes nothing and re-fires nothing", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValueOnce(
    permission("undetermined"),
  );
  await handleLocatePress();
  expect(useMapLocationStore.getState().dialog).toBe("rationale");

  dismissLocateDialog();

  const state = useMapLocationStore.getState();
  expect(state.dialog).toBeNull();
  expect(state.permission).toBe("undetermined");
  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
});
