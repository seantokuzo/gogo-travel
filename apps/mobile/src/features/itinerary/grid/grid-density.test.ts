/**
 * Per-trip calendar-density persistence pins (T-7.13 — R-itin-33, §2.5b).
 * Exercises the REAL adapter over react-native-mmkv's sanctioned in-memory
 * jest mock (same posture as `last-viewed-trip.test.ts`).
 *
 * SHARED-INSTANCE MOCK (load-bearing for the independence pins): the
 * package's jest mock scopes every `createMMKV()` call to its OWN Map, but
 * on device every no-arg call is the one `mmkv.default` instance — so
 * `view-mode.ts` and `grid-density.ts` really do share a keyspace. The
 * file-local factory below restores that sharing; without it "density
 * survives a view-mode switch" passes even if the two keys collide.
 *
 * What change makes each pin red:
 * - round-trip: store → read stops returning the stored value (e.g. the
 *   writer and reader disagree on the key, or the reader ignores storage).
 * - default / corrupt: the reader returns raw storage (`as Density`) instead
 *   of validating against the union.
 * - independence: the density key is collapsed into `gogo.itineraryView.{id}`
 *   (the R-itin-9 list/grid key) — switching list ↔ grid would then clobber
 *   density, and vice versa.
 */
import { createMMKV } from "react-native-mmkv";

import { readItineraryViewMode, storeItineraryViewMode } from "../view-mode";
import {
  DEFAULT_DENSITY,
  DENSITIES,
  GRID_SURFACE_DENSITIES,
  gridDensityKey,
  isDensity,
  isGridSurfaceDensity,
  readGridDensity,
  storeGridDensity,
  type Density,
} from "./grid-density";

jest.mock("react-native-mmkv", () => {
  const actual = jest.requireActual<typeof import("react-native-mmkv")>("react-native-mmkv");
  let shared: ReturnType<typeof actual.createMMKV> | undefined;
  return {
    ...actual,
    createMMKV: (...args: Parameters<typeof actual.createMMKV>) => {
      shared ??= actual.createMMKV(...args);
      return shared;
    },
  };
});

const storage = createMMKV();

afterEach(() => {
  storage.clearAll();
});

describe("grid density persistence (gogo.itineraryGridDensity.{tripId})", () => {
  it("offers the four R-itin-33 options, Day first and default", () => {
    expect([...DENSITIES]).toEqual(["day", "3-day", "month", "trip-span"]);
    expect(DEFAULT_DENSITY).toBe("day");
    // The shared-hour-timeline subset excludes Month (its own surface, R-itin-35).
    expect([...GRID_SURFACE_DENSITIES]).toEqual(["day", "3-day", "trip-span"]);
  });

  it("uses the §2.5b key shape", () => {
    expect(gridDensityKey("trip-a")).toBe("gogo.itineraryGridDensity.trip-a");
  });

  it("defaults to Day when nothing is stored (first open)", () => {
    expect(readGridDensity("trip-a")).toBe("day");
  });

  it.each(DENSITIES)("round-trips %s — store then read", (density) => {
    storeGridDensity("trip-a", density);
    expect(readGridDensity("trip-a")).toBe(density);
  });

  it("a later store overwrites (one slot per trip)", () => {
    storeGridDensity("trip-a", "trip-span");
    storeGridDensity("trip-a", "3-day");
    expect(readGridDensity("trip-a")).toBe("3-day");
  });

  it("is per trip — one trip's density never leaks to another", () => {
    storeGridDensity("trip-a", "trip-span");
    expect(readGridDensity("trip-b")).toBe("day");
    storeGridDensity("trip-b", "month");
    expect(readGridDensity("trip-a")).toBe("trip-span");
    expect(readGridDensity("trip-b")).toBe("month");
  });

  it.each([
    ["an unknown word", "week"],
    ["the wrong case", "DAY"],
    ["the camel-case spelling", "threeDay"],
    ["an empty string", ""],
    ["serialized JSON", JSON.stringify({ density: "day" })],
    ["a number-like string", "3"],
  ])("a corrupt stored value (%s) reads as the Day default, never a throw", (_label, raw) => {
    storage.set(gridDensityKey("trip-a"), raw);
    expect(readGridDensity("trip-a")).toBe("day");
  });

  it("a corrupt value does not stick — the next store repairs it", () => {
    storage.set(gridDensityKey("trip-a"), "garbage");
    storeGridDensity("trip-a", "3-day");
    expect(readGridDensity("trip-a")).toBe("3-day");
  });

  it("is independent of the R-itin-9 list/grid key — density survives a view-mode switch", () => {
    storeGridDensity("trip-a", "trip-span");
    storeItineraryViewMode("trip-a", "grid");
    storeItineraryViewMode("trip-a", "list");
    expect(readGridDensity("trip-a")).toBe("trip-span");
  });

  it("is independent of the R-itin-9 list/grid key — a density change never flips the view mode", () => {
    storeItineraryViewMode("trip-a", "grid");
    storeGridDensity("trip-a", "3-day");
    expect(readItineraryViewMode("trip-a")).toBe("grid");
    // CONTROL: the two keys really are distinct slots.
    expect(gridDensityKey("trip-a")).not.toBe("gogo.itineraryView.trip-a");
    expect(storage.getString("gogo.itineraryView.trip-a")).toBe("grid");
  });
});

describe("density type guards", () => {
  it.each(DENSITIES)("isDensity accepts %s", (density) => {
    expect(isDensity(density)).toBe(true);
  });

  it.each([undefined, null, 0, "", "week", "DAY", {}, ["day"]])("isDensity rejects %p", (value) => {
    expect(isDensity(value)).toBe(false);
  });

  it("isGridSurfaceDensity accepts exactly the shared-timeline three — Month is not one", () => {
    const accepted = DENSITIES.filter((d: Density) => isGridSurfaceDensity(d));
    expect(accepted).toEqual(["day", "3-day", "trip-span"]);
    expect(isGridSurfaceDensity("month")).toBe(false);
  });
});
