/**
 * Regenerates the committed bootstrap destination-tier dataset (B-7, S-5
 * build brief): a city/locality subset of Overture `divisions` large enough
 * that a fresh install can search-and-pick a destination before any
 * on-demand POI ingest has ever run (places spec §3.3.1/§3.6 "structured
 * search against an Overture city/locality subset", resolved Gate 2
 * 2026-07-09 — this script BUILDS that subset; it was never actually shipped).
 *
 *   pnpm --filter @gogo/shared build   # this script imports @gogo/shared's
 *                                       # built dist (DESTINATION_NAME_MAX_CHARS)
 *   pnpm --filter @gogo/server exec tsx scripts/generate-destination-tier.ts
 *
 * Writes `reference-data/destinations.json` (provenance + licence:
 * `reference-data/README.md`). NETWORK RUNS HERE, at generation time on a
 * dev machine, ONLY, and ONLY when this file is executed directly (the
 * main-guard at the bottom) — the app never downloads anything at
 * boot/runtime, and tests only ever see the committed snapshot via the seed
 * migration (Law #5-compatible CI) — the exact posture
 * `generate-reference-data.ts` (B-9) already established for airports/
 * airlines.
 *
 * PURE SPLIT (round-2 regression fix, B-7 PR #75): every deterministic
 * piece — row shaping, dedup, ordering, `NAME_MAX`, and the self-check pins
 * — lives in `src/places/destination-tier-generator.ts`, a plain module
 * with no network/DuckDB/fs. This file is CLI-only: the live DuckDB query
 * and the disk write happen ONLY under `if (isMain)` below, so importing
 * this module (or the pure module) — as `generate-destination-tier.test.ts`
 * does — can never trigger a live S3 GeoParquet read or rewrite
 * `reference-data/destinations.json`. Previously this script ran the query
 * and the write at MODULE TOP LEVEL, so importing it for its exported types
 * silently did both on every `pnpm test`, including in CI.
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
 * exactly while the capital-of-country union catches most low/no-
 * population-data microstate capitals (Nauru's Yaren, Tuvalu's Funafuti,
 * San Marino, Liechtenstein's Vaduz, Monaco, Palau's Ngerulmud, Micronesia's
 * Palikir — all verified present and flagged, see the pure module's
 * `CAPITAL_PINS`) a pure population threshold would silently drop. Measured
 * live against this exact release: 6,927 rows (S-5 brief §2).
 * `capital_of_divisions` also flags county/region seats — filtering
 * `subtype = 'country'` inside it is load-bearing (an unfiltered "any admin
 * capital" cut is 40,971 rows).
 *
 * KNOWN GAPS (round-1 review, adversarial-verifier F9/A3 — do not re-claim
 * "every" capital is caught here): (1) Vatican City IS in this Overture
 * release but tagged `subtype='macrohood'`, never `'locality'` — the
 * country has no locality-subtype row at all, so it is absent from this
 * tier regardless of the capital predicate (verified live; a second data
 * source or a broader subtype cut would be needed — Sean's call, not made
 * here). (2) Overture's `capital_of_divisions` back-reference itself has
 * upstream gaps: New Zealand's capital, Wellington, carries no
 * `capital_of_divisions` entry, and NZ's own `country`-subtype row's
 * `capital_division_ids` forward-reference is ALSO null (verified live) —
 * nothing recoverable from this dataset either direction. Wellington is
 * still seeded (population 215,152 clears the population arm), so this is
 * a mis-flagged `isCountryCapital` (informational only, not a `places`
 * column), not a missing row. The predicate below reads the correct field;
 * there is nothing in this dataset to fix it with.
 *
 * Deterministic given a fixed release: the filter/projection is a total SQL
 * predicate, and output is sorted (name, source_id) for reviewable diffs
 * (`git diff` on a re-run shows only real upstream changes). The pins
 * verified below refuse to write output that fails a pin.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDestinationTier,
  toJsonLines,
  verifyPins,
  type DivisionRow,
} from "../src/places/destination-tier-generator.js";

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

async function queryDivisions(): Promise<DivisionRow[]> {
  // Dynamic import, deliberately: this is the ONLY place `@duckdb/node-api`
  // is ever loaded, and `queryDivisions` only ever runs inside `main()`,
  // gated behind the main-guard at the bottom of this file. A test that
  // imports this module (main-guard false under vitest) never evaluates
  // this line, so `@duckdb/node-api` — and the live S3 query it performs —
  // is provably never touched by importing the script (round-2 regression
  // pin, `destination-tier-generator.test.ts`).
  const { DuckDBInstance } = await import("@duckdb/node-api");
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

async function main(): Promise<void> {
  const rawRows = await queryDivisions();
  const { seeds, skipped } = buildDestinationTier(rawRows);

  report(
    `destinations: ${rawRows.length} raw rows -> ${seeds.length} seeds (${skipped.length} skipped/deduped)`,
  );
  for (const line of skipped.slice(0, 50)) report(`  - ${line}`);
  if (skipped.length > 50) report(`  … and ${skipped.length - 50} more`);

  verifyPins(seeds);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "destinations.json"), toJsonLines(seeds));
  report(`wrote ${seeds.length} destinations to ${OUT_DIR}`);
  report("(licence + provenance: reference-data/README.md — update its snapshot date)");
}

// Only run the live query + write when this file is executed directly
// (`tsx scripts/generate-destination-tier.ts`), never on import — this is
// the fix for the round-2 regression (see the PURE SPLIT doc-comment
// above). `process.argv[1]` is undefined in some embedding contexts, hence
// the guard before comparing.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
