/**
 * Static zone catalog (B-9) — the picker's list and its local ranked search.
 *
 * The catalog exists because Hermes has NO `Intl.supportedValuesOf`, so the
 * device cannot enumerate its own zones. The load-bearing property is
 * COVERAGE: every zone the seeded airport table can hand the form must be
 * offerable in the picker too, or a user who types an endpoint free-text
 * can't reach the zone their airport would have given them.
 */
import { DATE_LINE_EASTBOUND, DATE_LINE_EASTBOUND_EXTREME, MULTI_ZONE_TRIP } from "@gogo/shared/testing";

import { DEFAULT_AIRPORTS } from "@/test-utils/reference-fixtures";

import {
  normalizeZoneQuery,
  searchTimeZones,
  timeZoneCatalog,
  timeZoneSlug,
} from "./time-zone-catalog";
import { isKnownTimeZone } from "./zoned-time";

describe("timeZoneCatalog", () => {
  it("is non-trivial, ICU-resolvable throughout, and includes UTC", () => {
    const catalog = timeZoneCatalog();
    // tzdb's zone.tab carries ~400 canonical zones; a catalog that collapsed
    // to a handful (a generator or filter regression) fails here.
    expect(catalog.length).toBeGreaterThan(300);
    for (const entry of catalog) expect(isKnownTimeZone(entry.id)).toBe(true);
    expect(catalog.some((entry) => entry.id === "UTC")).toBe(true);
  });

  it("memoizes — the second call returns the same array identity", () => {
    expect(timeZoneCatalog()).toBe(timeZoneCatalog());
  });

  it("COVERAGE: every zone the hostile flight fixtures and the airport fixtures name is offerable", () => {
    // The picker is the fallback rung when an endpoint is typed rather than
    // picked. If a seeded airport's zone were missing here, that fallback
    // could not reproduce what the pick would have set.
    const ids = new Set(timeZoneCatalog().map((entry) => entry.id));
    const needed = new Set<string>([
      ...DEFAULT_AIRPORTS.map((airport) => airport.tz),
      DATE_LINE_EASTBOUND.origin.tz,
      DATE_LINE_EASTBOUND.destination.tz,
      DATE_LINE_EASTBOUND_EXTREME.origin.tz,
      DATE_LINE_EASTBOUND_EXTREME.destination.tz,
      ...MULTI_ZONE_TRIP.zones,
    ]);
    for (const tz of needed) expect(ids.has(tz)).toBe(true);
  });
});

describe("normalizeZoneQuery", () => {
  it("spaces separators so 'los_angeles', 'Los-Angeles' and 'Los Angeles' agree", () => {
    expect(normalizeZoneQuery("  Los_Angeles ")).toBe("los angeles");
    expect(normalizeZoneQuery("America/Los-Angeles")).toBe("america los angeles");
    expect(normalizeZoneQuery("Los   Angeles")).toBe("los angeles");
  });
});

describe("searchTimeZones", () => {
  it("ranks a city PREFIX above a substring and above an id/region match", () => {
    const ranked = searchTimeZones("tokyo").map((entry) => entry.id);
    expect(ranked[0]).toBe("Asia/Tokyo");
  });

  it("finds a multi-word city through any separator spelling", () => {
    for (const query of ["los angeles", "Los_Angeles", "los-angeles"]) {
      expect(searchTimeZones(query).map((entry) => entry.id)).toContain("America/Los_Angeles");
    }
  });

  it("matches on the ISO country code — 'JP' surfaces the Japanese zones", () => {
    const ids = searchTimeZones("JP").map((entry) => entry.id);
    expect(ids).toContain("Asia/Tokyo");
  });

  it("honors the limit and returns the whole catalog for an empty query", () => {
    expect(searchTimeZones("", 5)).toHaveLength(5);
    expect(searchTimeZones("")).toHaveLength(timeZoneCatalog().length);
    expect(searchTimeZones("   ")).toHaveLength(timeZoneCatalog().length);
  });

  it("returns nothing for junk rather than everything", () => {
    // Falsification for every pin above: a search that ignored its query
    // would return the full catalog here and still pass the `toContain`s.
    expect(searchTimeZones("zzzznotazone")).toEqual([]);
  });

  it("is stable across keystrokes — equal ranks keep catalog order", () => {
    const first = searchTimeZones("america", 10).map((entry) => entry.id);
    const second = searchTimeZones("america", 10).map((entry) => entry.id);
    expect(second).toEqual(first);
  });
});

describe("timeZoneSlug", () => {
  it("is a §2.7-legal testID qualifier — lowercase kebab, no slashes or underscores", () => {
    expect(timeZoneSlug("America/Los_Angeles")).toBe("america-los-angeles");
    expect(timeZoneSlug("Asia/Tokyo")).toBe("asia-tokyo");
    expect(timeZoneSlug("America/Argentina/Buenos_Aires")).toBe("america-argentina-buenos-aires");
    expect(timeZoneSlug("UTC")).toBe("utc");
    for (const entry of timeZoneCatalog()) {
      expect(timeZoneSlug(entry.id)).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
