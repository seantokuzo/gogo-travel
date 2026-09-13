# Transport reference data (B-9)

Processed, committed seed snapshot for the `airports` + `airlines` tables.
Seeded by migration `drizzle/0002_*` (generated from these files by
`scripts/reference-data-to-sql.ts`); the app NEVER downloads reference data at
boot or runtime, and CI never touches the network for it.

| File            | Rows | Contents                                                     |
| --------------- | ---- | ------------------------------------------------------------ |
| `airports.json` | 4133 | IATA, ICAO, name, city, country, lat/lng, IANA tz            |
| `airlines.json` | 893  | IATA airline designator, display name (flight-no. inference) |

Snapshot taken **2026-09-06** by `scripts/generate-reference-data.ts` (run it
to refresh; it self-checks a pin set — NRT/HND/LAX/AKL/PPT/BAH/PPG zones and
NH→All Nippon Airways — and refuses to write a snapshot that breaks one).
**A refresh ships as a NEW migration** (regenerate JSON → emit SQL → new
`drizzle/000N_*.sql` that deletes+reinserts), never as an edit to 0002 and
never as a runtime write (Law #6). Sources/licences below.

---

# Bootstrap destination tier (B-7)

Processed, committed seed snapshot for `places` (`source='overture'`,
`category='locality'`) — the pre-populated city/locality subset the places
spec's destination search has always assumed exists (`.specs/database/
schema.spec.md` §3.3.4, resolved Gate 2 2026-07-09) but was never actually
shipped, which is the B-7 cold-start deadlock: trip create requires a
spine-backed destination pick, but the spine was empty until a trip already
existed (`docs/QUEUE.md` B-7 row). Seeded by migration `drizzle/0004_*`
(generated from `destinations.json` by `scripts/destination-tier-to-sql.ts`);
same $0/no-runtime-network posture as the transport tables above.

| File                | Rows | Contents                                                                                                                    |
| ------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- |
| `destinations.json` | 6927 | Overture GERS id, name (English common name preferred), country, lat/lng, population, is-country-capital flag, Wikidata QID |

Snapshot taken **2026-09-13** by `scripts/generate-destination-tier.ts` (run
it to refresh; it self-checks a name pin set — Athens/Tokyo/Reykjavik/Rome/
Oslo — and a country-capital-count sanity floor, and refuses to write a
snapshot that breaks either). **A refresh ships as a NEW migration**
(regenerate JSON → emit SQL → new `drizzle/000N_*.sql` that
deletes+reinserts), never as an edit to 0004 and never as a runtime write
(Law #6) — same one-time-snapshot posture as the airports/airlines refresh
path (manual regen, no cron; locality boundaries change far slower than
airline schedules).

## Source, licence, provenance ($0 · open data · no account/key)

- [Overture Maps Foundation](https://overturemaps.org) `divisions` theme,
  `division` type, `subtype='locality'` — **NOT** the `places`/POI theme the
  on-demand ingest pipeline (`region-ingest.ts`) reads; a different Overture
  table entirely, so a bootstrap row and a later real POI-grid ingest of the
  same city never collide (different GERS id namespaces).
- **Release pinned: `2026-08-19.0`** (`s3://overturemaps-us-west-2/release/
2026-08-19.0/theme=divisions/type=division/*`, anonymous/unsigned S3 read
  via DuckDB httpfs, verified reachable). Overture ships monthly releases
  with **no `latest` alias** — the pin is deliberate deploy-time config, never
  inferred, same posture as `env.ts`'s own parquet-URL comment.
- **Licence: CDLA-Permissive-2.0** (per-source attribution) — already the
  locked places-spine provider (`places.spec.md` §Attribution); free,
  unmetered, no account (Law #5-safe).
- **Cut (Sean's ruling, 2026-09-13):** `population >= 100,000 OR
is-a-sovereign-country-capital` — 6,927 rows, measured live against this
  exact release. Matches the population≥100k cut almost exactly (6,894
  alone) while the capital-of-country union catches every low/no-
  population-data microstate capital (Nauru, Tuvalu, Vatican, San Marino…) a
  pure population threshold would silently drop. The capital check is
  filtered to `capital_of_divisions[].subtype = 'country'` specifically — an
  unfiltered "any admin capital" cut (county/region seats included) is
  40,971 rows, not what was chosen.
- **Name column:** Overture's `names.primary` is the LOCAL-SCRIPT name
  (e.g. Athens → "Αθήνα", Tokyo → "東京") — unsearchable by an
  English-typing user via the pg_trgm text search this tier exists to serve.
  The generator prefers `names.common['en']` (Overture's per-language name
  map) and falls back to `names.primary` only when no English common name
  exists. This is a **load-bearing interpretation, not a spec line** — flag
  it if a future i18n pass wants locale-aware names.
- **Not persisted to `places`** (the table has no such columns; kept in the
  JSON for documentation/test fixtures only): `country` (ISO 3166-1
  alpha-2), `population`, `isCountryCapital`. Duplicate-named localities
  across countries (e.g. "Athens", GR pop. 3,090,508 vs "Athens", US pop.
  115,452) stay distinguishable by `source_id`/coordinates, same as any two
  spine rows.
- **`wiki_ref`**: Overture's `wikidata` column (Wikidata QID, e.g. `Q1490`
  for Tokyo) — present on this theme, unlike the POI theme
  (`geoparquet-reader.ts` hardcodes `wikiRef: null` there because neither
  open POI source carries one). A free tour-guide-grounding bonus.

### Determinism & verification

- Sorted by `(name, source_id)` — one row per line, reviewable diffs.
- `scripts/destination-tier-to-sql.ts` is a pure function of
  `destinations.json` — the seed statements in the migration can be
  regenerated and diffed at any time.
- `src/places/destination-tier.db.test.ts` re-pins the row count and a
  handful of named cities/search behaviors against the seeded template, so a
  bad regeneration goes red in CI, not in a traveler's search box.

---

## Airports/airlines: sources, licences, provenance ($0 · open data · no accounts/keys)

### `airports.json`

- **Rows/columns**: [OurAirports](https://ourairports.com/data/) daily CSV
  (`davidmegginson.github.io/ourairports-data/airports.csv`). OurAirports data
  is **released into the public domain** (CC0-equivalent; their data page:
  "download the data and use it as you see fit... no permission needed").
  Filter: `scheduled_service = yes`, not `closed`, valid 3-letter IATA code
  (4,133 of ~86k rows). IATA collisions: larger field type wins, then lower
  OurAirports id; ICAO collisions null the later code (both logged by the
  script; the 2026-09-06 snapshot had zero of either).
- **`tz` column**: derived at generation time from lat/lng via
  [`geo-tz`](https://www.npmjs.com/package/geo-tz) `8.1.8` (`geo-tz/all`,
  the comprehensive product — country-specific ids like `Asia/Bahrain`, exact
  polygon lookup). geo-tz **code is MIT**; its polygon data comes from
  [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder)
  (**ODbL**, built from OpenStreetMap data).

  ⚠️ **ODbL flag (share-alike), not silently assumed**: the derived `tz`
  column is plausibly a _derivative database_ of the tz boundary DB. Posture
  taken: attribute here (done — tz values © OpenStreetMap contributors via
  timezone-boundary-builder, ODbL 1.0) and treat this seed file's tz column
  as redistributable under ODbL terms. ODbL permits commercial use; the
  obligations are attribution + making the derived data available under the
  same licence — this committed file _is_ that data. If the app ever ships a
  public data-attribution screen, include "Timezone boundaries © OpenStreetMap
  contributors (ODbL), via timezone-boundary-builder". Escalate before
  building any feature that _redistributes_ the tz column standalone.

  Why not the CC0-licensed `@photostructure/tz-lookup`: measured against exact
  polygons over these 4,133 airports it mislabels 743 (70 with _wrong UTC
  offsets_ — BAH, PPG, OOL, DIL…). Offset-wrong zones are the exact B-8 bug
  class this table exists to kill.

### `airlines.json`

- [Wikidata](https://www.wikidata.org) SPARQL (**CC0 1.0**): entities with an
  IATA airline designator (P229) that are airlines (P31/P279\* Q46970), not
  dissolved (no P576), with a real English label. Designator collisions (IATA
  reuse + controlled duplicates): most Wikidata sitelinks wins (popularity
  proxy), then smallest QID. All-digit designators are excluded — ambiguous
  inside flight-number strings (documented in the shared parser).

## Determinism & verification

- Both files are sorted by `iata`; one row per line for reviewable diffs.
- `scripts/reference-data-to-sql.ts` is a pure function of these files — the
  seed statements in the migration can be regenerated and diffed at any time.
- The server DB suite re-pins the fixture airports/zones against the seeded
  template (`src/reference/routes.db.test.ts`), so a bad regeneration goes
  red in CI, not in a traveler's itinerary.
