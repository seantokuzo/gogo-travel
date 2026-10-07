/**
 * tz-lookup accuracy gate (B-30). A wrong destination zone is SILENT — it
 * just moves a trip's boundary day — so the zone derivation
 * (`@photostructure/tz-lookup`, ~88 KB, CC0) is gated against exact polygon
 * lookup (`geo-tz/all`, dev-only, 70 MB, the same source `airports.tz` was
 * generated from): the UTC OFFSET must match at a summer AND a winter
 * instant (only the offset moves "today"; two ids with the same offset are
 * equivalent for this feature).
 *
 * Three arms:
 *  1. SAMPLED PIN (strict): every destination-tier country capital + the 100
 *     most populous rows + a stride sample, and a stride sample of airports
 *     (whose `tz` IS the geo-tz answer). Any offset disagreement must be on
 *     `KNOWN_OFFSET_DISAGREEMENTS` BY NAME with the reason; an entry that no
 *     longer disagrees also fails (the list cannot rot).
 *  2. FULL-CORPUS RATCHET: the disagreement COUNT over ALL 6,927 destination
 *     rows and all 4,133 airports may not exceed the measured baseline — a
 *     tz-lookup upgrade (or a dataset refresh) that degrades accuracy goes
 *     red. ~3 s; it is what makes a version bump safe.
 *  3. MEASUREMENT TIE-OUT: baseline numbers recorded in the PR body came from
 *     exactly this comparison (tz-lookup 11.7.0 vs geo-tz 8.1.8, 2026-07-01 /
 *     2026-01-01 12:00Z).
 *
 * Falsification: swap `deriveZoneFromCoords`'s library for a constant zone —
 * arm 1 reds on the first non-allow-listed row; raise a baseline-less
 * regression (e.g. downgrade tz-lookup to 6.x) — arm 2 reds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { find as geoTzFind } from "geo-tz/all";
import { describe, expect, it } from "vitest";
import { deriveZoneFromCoords } from "./destination-tz.js";

const REFERENCE_DIR = join(import.meta.dirname, "../../reference-data");

interface DestinationRow {
  sourceId: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  population: number | null;
  isCountryCapital: boolean;
}
interface AirportRow {
  iata: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  tz: string;
}

const readJson = <T>(file: string): T[] =>
  JSON.parse(readFileSync(join(REFERENCE_DIR, file), "utf8")) as T[];

/** Summer and winter instants (northern-hemisphere naming; both DST halves are covered). */
const INSTANTS = [new Date("2026-07-01T12:00:00Z"), new Date("2026-01-01T12:00:00Z")] as const;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Minutes east of UTC that `tz` observes at `at` (full-ICU Node). */
function utcOffsetMinutes(tz: string, at: Date): number {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, formatter);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(formatter.formatToParts(at).find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** True when the two zones observe a different UTC offset at EITHER instant. */
function offsetsDisagree(a: string, b: string): boolean {
  return INSTANTS.some((at) => utcOffsetMinutes(a, at) !== utcOffsetMinutes(b, at));
}

/** tz-lookup's zone for a row, or a marker if the library threw (it must not for any real row). */
function lookupZone(lat: number, lng: number): string {
  const zone = deriveZoneFromCoords(lat, lng);
  if (zone === null) throw new Error(`deriveZoneFromCoords returned null for ${lat},${lng}`);
  return zone;
}

/**
 * Offset disagreements we KNOW about and accept, by stable key
 * (`name|country` for destination rows, IATA for airports) with the reason.
 * A user with one of these destinations overrides the zone explicitly
 * (`destination_tz` on create/PATCH); T-7.17 ships the picker. Anything not
 * listed here that disagrees fails the sampled pin.
 */
const XINJIANG =
  "Xinjiang: tz-lookup answers Asia/Urumqi (UTC+6, the unofficial local time); geo-tz / official civil time is Asia/Shanghai (UTC+8) — a defensible-but-different convention, ~2h of day-boundary skew";
const BORDER =
  "polygon-simplification miss near a border: tz-lookup's quadtree cell straddles the boundary";
const KNOWN_OFFSET_DISAGREEMENTS: Record<string, string> = {
  "Dili|TL": `Timor-Leste capital — ${BORDER} (answers Asia/Makassar UTC+8 vs real Asia/Dili UTC+9)`,
  OEC: `Oecusse (Timor-Leste enclave airport) — ${BORDER} (Asia/Makassar vs Asia/Dili)`,
  HMI: `Hami airport — ${XINJIANG}`,
  NLT: `Xinyuan/Nalati airport — ${XINJIANG}`,
  "Forward Kahuta|PK": `Kashmir line of control — ${BORDER} (Asia/Kolkata UTC+5:30 vs Asia/Karachi UTC+5)`,
};

describe("tz-lookup vs geo-tz — SAMPLED PIN (strict; allow-list by name)", () => {
  const destinations = readJson<DestinationRow>("destinations.json");
  const airports = readJson<AirportRow>("airports.json");

  const sampledDestinations: DestinationRow[] = (() => {
    const picked = new Map<string, DestinationRow>();
    const keyOf = (row: DestinationRow) => row.sourceId;
    for (const row of destinations) if (row.isCountryCapital) picked.set(keyOf(row), row);
    [...destinations]
      .sort(
        (a, b) => (b.population ?? 0) - (a.population ?? 0) || a.sourceId.localeCompare(b.sourceId),
      )
      .slice(0, 100)
      .forEach((row) => picked.set(keyOf(row), row));
    destinations.forEach((row, index) => {
      if (index % 40 === 0) picked.set(keyOf(row), row);
    });
    return [...picked.values()];
  })();
  const sampledAirports = airports.filter((_, index) => index % 10 === 0);

  it("the sample is a few hundred destination rows and several hundred airports (not accidentally empty)", () => {
    expect(sampledDestinations.length).toBeGreaterThanOrEqual(300);
    expect(sampledDestinations.length).toBeLessThanOrEqual(900);
    expect(sampledAirports.length).toBeGreaterThanOrEqual(400);
  });

  it("destination tier: every sampled row's offset matches geo-tz at both instants (except allow-listed names)", () => {
    const unexpected: string[] = [];
    for (const row of sampledDestinations) {
      const geo = geoTzFind(row.lat, row.lng)[0];
      if (geo === undefined) {
        unexpected.push(`${row.name}|${row.country}: geo-tz found no zone`);
        continue;
      }
      const ours = lookupZone(row.lat, row.lng);
      const key = `${row.name}|${row.country}`;
      if (offsetsDisagree(ours, geo) && !(key in KNOWN_OFFSET_DISAGREEMENTS)) {
        unexpected.push(`${key} @${row.lat},${row.lng}: tz-lookup=${ours} geo-tz=${geo}`);
      }
    }
    expect(unexpected, `unlisted offset disagreements:\n${unexpected.join("\n")}`).toEqual([]);
  });

  it("airports: every sampled airport's offset matches its geo-tz-derived tz at both instants", () => {
    const unexpected: string[] = [];
    for (const row of sampledAirports) {
      const ours = lookupZone(row.lat, row.lng);
      if (offsetsDisagree(ours, row.tz) && !(row.iata in KNOWN_OFFSET_DISAGREEMENTS)) {
        unexpected.push(
          `${row.iata} @${row.lat},${row.lng}: tz-lookup=${ours} airports.tz=${row.tz}`,
        );
      }
    }
    expect(unexpected, `unlisted offset disagreements:\n${unexpected.join("\n")}`).toEqual([]);
  });

  it("the allow-list cannot rot: every entry still disagrees (a fixed library must shrink the list)", () => {
    const stale: string[] = [];
    for (const key of Object.keys(KNOWN_OFFSET_DISAGREEMENTS)) {
      const dest = destinations.find((row) => `${row.name}|${row.country}` === key);
      const airport = airports.find((row) => row.iata === key);
      if (dest !== undefined) {
        const geo = geoTzFind(dest.lat, dest.lng)[0];
        if (geo === undefined || !offsetsDisagree(lookupZone(dest.lat, dest.lng), geo))
          stale.push(key);
      } else if (airport !== undefined) {
        if (!offsetsDisagree(lookupZone(airport.lat, airport.lng), airport.tz)) stale.push(key);
      } else {
        stale.push(`${key} (no such row)`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe("tz-lookup vs geo-tz — FULL-CORPUS RATCHET (count may not grow)", () => {
  // Measured 2026-10-06, tz-lookup 11.7.0 vs geo-tz 8.1.8, instants 2026-07-01 / 2026-01-01 12:00Z:
  //   destination tier: 51 of 6,927 offset-disagree (31 Asia/Urumqi vs Asia/Shanghai, 20 border/other)
  //   airports:         70 of 4,133 offset-disagree (16 Urumqi/Shanghai, 54 border cells across ~28 countries)
  // (zone-ID disagreements are higher — 83 / 152 — but most are equal-offset: irrelevant here.)
  const DESTINATION_BASELINE = 51;
  const AIRPORT_BASELINE = 70;

  it("destination tier: offset disagreements ≤ the measured baseline", { timeout: 120_000 }, () => {
    let count = 0;
    for (const row of readJson<DestinationRow>("destinations.json")) {
      const geo = geoTzFind(row.lat, row.lng)[0];
      if (geo === undefined || offsetsDisagree(lookupZone(row.lat, row.lng), geo)) count += 1;
    }
    expect(count).toBeLessThanOrEqual(DESTINATION_BASELINE);
  });

  it("airports: offset disagreements ≤ the measured baseline", { timeout: 120_000 }, () => {
    let count = 0;
    for (const row of readJson<AirportRow>("airports.json")) {
      if (offsetsDisagree(lookupZone(row.lat, row.lng), row.tz)) count += 1;
    }
    expect(count).toBeLessThanOrEqual(AIRPORT_BASELINE);
  });
});
