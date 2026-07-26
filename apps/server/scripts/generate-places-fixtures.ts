/**
 * Regenerates the committed GeoParquet fixtures for the T-6.4 ingest suite:
 *
 *   pnpm --filter @gogo/server exec tsx scripts/generate-places-fixtures.ts
 *
 * The fixtures mirror the REAL source column layouts (places spec §3.1.4
 * step 2; the reader's per-source SQL is exercised against realistic
 * shapes): Overture = nested `names`/`categories`/`bbox` structs; FSQ OS =
 * flat lat/lng + a category-label list. Tiny (a handful of rows around
 * Lisbon, T-6.1's canonical destination), deterministic, committed — tests
 * never touch the network (Law #5-compatible CI).
 *
 * Row inventory + the expected ingest outcomes live in
 * `src/places/region-ingest.db.test.ts` — change either side in lockstep.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "places",
  "__fixtures__",
);

function sq(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface OvertureRow {
  id: string;
  /** null exercises the normalize-drop path. `́`-style NFD names prove NFC. */
  name: string | null;
  category: string | null;
  lat: number;
  lng: number;
}

// Center cell r:77:-19 (lat [38.5,39), lng [-9.5,-9)) unless noted.
const OVERTURE_ROWS: OvertureRow[] = [
  // NFD on purpose ("Bele" + combining acute) — ingest must store NFC.
  { id: "ovt-belem-tower", name: "Belém Tower", category: "tourist_attraction", lat: 38.6916, lng: -9.216 },
  // Cross-source dedup anchor (see fsq-time-out below).
  { id: "ovt-time-out-market", name: "Time Out Market Lisboa", category: "food_court", lat: 38.70673, lng: -9.14592 },
  { id: "ovt-castelo", name: "Castelo de São Jorge", category: "castle", lat: 38.7139, lng: -9.1335 },
  { id: "ovt-null-category", name: "Miradouro da Senhora do Monte", category: null, lat: 38.7184, lng: -9.1307 },
  // East-neighbor cell r:77:-18.
  { id: "ovt-setubal", name: "Livraria Culsete", category: "bookstore", lat: 38.5243, lng: -8.8926 },
  // Porto — OUTSIDE the 9-cell destination coverage; must never ingest.
  { id: "ovt-porto", name: "Livraria Lello", category: "bookstore", lat: 41.1469, lng: -8.6147 },
  // Normalize-drop rows (inside the center cell, so the bbox filter passes).
  { id: "ovt-blank-name", name: "   ", category: "landmark", lat: 38.7, lng: -9.2 },
  { id: "ovt-null-name", name: null, category: "landmark", lat: 38.701, lng: -9.201 },
];

interface FsqRow {
  id: string;
  name: string | null;
  labels: string[] | null;
  lat: number;
  lng: number;
}

const FSQ_ROWS: FsqRow[] = [
  // DUPLICATE of ovt-time-out-market: ~3 m away, trigram similarity ≈ 0.70
  // ≥ 0.6 → skipped by cross-source dedup (R-places-3).
  { id: "fsq-time-out", name: "Time Out Market", labels: ["Dining and Drinking > Food Hall"], lat: 38.70671, lng: -9.1459 },
  // NFD again — FSQ side of the NFC rule.
  { id: "fsq-pasteis", name: "Pastéis de Belém", labels: ["Dining and Drinking > Bakery"], lat: 38.69745, lng: -9.2032 },
  // ~6 m from the Time Out anchor but name-dissimilar → NOT a dupe
  // (proves the similarity half of the predicate matters).
  { id: "fsq-ribeira", name: "Mercado da Ribeira", labels: ["Retail > Market"], lat: 38.70668, lng: -9.14588 },
  // Same-name venue ~5 km away → NOT a dupe (proves the distance half).
  { id: "fsq-timeout-far", name: "Time Out Market", labels: ["Dining and Drinking > Food Hall"], lat: 38.75, lng: -9.1 },
  // Normalize-drop: empty name (passes the SQL bbox filter first).
  { id: "fsq-empty-name", name: "", labels: ["Landmarks"], lat: 38.705, lng: -9.15 },
  // East-neighbor cell r:77:-18.
  { id: "fsq-setubal-cafe", name: "Café Central Setúbal", labels: ["Dining and Drinking > Cafe"], lat: 38.525, lng: -8.89 },
  // NULL label list → category NULL.
  { id: "fsq-null-cats", name: "Jardim da Estrela", labels: null, lat: 38.7135, lng: -9.1604 },
];

function overtureValues(row: OvertureRow): string {
  const name = row.name === null ? "CAST(NULL AS VARCHAR)" : sq(row.name);
  const category = row.category === null ? "CAST(NULL AS VARCHAR)" : sq(row.category);
  const bbox = `{'xmin': ${row.lng}::FLOAT, 'xmax': ${row.lng}::FLOAT, 'ymin': ${row.lat}::FLOAT, 'ymax': ${row.lat}::FLOAT}`;
  return `(${sq(row.id)}, {'primary': ${name}}, {'primary': ${category}}, ${bbox})`;
}

function fsqValues(row: FsqRow): string {
  const name = row.name === null ? "CAST(NULL AS VARCHAR)" : sq(row.name);
  const labels =
    row.labels === null
      ? "CAST(NULL AS VARCHAR[])"
      : `[${row.labels.map((label) => sq(label)).join(", ")}]`;
  return `(${sq(row.id)}, ${name}, ${row.lat}::DOUBLE, ${row.lng}::DOUBLE, ${labels})`;
}

async function main(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  const overturePath = join(FIXTURES_DIR, "overture-places.parquet");
  await connection.run(`
    copy (
      select * from (values
        ${OVERTURE_ROWS.map(overtureValues).join(",\n        ")}
      ) as t(id, names, categories, bbox)
    ) to ${sq(overturePath)} (format parquet)
  `);

  const fsqPath = join(FIXTURES_DIR, "fsq-os-places.parquet");
  await connection.run(`
    copy (
      select * from (values
        ${FSQ_ROWS.map(fsqValues).join(",\n        ")}
      ) as t(fsq_place_id, name, latitude, longitude, fsq_category_labels)
    ) to ${sq(fsqPath)} (format parquet)
  `);

  // Failure-path fixture: not parquet at all (R-places-4 test input).
  writeFileSync(join(FIXTURES_DIR, "corrupt.parquet"), "this is not a parquet file\n");

  connection.closeSync();
  instance.closeSync();
  // eslint-disable-next-line no-console -- generator summary for the operator
  console.log(`fixtures written to ${FIXTURES_DIR}`);
}

await main();
