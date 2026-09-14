/**
 * Pure destination-tier row-shaping + pin verification (B-7).
 *
 * Split out of `scripts/generate-destination-tier.ts` (round-2 regression
 * fix, B-7 PR #75, verifier finding): that script's top level ran a LIVE
 * S3 GeoParquet query via DuckDB (`queryDivisions`) and rewrote the
 * committed `reference-data/destinations.json` (`writeFileSync`) as a side
 * effect of being IMPORTED, not just when run as a CLI. Because
 * `generate-destination-tier.test.ts` imported that script for its exported
 * types/functions, every `pnpm test` — CI included — silently hit the
 * network (Law #5) and rewrote the seed dataset out from under migration
 * `0004_destination_tier_seed.sql` (Law #6 drift), with a thrown generator
 * error surfacing as "no tests ran" rather than a failure.
 *
 * THIS module has neither: no network, no DuckDB, no filesystem write. It
 * takes already-fetched `DivisionRow`s (Overture `divisions` rows, one JS
 * object per locality) and returns/validates plain data. The CLI script
 * imports these functions, does the live query + write itself, and only
 * runs that part behind a main-guard — see the doc comment there for the
 * Overture release, cut predicate, and known-gaps narrative.
 */
import { DESTINATION_NAME_MAX_CHARS } from "@gogo/shared/domains/trip";

// `TripCreateSchema.destination_name`'s wire cap (packages/shared/src/domains/
// trip.ts), NOT normalize.ts's 500-char `places.name` column cap — a name
// past this can be seeded and searched but can never survive a real
// `POST /trips` (B-7 round-1 blocking finding: the two caps had silently
// diverged, 500 vs 200). `destination-tier-generator.test.ts` pins the
// boundary directly against this constant so a future re-divergence fails
// loud here, not on a traveler's device.
export const NAME_MAX = DESTINATION_NAME_MAX_CHARS;
const SOURCE_ID_MAX = 200; // mirrors normalize.ts's MAX_SOURCE_ID_CHARS
const WIKI_REF_MAX = 200; // mirrors normalize.ts's MAX_WIKI_REF_CHARS
const CONTROL_CHARS_RE = /\p{Cc}/u;

export interface DestinationSeed {
  /** Overture GERS id — `places.source_id` (source = 'overture'). */
  sourceId: string;
  name: string;
  /** ISO 3166-1 alpha-2, informational only (not a `places` column — the
   * table has none; kept here so duplicate-name rows stay distinguishable
   * in review/tests without re-querying Overture). */
  country: string | null;
  lat: number;
  lng: number;
  /** Informational only — not persisted; documents WHY a row was included. */
  population: number | null;
  isCountryCapital: boolean;
  /** Wikidata QID (`Q…`) when Overture carries one — `places.wiki_ref`. */
  wikiRef: string | null;
}

/**
 * What the CLI's DuckDB query yields — one row per Overture `divisions`
 * locality, still untyped/untrusted (DuckDB's JSON row reader gives back
 * `unknown` per column; `toSeed` is the validation gate).
 */
export interface DivisionRow {
  id: unknown;
  name: unknown;
  country: unknown;
  lat: unknown;
  lng: unknown;
  population: unknown;
  is_country_capital: unknown;
  wikidata: unknown;
}

/**
 * Self-check pins — the B-7 fix's tests depend on these exact localities
 * existing (`Athens`/`Tokyo`/`Reykjavik` are the named B-7 repro; Reykjavik
 * is included via the CAPITAL arm, not population, so it also proves that
 * disjunct is live — Iceland's capital is well under most population
 * thresholds). One micro-state capital pins the low/no-population-data arm
 * specifically (a pure population>=100k cut would drop it).
 */
export const NAME_PINS: ReadonlyArray<{ name: string; country: string }> = [
  { name: "Athens", country: "GR" },
  { name: "Tokyo", country: "JP" },
  { name: "Reykjavik", country: "IS" },
  { name: "Rome", country: "IT" },
  { name: "Oslo", country: "NO" },
];

/**
 * Capital-arm self-check (round-1 review, adversarial-verifier F9/A3): pins
 * that the CAPITAL predicate — not just population — is what's including
 * these rows. Every name here is verified present with `isCountryCapital ===
 * true` against the pinned release (2026-08-19.0); all seven have no/low
 * population data, so a regression that silently drops the capital arm (or
 * narrows `capital_of_divisions`'s subtype filter) reds here instead of
 * shipping. Deliberately does NOT include Vatican City (not a `locality` in
 * this Overture release — see the CLI's KNOWN GAPS doc-comment) or
 * Wellington/NZ (capital-flagged false upstream; present via population
 * only) — both are documented gaps, not pin candidates.
 */
export const CAPITAL_PINS: ReadonlyArray<{ name: string; country: string }> = [
  { name: "Yaren", country: "NR" },
  { name: "Funafuti", country: "TV" },
  { name: "City of San Marino", country: "SM" },
  { name: "Vaduz", country: "LI" },
  { name: "Monaco", country: "MC" },
  { name: "Ngerulmud", country: "PW" },
  { name: "Palikir", country: "FM" },
];

const clean = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim().normalize("NFC");
  return trimmed.length === 0 ? null : trimmed;
};

export function toSeed(row: DivisionRow, skipped: string[]): DestinationSeed | null {
  const sourceId = typeof row.id === "string" ? row.id.trim() : "";
  if (sourceId.length === 0 || sourceId.length > SOURCE_ID_MAX || CONTROL_CHARS_RE.test(sourceId)) {
    skipped.push(`(unknown id): unusable source id`);
    return null;
  }
  const name = clean(typeof row.name === "string" ? row.name : null);
  if (!name || name.length > NAME_MAX || CONTROL_CHARS_RE.test(name)) {
    skipped.push(`${sourceId}: unusable name`);
    return null;
  }
  const lat = typeof row.lat === "number" ? row.lat : Number(row.lat);
  const lng = typeof row.lng === "number" ? row.lng : Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    skipped.push(`${sourceId} (${name}): unusable coordinates`);
    return null;
  }
  const countryRaw = typeof row.country === "string" ? row.country.trim().toUpperCase() : "";
  const country = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : null;
  const population =
    typeof row.population === "number"
      ? row.population
      : typeof row.population === "bigint"
        ? Number(row.population)
        : null;
  const isCountryCapital = row.is_country_capital === true;
  const wikidataRaw = clean(typeof row.wikidata === "string" ? row.wikidata : null);
  const wikiRef =
    wikidataRaw && wikidataRaw.length <= WIKI_REF_MAX && !CONTROL_CHARS_RE.test(wikidataRaw)
      ? wikidataRaw
      : null;

  return { sourceId, name, country, lat, lng, population, isCountryCapital, wikiRef };
}

/**
 * Shapes raw DuckDB rows into deduped, deterministically-ordered seeds.
 * Dedup keeps the FIRST occurrence of a `source_id` (Overture ships one row
 * per GERS id in this release; a duplicate would be a data anomaly, not the
 * common case). Sorted by `(name, source_id)` — a total order, so a re-run
 * against the same release produces byte-identical output (reviewable
 * `git diff`).
 */
export function buildDestinationTier(rawRows: DivisionRow[]): {
  seeds: DestinationSeed[];
  skipped: string[];
} {
  const skipped: string[] = [];
  const seeds: DestinationSeed[] = [];
  const seenSourceIds = new Set<string>();
  for (const row of rawRows) {
    const seed = toSeed(row, skipped);
    if (!seed) continue;
    if (seenSourceIds.has(seed.sourceId)) {
      skipped.push(`${seed.sourceId}: duplicate source id — kept the first occurrence`);
      continue;
    }
    seenSourceIds.add(seed.sourceId);
    seeds.push(seed);
  }

  seeds.sort((a, b) =>
    a.name === b.name ? (a.sourceId < b.sourceId ? -1 : 1) : a.name < b.name ? -1 : 1,
  );

  return { seeds, skipped };
}

/**
 * Refuses to let a generation run ship a snapshot that silently regresses
 * the B-7 repro cities, the capital arm, or the overall capital coverage.
 * Pure/throwing, no I/O — the CLI calls this before writing to disk.
 */
export function verifyPins(seeds: DestinationSeed[]): void {
  for (const pin of NAME_PINS) {
    const hit = seeds.find((s) => s.name === pin.name && s.country === pin.country);
    if (!hit) {
      throw new Error(
        `name pin failed: ${pin.name} (${pin.country}) not found in the generated destination tier`,
      );
    }
  }

  for (const pin of CAPITAL_PINS) {
    const hit = seeds.find((s) => s.name === pin.name && s.country === pin.country);
    if (!hit) {
      throw new Error(
        `capital pin failed: ${pin.name} (${pin.country}) not found in the generated destination tier`,
      );
    }
    if (!hit.isCountryCapital) {
      throw new Error(
        `capital pin failed: ${pin.name} (${pin.country}) found but isCountryCapital is false — the capital arm regressed`,
      );
    }
  }

  const capitalPinCount = seeds.filter((s) => s.isCountryCapital).length;
  if (capitalPinCount < 100) {
    throw new Error(
      `sanity pin failed: only ${capitalPinCount} country-capital rows — expected ~199 per the S-5 brief`,
    );
  }
}

/** One row per line — compact but diffable (airports.json/airlines.json convention). */
export function toJsonLines(rows: object[]): string {
  return `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
}
