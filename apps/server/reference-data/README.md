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
never as a runtime write (Law #6).

## Sources, licences, provenance ($0 · open data · no accounts/keys)

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
