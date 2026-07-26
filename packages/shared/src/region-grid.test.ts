/**
 * Region grid (places spec §3.1.3/§3.5) — key formula, 9-cell destination
 * coverage, pole/antimeridian edges. The grid is the shared contract between
 * POI ingest coverage and offline tile bounds; these tests pin the exact key
 * strings so neither consumer can drift.
 */
import { describe, expect, it } from "vitest";
import { PLACES_REGION_GRID_DEGREES } from "./config/places.js";
import { regionCellAt, regionCellsForDestination } from "./region-grid.js";

describe("regionCellAt", () => {
  it("matches the spec key formula r:{floor(lat/0.5)}:{floor(lng/0.5)}", () => {
    // Lisbon (T-6.1's canonical destination): floor(38.722252/0.5) = 77,
    // floor(-9.139337/0.5) = floor(-18.27…) = -19 (floor, NOT trunc).
    const lisbon = regionCellAt(38.722252, -9.139337);
    expect(lisbon.key).toBe("r:77:-19");
    expect(lisbon.minLat).toBe(38.5);
    expect(lisbon.maxLat).toBe(39);
    expect(lisbon.minLng).toBe(-9.5);
    expect(lisbon.maxLng).toBe(-9);

    // Southern+eastern hemisphere: Sydney.
    expect(regionCellAt(-33.8688, 151.2093).key).toBe("r:-68:302");
  });

  it("contains its point and spans exactly one grid step", () => {
    const cell = regionCellAt(38.722252, -9.139337);
    expect(cell.minLat).toBeLessThanOrEqual(38.722252);
    expect(cell.maxLat).toBeGreaterThan(38.722252);
    expect(cell.maxLat - cell.minLat).toBe(PLACES_REGION_GRID_DEGREES);
    expect(cell.maxLng - cell.minLng).toBe(PLACES_REGION_GRID_DEGREES);
  });

  it("cell boundaries belong to the higher cell (floor semantics)", () => {
    expect(regionCellAt(38.5, -9.5).key).toBe("r:77:-19");
    expect(regionCellAt(0, 0).key).toBe("r:0:0");
    expect(regionCellAt(-0.25, -0.25).key).toBe("r:-1:-1");
  });

  it("clamps the poles and wraps the antimeridian", () => {
    // lat 90 would index cell 180 ([90, 90.5)) — clamped into the last band.
    expect(regionCellAt(90, 0).key).toBe("r:179:0");
    expect(regionCellAt(-90, 0).key).toBe("r:-180:0");
    // lng 180 === lng -180: both land in the [-180, -179.5) cell.
    expect(regionCellAt(0, 180).key).toBe("r:0:-360");
    expect(regionCellAt(0, -180).key).toBe("r:0:-360");
  });

  it("rejects out-of-range coordinates loudly", () => {
    expect(() => regionCellAt(90.1, 0)).toThrow(RangeError);
    expect(() => regionCellAt(0, -180.1)).toThrow(RangeError);
    expect(() => regionCellAt(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe("regionCellsForDestination", () => {
  it("returns the containing cell first plus its 8 neighbors, all unique", () => {
    const cells = regionCellsForDestination(38.722252, -9.139337);
    expect(cells).toHaveLength(9);
    expect(cells[0]?.key).toBe("r:77:-19");
    expect(new Set(cells.map((c) => c.key)).size).toBe(9);
    // Every neighbor is within one index step of the center.
    for (const cell of cells) {
      const [, latIdx, lngIdx] = cell.key.split(":");
      expect(Math.abs(Number(latIdx) - 77)).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(lngIdx) - -19)).toBeLessThanOrEqual(1);
    }
  });

  it("is idempotent by key for any point inside the same cell (§3.1.3)", () => {
    const a = regionCellsForDestination(38.51, -9.49);
    const b = regionCellsForDestination(38.99, -9.01);
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
  });

  it("drops neighbors past a pole (9 → 6)", () => {
    const north = regionCellsForDestination(89.9, 10);
    expect(north).toHaveLength(6);
    expect(north[0]?.key).toBe("r:179:20");
    expect(north.every((c) => c.maxLat <= 90)).toBe(true);

    const south = regionCellsForDestination(-89.9, 10);
    expect(south).toHaveLength(6);
    expect(south.every((c) => c.minLat >= -90)).toBe(true);
  });

  it("wraps neighbors across the antimeridian instead of overflowing", () => {
    const cells = regionCellsForDestination(0, 179.9);
    expect(cells).toHaveLength(9);
    expect(cells[0]?.key).toBe("r:0:359");
    // The eastern neighbors wrap onto the -180 edge.
    const keys = cells.map((c) => c.key);
    expect(keys).toContain("r:0:-360");
    expect(keys).toContain("r:1:-360");
    expect(keys).toContain("r:-1:-360");
    expect(new Set(keys).size).toBe(9);
  });
});
