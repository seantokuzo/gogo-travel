-- B-30: trips.destination_tz (+ provenance) - the IANA zone a trip's "today" is
-- evaluated in (Sean ruling 2026-09-19: the day AT THE DESTINATION, server and
-- client).
--
-- destination_tz_source records WHICH rung of the resolver chain stored the zone
-- ('user' = a person's choice, 'derived' = computed from destination_lat/lng,
-- 'device' = the creator's device-zone HINT for a coordinate-less destination),
-- so a coordinates edit may re-derive a 'derived'/'device' zone but never
-- overwrites a 'user' one, and a device hint ranks BELOW a booking zone on read.
-- 'booking' and 'default' are read-time sources and are never stored. The two
-- columns move together (pair CHECK): a zone always has a source.
--
-- NO BACKFILL, on purpose: legacy rows stay NULL/NULL and resolve lazily at read
-- time (derive from coordinates, then booking arrives_tz/departs_tz, then the
-- device hint, then UTC - see apps/server/src/trips/destination-tz.ts). Reads
-- NEVER write the resolved zone back, so the columns only ever hold what a
-- person, the derivation or the device hint put there. Nullable ADD COLUMNs +
-- CHECKs over all-NULL columns: no table rewrite, no lock beyond the brief
-- ADD COLUMN / ADD CONSTRAINT.
--
-- REVERSE (documentation, not tooling - no down-migrations in this repo):
--   ALTER TABLE "trips" DROP CONSTRAINT "trips_destination_tz_source_pair_ck";
--   ALTER TABLE "trips" DROP CONSTRAINT "trips_destination_tz_source_ck";
--   ALTER TABLE "trips" DROP CONSTRAINT "trips_destination_tz_ck";
--   ALTER TABLE "trips" DROP COLUMN "destination_tz_source";
--   ALTER TABLE "trips" DROP COLUMN "destination_tz";
-- Dropping loses user-entered zones (derived ones recompute), so the status rule
-- falls back to the UTC day again until rows are re-derived.
ALTER TABLE "trips" ADD COLUMN "destination_tz" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "destination_tz_source" text;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_tz_ck" CHECK ("trips"."destination_tz" IS NULL OR length("trips"."destination_tz") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_tz_source_ck" CHECK ("trips"."destination_tz_source" IS NULL OR "trips"."destination_tz_source" IN ('user', 'derived', 'device'));--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_tz_source_pair_ck" CHECK (("trips"."destination_tz" IS NULL) = ("trips"."destination_tz_source" IS NULL));