/**
 * Places-spine config (places spec §3.1.4/§3.2.4, R-places-17/18) — pins the
 * spec'd values and the attribution-registry completeness for every source
 * we actually ingest.
 */
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION,
  isSpineSource,
  PLACES_DEDUP_DISTANCE_M,
  PLACES_DEDUP_NAME_SIMILARITY,
  PLACES_REGION_GRID_DEGREES,
  SPINE_SOURCE_PRIORITY,
  spineSourcesAbove,
} from "./places.js";
import { PLACE_SOURCES } from "../enums.js";

describe("places spine config", () => {
  it("pins the spec'd grid + dedup thresholds (§3.1.3, §3.1.4 step 5)", () => {
    expect(PLACES_REGION_GRID_DEGREES).toBe(0.5);
    expect(PLACES_DEDUP_DISTANCE_M).toBe(50);
    expect(PLACES_DEDUP_NAME_SIMILARITY).toBe(0.6);
  });

  it("orders sources overture > fsq_os (R-places-18) and excludes custom", () => {
    expect(SPINE_SOURCE_PRIORITY).toEqual(["overture", "fsq_os"]);
    expect(spineSourcesAbove("overture")).toEqual([]);
    expect(spineSourcesAbove("fsq_os")).toEqual(["overture"]);
    expect(isSpineSource("custom")).toBe(false);
    // Every spine source is a valid place_source enum member.
    for (const source of SPINE_SOURCE_PRIORITY) {
      expect(PLACE_SOURCES).toContain(source);
      expect(isSpineSource(source)).toBe(true);
    }
  });

  it("ships a non-empty attribution entry for every ingested source (R-places-17)", () => {
    for (const source of SPINE_SOURCE_PRIORITY) {
      const entry = ATTRIBUTION[source];
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https:\/\//);
      expect(typeof entry.logo_required).toBe("boolean");
    }
  });
});
