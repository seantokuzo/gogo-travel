// Generates apps/mobile/src/features/itinerary/add-edit/time-zone-catalog.data.ts
// from the local tzdb `zone.tab` (IANA Time Zone Database, public domain).
// Usage: node apps/mobile/scripts/gen-time-zone-catalog.mjs <target-file>
// Re-run + diff to verify the committed catalog (dev-machine only; never at
// build or runtime).
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const rows = readFileSync("/usr/share/zoneinfo/zone.tab", "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const cols = line.split("\t");
    return { country: cols[0], id: cols[2] };
  })
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

for (const row of rows) {
  // Every id must resolve under ICU (the platform Intl the app runs on).
  new Intl.DateTimeFormat("en-US", { timeZone: row.id });
}

const lines = rows.map((r) => `  ["${r.id}", "${r.country}"],`);
const out = `/**
 * GENERATED — do not hand-edit. Source: tzdb \`zone.tab\` (IANA Time Zone
 * Database, public domain) as shipped at /usr/share/zoneinfo on the
 * generating machine, one row per canonical zone with its ISO 3166-1
 * alpha-2 country. Regenerate + diff:
 * \`node apps/mobile/scripts/gen-time-zone-catalog.mjs <this file>\` (the
 * transform is \`cut -f1,3 zone.tab | sort -k2\`). ${rows.length} zones.
 *
 * NOT derived from the airport seed's tz column (that column is ODbL-flagged
 * — apps/server/reference-data/README.md); this list is tzdb's own
 * enumeration. Every seeded airport zone is a member (pinned in
 * time-zone-catalog.test.ts against the shared hostile fixtures' zones).
 */
export const TIME_ZONE_CATALOG_DATA: readonly (readonly [id: string, country: string])[] = [
${lines.join("\n")}
];
`;
const target = process.argv[2];
if (target === undefined) {
  process.stderr.write("usage: gen-time-zone-catalog.mjs <target-file>\n");
  process.exit(1);
}
writeFileSync(target, out);
process.stdout.write(`wrote ${target} (${rows.length} zones)\n`);
