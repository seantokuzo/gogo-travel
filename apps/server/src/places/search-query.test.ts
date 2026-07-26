/**
 * Unit pins for the near-search prefilter box edges (T-6.5 round-1 #7):
 * the ±180 no-wrap clamp and the deliberate polar-sliver exclusion.
 */
import { describe, expect, it } from "vitest";
import { nearPrefilterBox } from "./search-query.js";

describe("nearPrefilterBox", () => {
  it("clamps at ±180 instead of wrapping (v1 no-antimeridian posture)", () => {
    const box = nearPrefilterBox(10, 179.9, 50_000);
    expect(box.maxLng).toBe(180); // clamped, never wrapped onto -180
    expect(box.minLng).toBeLessThan(179.9);
    expect(box.minLng).toBeGreaterThan(179); // ~0.46° half-width at lat 10
    // The far side of the date line is deliberately lost (comment contract).
    expect(box.minLng).toBeLessThanOrEqual(box.maxLng);
  });

  it("clamps at the poles on the lat axis", () => {
    const box = nearPrefilterBox(89.9, 0, 50_000);
    expect(box.maxLat).toBe(90);
    expect(box.minLat).toBeCloseTo(89.9 - 50_000 / 111_320, 6);
  });

  it("above |lat| ≈ 89.43° the cos-clamp UNDER-covers by design (polar sliver excluded)", () => {
    const lat = 89.9; // cos ≈ 0.0017 — well under the 0.01 clamp
    const box = nearPrefilterBox(lat, 0, 50_000);
    const clampedHalf = 50_000 / (111_320 * 0.01); // ≈ 44.91°
    const trueHalf = 50_000 / (111_320 * Math.cos((lat * Math.PI) / 180)); // ≈ 257°
    expect(box.maxLng).toBeCloseTo(clampedHalf, 6);
    expect(box.maxLng).toBeLessThan(trueHalf); // narrower than the true circle
  });

  it("mid-latitude boxes over-cover symmetrically (residual trims the corners)", () => {
    const box = nearPrefilterBox(38.7, -9.14, 2_000);
    expect(box.maxLat - 38.7).toBeCloseTo(38.7 - box.minLat, 12);
    expect(box.maxLng - -9.14).toBeCloseTo(-9.14 - box.minLng, 12);
    // Lng half-width exceeds lat half-width by 1/cos(lat).
    expect(box.maxLng - -9.14).toBeGreaterThan(box.maxLat - 38.7);
  });
});
