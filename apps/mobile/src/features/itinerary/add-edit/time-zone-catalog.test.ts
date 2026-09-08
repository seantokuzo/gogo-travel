/**
 * Static zone catalog (B-9) — the picker's list and its local ranked search.
 *
 * The catalog exists because Hermes has NO `Intl.supportedValuesOf`, so the
 * device cannot enumerate its own zones. The load-bearing property is
 * COVERAGE: every zone the seeded airport table can hand the form must be
 * offerable in the picker too, or a user who types an endpoint free-text
 * can't reach the zone their airport would have given them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DATE_LINE_EASTBOUND,
  DATE_LINE_EASTBOUND_EXTREME,
  MULTI_ZONE_TRIP,
} from "@gogo/shared/testing";

import { DEFAULT_AIRPORTS } from "@/test-utils/reference-fixtures";

import { TIME_ZONE_CATALOG_DATA } from "./time-zone-catalog.data";
import {
  normalizeZoneQuery,
  searchTimeZones,
  timeZoneCatalog,
  timeZoneSlug,
} from "./time-zone-catalog";

describe("timeZoneCatalog", () => {
  it("offers the generated source IN FULL, plus UTC — nothing is filtered away", () => {
    // B-9 R1 (tests lane): the old form of this arm looped the catalog
    // asserting `isKnownTimeZone(entry.id)`, which is the very predicate
    // `timeZoneCatalog()` FILTERS on — a filter checked against its own
    // output, unfalsifiable on any engine. The regression it exists to
    // catch (a platform whose ICU rejects most ids, collapsing the picker
    // to a stub) sailed straight through it. Assert against the generated
    // data instead, so ANY filtering reds. The engine-rejection half now
    // lives where it can actually happen: `zoned-time.hermes.test.ts`.
    const catalog = timeZoneCatalog();
    expect(catalog.length).toBe(TIME_ZONE_CATALOG_DATA.length + 1);
    expect(catalog.length).toBeGreaterThan(300);
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

  it("COVERAGE: every zone in the REAL seeded airport table is offerable (all 373, not 7 fixtures)", () => {
    // B-9 R1 (tests lane): `time-zone-catalog.data.ts`'s generated header
    // states "Every seeded airport zone is a member (pinned in
    // time-zone-catalog.test.ts)" — but the arm above only checks the 7
    // hand-written fixtures. This reads the actual ODbL snapshot the server
    // seeds from, so the header's claim is the thing under test.
    //
    // The regression: refresh the snapshot with an airport in a zone newer
    // than the catalog's generating tzdb (`America/Ciudad_Juarez`,
    // `Asia/Qostanay`) and the PICK still works — the zone rides on the row
    // — while the zone picker can never offer it, so the free-text fallback
    // rung is unreachable and the field label degrades to a raw id, with
    // every other suite green.
    //
    // Read straight off disk rather than imported: `@gogo/server` is not a
    // dependency of this workspace and must not become one for a test. If
    // the snapshot moves, this fails loudly rather than skipping — an
    // invariant that can silently opt out is not an invariant.
    const seedPath = join(__dirname, "../../../../../../apps/server/reference-data/airports.json");
    const rows = JSON.parse(readFileSync(seedPath, "utf8")) as { tz: string }[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(1000);

    const catalogIds = new Set(TIME_ZONE_CATALOG_DATA.map(([id]) => id));
    const seedZones = [...new Set(rows.map((row) => row.tz))].sort();
    expect(seedZones.length).toBeGreaterThan(300);
    expect(seedZones.filter((tz) => !catalogIds.has(tz))).toEqual([]);
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
