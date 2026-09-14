/**
 * Regenerates the committed bootstrap destination-tier dataset (B-7, S-5
 * build brief): a city/locality subset of Overture `divisions` large enough
 * that a fresh install can search-and-pick a destination before any
 * on-demand POI ingest has ever run (places spec §3.3.1/§3.6 "structured
 * search against an Overture city/locality subset", resolved Gate 2
 * 2026-07-09 — this script BUILDS that subset; it was never actually shipped).
 *
 *   pnpm --filter @gogo/server exec tsx scripts/generate-destination-tier.ts
 *
 * Writes `reference-data/destinations.json` (provenance + licence:
 * `reference-data/README.md`). NETWORK RUNS HERE, at generation time on a
 * dev machine, ONLY — the app never downloads anything at boot/runtime, and
 * tests only ever see the committed snapshot via the seed migration
 * (Law #5-compatible CI) — the exact posture `generate-reference-data.ts`
 * (B-9) already established for airports/airlines.
 *
 * Source: Overture Maps `divisions` theme, `division` type, `locality`
 * subtype (NOT the `places`/POI theme `region-ingest.ts` reads — a
 * different Overture table entirely; no collision risk with on-demand POI
 * ingest, §3 of the build brief). Release **PINNED** below — Overture ships
 * monthly releases with no `latest` alias (`docs.overturemaps.org/release/
 * latest/` 404s), so a refresh is a deliberate constant bump, never drift.
 * CDLA-Permissive-2.0 (per-source attribution) — free, unmetered, no account
 * (Law #5-safe; already the locked provider, places.spec.md §Attribution).
 *
 * Cut (Sean's ruling, 2026-09-13): `population >= 100,000 OR is-a-
 * sovereign-country-capital` — matches the population>=100k cut almost
 * exactly while the capital-of-country union catches every low/no-
 * population-data microstate capital (Nauru, Tuvalu, Vatican, San Marino…)
 * a pure population threshold would silently drop. Measured live against
 * this exact release: 6,927 rows (S-5 brief §2). `capital_of_divisions`
 * also flags county/region seats — filtering `subtype = 'country'` inside it
 * is load-bearing (an unfiltered "any admin capital" cut is 40,971 rows).
 *
 * Deterministic given a fixed release: the filter/projection is a total SQL
 * predicate, and output is sorted (name, source_id) for reviewable diffs
 * (`git diff` on a re-run shows only real upstream changes). The script
 * SELF-CHECKS a pin set of localities the B-7 fix's tests depend on and
 * refuses to write output that fails a pin.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { DESTINATION_NAME_MAX_CHARS } from "@gogo/shared/domains/trip";

/** Operator-facing generation report — the script's whole point is its output. */
// eslint-disable-next-line no-console -- generator report for the operator
const report = (line: string): void => console.log(line);

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "reference-data");

/**
 * Overture release — deploy-time config, PINNED (mirrors `env.ts`'s own
 * comment: release pins are never inferred from a "latest" alias, which
 * doesn't exist). Bump deliberately, regenerate, ship as a NEW migration
 * (Law #6) — same refresh posture as the airports/airlines snapshot
 * (`reference-data/README.md`), never an edit to a merged migration.
 */
const OVERTURE_RELEASE = "2026-08-19.0";
const DIVISIONS_URL = `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=divisions/type=division/*`;

// `TripCreateSchema.destination_name`'s wire cap (packages/shared/src/domains/
// trip.ts), NOT normalize.ts's 500-char `places.name` column cap — a name
// past this can be seeded and searched but can never survive a real
// `POST /trips` (B-7 round-1 blocking finding: the two caps had silently
// diverged, 500 vs 200). `generate-destination-tier.test.ts` pins the
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
 * Self-check pins — the B-7 fix's tests depend on these exact localities
 * existing (`Athens`/`Tokyo`/`Reykjavik` are the named B-7 repro; Reykjavik
 * is included via the CAPITAL arm, not population, so it also proves that
 * disjunct is live — Iceland's capital is well under most population
 * thresholds). One micro-state capital pins the low/no-population-data arm
 * specifically (a pure population>=100k cut would drop it).
 */
const NAME_PINS: ReadonlyArray<{ name: string; country: string }> = [
  { name: "Athens", country: "GR" },
  { name: "Tokyo", country: "JP" },
  { name: "Reykjavik", country: "IS" },
  { name: "Rome", country: "IT" },
  { name: "Oslo", country: "NO" },
];

const clean = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim().normalize("NFC");
  return trimmed.length === 0 ? null : trimmed;
};

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

async function queryDivisions(): Promise<DivisionRow[]> {
  report(`connecting to DuckDB (in-memory), release ${OVERTURE_RELEASE} …`);
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("install httpfs");
    await connection.run("load httpfs");
    // Public, unsigned bucket — no credentials configured, matches the S-5
    // brief's live verification (anonymous GET, HTTP 200).
    await connection.run("set s3_region='us-west-2'");

    report(
      `querying ${DIVISIONS_URL} (this reads the remote GeoParquet — may take a few minutes) …`,
    );
    // Name selection: `names.primary` is the LOCAL-SCRIPT name (e.g. "Αθήνα",
    // "東京") — a trigram search for "athens"/"tokyo" from an English-typing
    // user can never fuzzy-match it (disjoint alphabets, not just accents).
    // `names.common` is a MAP<lang, name> Overture ships for exactly this;
    // prefer its 'en' entry, falling back to `primary` when a locality has
    // no distinct English common name (Latin-script places: the two are
    // usually identical anyway). This is what makes the B-7 repro queries
    // (Athens/Tokyo/Reykjavik) findable at all — verified live: without the
    // fallback, Athens's row name is "Αθήνα" and the pin below fails.
    const reader = await connection.runAndReadAll(
      `select
         id,
         coalesce(names.common['en'], names."primary") as name,
         country,
         bbox.ymin as lat,
         bbox.xmin as lng,
         population,
         len(list_filter(capital_of_divisions, x -> x.subtype = 'country')) > 0 as is_country_capital,
         wikidata
       from read_parquet('${DIVISIONS_URL}')
       where subtype = 'locality'
         and (population >= 100000
              or len(list_filter(capital_of_divisions, x -> x.subtype = 'country')) > 0)`,
    );
    const rows = reader.getRowObjectsJson() as unknown as DivisionRow[];
    report(`raw rows returned: ${rows.length}`);
    return rows;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

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

/** One row per line — compact but diffable (airports.json/airlines.json convention). */
function toJsonLines(rows: object[]): string {
  return `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
}

const rawRows = await queryDivisions();

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

report(
  `destinations: ${rawRows.length} raw rows -> ${seeds.length} seeds (${skipped.length} skipped/deduped)`,
);
for (const line of skipped.slice(0, 50)) report(`  - ${line}`);
if (skipped.length > 50) report(`  … and ${skipped.length - 50} more`);

for (const pin of NAME_PINS) {
  const hit = seeds.find((s) => s.name === pin.name && s.country === pin.country);
  if (!hit) {
    throw new Error(
      `name pin failed: ${pin.name} (${pin.country}) not found in the generated destination tier`,
    );
  }
}

const capitalPinCount = seeds.filter((s) => s.isCountryCapital).length;
if (capitalPinCount < 100) {
  throw new Error(
    `sanity pin failed: only ${capitalPinCount} country-capital rows — expected ~199 per the S-5 brief`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "destinations.json"), toJsonLines(seeds));
report(`wrote ${seeds.length} destinations to ${OUT_DIR}`);
report("(licence + provenance: reference-data/README.md — update its snapshot date)");
