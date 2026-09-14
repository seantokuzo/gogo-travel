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
 *
 * B-26 (device QA 2026-09-11, Sean: matching is "pretty limited in which
 * cities match"): query AND catalog now go through the SAME fold —
 * diacritics stripped, every `_`/`-`/`/` spaced, lowercased. Two concrete
 * misses that fixed:
 *
 *  - **accents**: "Zürich"/"São Paulo"/"Bogotá"/"Cancún"/"Reykjavík"
 *    matched NOTHING. IANA ids are ASCII, so the catalog side was already
 *    fold-clean and only the QUERY carried the accent — but folding both
 *    sides keeps it true if a future label source isn't ASCII.
 *  - **hyphenated ids**: the query normalizer spaced `-` while the haystack
 *    kept it, so `America/Port-au-Prince`, `Africa/Porto-Novo`,
 *    `America/Blanc-Sablon` and `Asia/Ust-Nera` were unreachable by their
 *    own full name in ANY spelling ("port au prince" AND "Port-au-Prince"
 *    both missed).
 *
 * Deliberately NOT widened (each is a data set, not a predicate — they need
 * a ruling, not a bigger regex): country NAMES ("Japan", "Türkiye"),
 * historical aliases ("Kiev", "Calcutta"), airport codes ("NYC"), and
 * anything fuzzy/edit-distance. Matching stays exact-substring over
 * city + region + raw id, which is what the ranking's stability depends on.
 */
import { TIME_ZONE_CATALOG_DATA } from "./time-zone-catalog.data";
import { isKnownTimeZone, zoneCityLabel, zoneRegionLabel } from "./zoned-time";

export interface TimeZoneEntry {
  id: string;
  city: string;
  region: string;
  /** ISO 3166-1 alpha-2 (`null` for `UTC`). */
  country: string | null;
  /** Folded city — the ranked prefix/substring target (see `foldZoneText`). */
  cityKey: string;
  /** Folded search haystack — city, region and the raw IANA id. */
  haystack: string;
}

/**
 * The ONE normalization both sides of the search run through: NFD-decompose,
 * drop combining marks, lowercase, space every `_`/`-`/`/`, collapse runs.
 *
 * The NFD + combining-mark strip is the idiom already shipping in
 * `features/deeplinks/us-city-slug.ts` (`citySlug`) — same engine, same
 * reason: an accented letter must fold to its base rather than vanish.
 */
export function foldZoneText(raw: string): string {
  return raw
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLowerCase()
    .replaceAll(/[/_-]+/g, " ")
    .replaceAll(/\s+/g, " ");
}

function entryOf(id: string, country: string | null): TimeZoneEntry {
  const city = zoneCityLabel(id);
  const region = zoneRegionLabel(id);
  return {
    id,
    city,
    region,
    country,
    cityKey: foldZoneText(city),
    haystack: foldZoneText(`${city} ${region} ${id}`),
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

/**
 * Trim, fold accents, lowercase, and space every `_`/`-`/`/` so
 * "los_angeles", "Los-Angeles" and "Los Angeles" agree — and so do "Zürich"
 * and "Zurich" (B-26). Kept as its own export because it is the QUERY half
 * of the pair; `foldZoneText` is the shared rule both halves run.
 */
export function normalizeZoneQuery(raw: string): string {
  return foldZoneText(raw);
}

/**
 * Ranked local search. Empty query → the whole catalog. Rank: city prefix
 * (0) → city substring (1) → haystack substring (2) → country code exact
 * (3); ties keep catalog order so results are stable across keystrokes.
 *
 * B-26: prefix/substring compare the FOLDED city (`cityKey`), not
 * `city.toLowerCase()` — a raw lowercase leaves the accent and the hyphen
 * in place, which is precisely what made "Zürich" and "Port-au-Prince"
 * unmatchable against their own names.
 */
export function searchTimeZones(
  rawQuery: string,
  limit = Number.POSITIVE_INFINITY,
): TimeZoneEntry[] {
  const query = normalizeZoneQuery(rawQuery);
  const all = timeZoneCatalog();
  if (query === "") return all.slice(0, limit);
  const ranked: { entry: TimeZoneEntry; rank: number; index: number }[] = [];
  const upperQuery = rawQuery.trim().toUpperCase();
  all.forEach((entry, index) => {
    let rank: number | null = null;
    if (entry.cityKey.startsWith(query)) rank = 0;
    else if (entry.cityKey.includes(query)) rank = 1;
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
