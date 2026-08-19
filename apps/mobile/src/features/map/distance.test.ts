/**
 * On-device distance (T-8.3 — §2.3 distance label, §2.6 computed
 * on-device). Haversine sanity against a surveyed pair + the format
 * thresholds the sheet renders.
 */
import { distanceLabelFor, formatDistance, haversineMeters } from "./distance";

describe("haversineMeters", () => {
  it("zero for identical points", () => {
    const p = { lat: 35.0116, lng: 135.7681 };
    expect(haversineMeters(p, p)).toBe(0);
  });

  it("Kyoto Station → Fushimi Inari ≈ 2.4 km (known pair, ±5%)", () => {
    const kyotoStation = { lat: 34.9858, lng: 135.7588 };
    const fushimiInari = { lat: 34.9671, lng: 135.7727 };
    const meters = haversineMeters(kyotoStation, fushimiInari);
    expect(meters).toBeGreaterThan(2280);
    expect(meters).toBeLessThan(2520); // ~2.4 km great-circle
  });

  it("symmetric", () => {
    const a = { lat: 35.0, lng: 135.0 };
    const b = { lat: 35.5, lng: 135.5 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe("formatDistance", () => {
  it.each([
    [0, "0 m"],
    [850.4, "850 m"],
    [999.4, "999 m"],
    // A12 boundary: rounds to 1000 m — the UNIT cut is on the rounded
    // value, so this is already a kilometer, never "1000 m".
    [999.6, "1.0 km"],
    [1000, "1.0 km"],
    [1234, "1.2 km"],
    [9949, "9.9 km"],
    // A12 boundary: the 10 km cut is a PRECISION switch inside the same
    // unit — raw-value branch, so one decimal survives the round-up.
    [9999.6, "10.0 km"],
    [10_000, "10 km"],
    [23_400, "23 km"],
  ])("%d m → %s", (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });
});

describe("distanceLabelFor", () => {
  it("null without a position — the sheet line is simply absent", () => {
    expect(distanceLabelFor(null, { lat: 35, lng: 135 })).toBeNull();
  });

  it("labels with the away suffix when a position is known", () => {
    const label = distanceLabelFor({ lat: 34.9858, lng: 135.7588 }, { lat: 34.9671, lng: 135.7727 });
    expect(label).toMatch(/km away$/);
  });
});
