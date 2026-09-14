/**
 * Single source of truth for the bootstrap destination-tier row count (B-7,
 * migration `drizzle/0004_destination_tier_seed.sql`) — round-1 review
 * advisory A3: the literal `6927` used to be duplicated across
 * `fresh-install.db.test.ts`, `region-ingest.db.test.ts`, and
 * `destination-tier.db.test.ts`. A dataset refresh (`OVERTURE_RELEASE`
 * bump, `reference-data/README.md`) is a routine deliberate action that
 * changes this number — with three separate literals, the refresh reds
 * nine assertions across suites whose actual subject (upsert/refresh/dedup
 * semantics, first-run emptiness) never changed, and needs three files
 * edited to go green again. One constant, one edit.
 */
export const DESTINATION_TIER_ROW_COUNT = 6927;
