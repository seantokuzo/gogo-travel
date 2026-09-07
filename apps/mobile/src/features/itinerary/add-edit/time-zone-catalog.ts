/**
 * Static IANA zone catalog for the per-endpoint zone picker (B-9 client
 * half / B-8). Hermes has no `Intl.supportedValuesOf`, so the list is
 * tzdb's own `zone.tab` (public domain, generated into
 * `time-zone-catalog.data.ts` by `apps/mobile/scripts/gen-time-zone-catalog.mjs`)
 * plus `UTC`. Entries are filtered ONCE through the platform's ICU
 * (`isKnownTimeZone`) so a zone the device can't resolve is never offered.
 *
 * Search is local and ranked: city-prefix → city-substring → id/region
 * substring → country code — the airport typeahead's ranking posture,
 * applied to a ~420-row list that never leaves the client.
 */
import { TIME_ZONE_CATALOG_DATA } from "./time-zone-catalog.data";
import { isKnownTimeZone, zoneCityLabel, zoneRegionLabel } from "./zoned-time";

export interface TimeZoneEntry {
  id: string;
  city: string;
  region: string;
  /** ISO 3166-1 alpha-2 (`null` for `UTC`). */
  country: string | null;
  /** Lowercased search haystack — city, region, id with separators spaced. */
  haystack: string;
}

function entryOf(id: string, country: string | null): TimeZoneEntry {
  const city = zoneCityLabel(id);
  const region = zoneRegionLabel(id);
  return {
    id,
    city,
    region,
    country,
    haystack: `${city} ${region} ${id.replaceAll(/[/_]/g, " ")}`.toLowerCase(),
  };
}

let catalog: readonly TimeZoneEntry[] | null = null;

/** The full picker list (ICU-filtered, id order = region-grouped). Built lazily, once. */
export function timeZoneCatalog(): readonly TimeZoneEntry[] {
  if (catalog !== null) return catalog;
  const entries: TimeZoneEntry[] = [];
  for (const [id, country] of TIME_ZONE_CATALOG_DATA) {
    if (isKnownTimeZone(id)) entries.push(entryOf(id, country));
  }
  entries.push(entryOf("UTC", null));
  catalog = entries;
  return catalog;
}

/** Test seam: drop the memo (a suite that stubs `Intl` needs a rebuild). */
export function resetTimeZoneCatalogForTests(): void {
  catalog = null;
}

/** Trim, lowercase, and space every `_`/`-`/`/` so "los_angeles" and "Los Angeles" agree. */
export function normalizeZoneQuery(raw: string): string {
  return raw.trim().toLowerCase().replaceAll(/[/_-]+/g, " ").replaceAll(/\s+/g, " ");
}

/**
 * Ranked local search. Empty query → the whole catalog. Rank: city prefix
 * (0) → city substring (1) → haystack substring (2) → country code exact
 * (3); ties keep catalog order so results are stable across keystrokes.
 */
export function searchTimeZones(rawQuery: string, limit = Number.POSITIVE_INFINITY): TimeZoneEntry[] {
  const query = normalizeZoneQuery(rawQuery);
  const all = timeZoneCatalog();
  if (query === "") return all.slice(0, limit);
  const ranked: { entry: TimeZoneEntry; rank: number; index: number }[] = [];
  const upperQuery = rawQuery.trim().toUpperCase();
  all.forEach((entry, index) => {
    const city = entry.city.toLowerCase();
    let rank: number | null = null;
    if (city.startsWith(query)) rank = 0;
    else if (city.includes(query)) rank = 1;
    else if (entry.haystack.includes(query)) rank = 2;
    else if (entry.country !== null && entry.country === upperQuery) rank = 3;
    if (rank !== null) ranked.push({ entry, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.slice(0, limit).map((row) => row.entry);
}

/** §2.7 qualifier for a zone id: `America/Los_Angeles` → `america-los-angeles`. */
export function timeZoneSlug(tz: string): string {
  return tz.toLowerCase().replaceAll(/[/_]/g, "-");
}
