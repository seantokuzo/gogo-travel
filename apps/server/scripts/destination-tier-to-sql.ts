/**
 * Emits the seed INSERT statements for the committed bootstrap destination
 * tier (B-7), for inclusion in a drizzle migration:
 *
 *   pnpm --filter @gogo/server exec tsx scripts/destination-tier-to-sql.ts > /tmp/seed.sql
 *
 * PURE + DETERMINISTIC: reads `reference-data/destinations.json`, writes
 * SQL to stdout — no network, no DB. Reviewers can re-run it and diff
 * against the seed tail of the migration that shipped it. Statements are
 * chunked (500 rows) and separated by drizzle's `--> statement-breakpoint`
 * marker (journal convention, `breakpoints: true`) — mirrors
 * `reference-data-to-sql.ts` (B-9) exactly.
 *
 * Every row seeds `places` directly: `source='overture'`, `source_id` = the
 * Overture GERS division id (upsert key, `places_source_source_id_uq`),
 * `category='locality'` (the discriminator — `COARSE_CATEGORY_RULES` has no
 * `locality` rule, so these rows derive `coarse_category='other'` on read;
 * see `reference-data/README.md`), `wiki_ref` from the Wikidata QID where
 * Overture carries one. `created_by` stays NULL (only required when
 * `source='custom'`, `places_custom_created_by_ck`). Plain INSERT, no
 * `ON CONFLICT` — same posture as `reference-data-to-sql.ts` (B-9): exactly-
 * once execution is drizzle's `__drizzle_migrations` tracking table's job,
 * not this SQL's; a real double-apply should throw loud on the unique
 * constraint, not silently no-op.
 *
 * A dataset refresh = regenerate the JSON (`generate-destination-tier.ts`),
 * re-run this, and ship the output in a NEW migration that deletes+reinserts
 * (Law #6 — never edit a merged migration) — same posture as the airports
 * refresh path.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DestinationSeed } from "../src/places/destination-tier-generator.js";

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

const destinations = JSON.parse(
  readFileSync(join(DATA_DIR, "destinations.json"), "utf8"),
) as DestinationSeed[];

const statements: string[] = [];

for (const chunk of chunked(destinations, CHUNK)) {
  const values = chunk
    .map(
      (d) =>
        `('overture', ${sq(d.sourceId)}, ${sq(d.name)}, ${d.lat}, ${d.lng}, 'locality', ${sqOrNull(d.wikiRef)})`,
    )
    .join(",\n");
  statements.push(
    `INSERT INTO "places" ("source", "source_id", "name", "lat", "lng", "category", "wiki_ref") VALUES\n${values};`,
  );
}

process.stdout.write(statements.join(`${BREAKPOINT}\n`) + "\n");
