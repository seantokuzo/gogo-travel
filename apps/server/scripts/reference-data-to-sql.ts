/**
 * Emits the seed INSERT statements for the committed reference dataset
 * (B-9), for inclusion in a drizzle migration:
 *
 *   pnpm --filter @gogo/server exec tsx scripts/reference-data-to-sql.ts > /tmp/seed.sql
 *
 * PURE + DETERMINISTIC: reads `reference-data/*.json`, writes SQL to stdout —
 * no network, no DB. Reviewers can re-run it and diff against the seed tail
 * of the migration that shipped it. Statements are chunked (500 rows) and
 * separated by drizzle's `--> statement-breakpoint` marker (journal
 * convention, `breakpoints: true`).
 *
 * A dataset refresh = regenerate the JSON (`generate-reference-data.ts`),
 * re-run this, and ship the output in a NEW migration that deletes+reinserts
 * (Law #6 — never edit a merged migration).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirlineSeed, AirportSeed } from "./generate-reference-data.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "reference-data");
const CHUNK = 500;
const BREAKPOINT = "--> statement-breakpoint";

const sq = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqOrNull = (value: string | null): string => (value === null ? "NULL" : sq(value));

function chunked<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const airports = JSON.parse(readFileSync(join(DATA_DIR, "airports.json"), "utf8")) as AirportSeed[];
const airlines = JSON.parse(readFileSync(join(DATA_DIR, "airlines.json"), "utf8")) as AirlineSeed[];

const statements: string[] = [];

for (const chunk of chunked(airports, CHUNK)) {
  const values = chunk
    .map(
      (a) =>
        `(${sq(a.iata)}, ${sqOrNull(a.icao)}, ${sq(a.name)}, ${sqOrNull(a.city)}, ` +
        `${sqOrNull(a.country)}, ${a.lat}, ${a.lng}, ${sq(a.tz)})`,
    )
    .join(",\n");
  statements.push(
    `INSERT INTO "airports" ("iata", "icao", "name", "city", "country", "lat", "lng", "tz") VALUES\n${values};`,
  );
}

for (const chunk of chunked(airlines, CHUNK)) {
  const values = chunk.map((a) => `(${sq(a.iata)}, ${sq(a.name)})`).join(",\n");
  statements.push(`INSERT INTO "airlines" ("iata", "name") VALUES\n${values};`);
}

process.stdout.write(statements.join(`${BREAKPOINT}\n`) + "\n");
