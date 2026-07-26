/**
 * Most-recently-viewed stamp unit tests (T-6.6 / NAV-3; R-nav-23, §2.2).
 * Exercises the REAL adapter over react-native-mmkv's sanctioned in-memory
 * jest mock (same posture as theme storage).
 */
import {
  clearLastViewedTrip,
  readLastViewedTrip,
  stampLastViewedTrip,
} from "./last-viewed-trip";

afterEach(() => {
  clearLastViewedTrip();
});

describe("last-viewed-trip stamp (gogo.lastViewedTrip)", () => {
  it("round-trips { tripId, viewedAt }", () => {
    const before = Date.now();
    stampLastViewedTrip("trip-a");
    const stamp = readLastViewedTrip();
    expect(stamp?.tripId).toBe("trip-a");
    expect(stamp?.viewedAt).toBeGreaterThanOrEqual(before);
  });

  it("one slot — a later view overwrites (spec §2.2)", () => {
    stampLastViewedTrip("trip-a");
    stampLastViewedTrip("trip-b");
    expect(readLastViewedTrip()?.tripId).toBe("trip-b");
  });

  it("absent → null (never viewed)", () => {
    expect(readLastViewedTrip()).toBeNull();
  });

  it("corrupt persisted value → null, never a throw (boot path must not crash)", () => {
    // Reach through the same MMKV default instance the adapter writes.
    const { createMMKV } = jest.requireActual<typeof import("react-native-mmkv")>(
      "react-native-mmkv",
    );
    createMMKV().set("gogo.lastViewedTrip", "{not json");
    expect(readLastViewedTrip()).toBeNull();
    createMMKV().set("gogo.lastViewedTrip", JSON.stringify({ nope: true }));
    expect(readLastViewedTrip()).toBeNull();
  });
});
