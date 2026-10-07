-- B-30: trips.destination_tz — the IANA zone a trip's "today" is evaluated in
-- (Sean ruling 2026-09-19: the day AT THE DESTINATION, server and client).
--
-- NO BACKFILL, on purpose: legacy rows stay NULL and resolve lazily at read
-- time (booking arrives_tz/departs_tz fallback, then UTC — see
-- apps/server/src/trips/destination-tz.ts). Reads NEVER write the resolved
-- zone back, so the column only ever holds a user-entered or
-- coordinate-derived value. Nullable add + CHECK on a NULL-only column: no
-- table rewrite, no lock beyond the brief ADD COLUMN / ADD CONSTRAINT.
--
-- REVERSE (documentation, not tooling — no down-migrations in this repo):
--   ALTER TABLE "trips" DROP CONSTRAINT "trips_destination_tz_ck";
--   ALTER TABLE "trips" DROP COLUMN "destination_tz";
-- Dropping loses user-entered zones (coordinate-derived ones recompute), so
-- the status rule falls back to the UTC day again until rows are re-derived.
ALTER TABLE "trips" ADD COLUMN "destination_tz" text;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_tz_ck" CHECK ("trips"."destination_tz" IS NULL OR length("trips"."destination_tz") BETWEEN 1 AND 64);
