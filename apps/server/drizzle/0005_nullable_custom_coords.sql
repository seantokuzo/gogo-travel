-- B-7 part 3: nullable coordinates for custom places.
ALTER TABLE "places" ALTER COLUMN "lat" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "lng" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "destination_lat" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "destination_lng" DROP NOT NULL;
--> statement-breakpoint
-- BACKFILL 1: the part-2 placeholder rows. Exactly (0,0) AND custom-sourced.
-- Scope note for the reviewer: no spine row can collide. The 0004
-- destination tier has zero rows at (0,0) (`grep -c ", 0, 0, "
-- 0004_destination_tier_seed.sql` = 0), and the guard below is
-- source-scoped anyway.
UPDATE "places" SET "lat" = NULL, "lng" = NULL
  WHERE "source" = 'custom' AND "lat" = 0 AND "lng" = 0;
--> statement-breakpoint
-- BACKFILL 2: the trips created from them. There is NO link column --
-- `trips` denormalises the coordinates and stores no place id
-- (schema/trips.ts:25-52), so a per-trip join is impossible. The honest
-- backfill is the coordinate value itself: a trip's destination coordinates
-- can ONLY come from a picked place (both write paths -- `new.tsx:289` and
-- `more/settings.tsx:325` -- copy them off `selectedPlace`), and the only
-- pickable place at exactly (0.000000, 0.000000) is a part-2 custom
-- placeholder. A name+creator heuristic was considered and REJECTED: it
-- misses every trip whose name was edited after creation, leaving those
-- trips on the ocean with no null-state UI, which is strictly worse than
-- the blanket rule.
UPDATE "trips" SET "destination_lat" = NULL, "destination_lng" = NULL
  WHERE "destination_lat" = 0 AND "destination_lng" = 0;
--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_coords_pair_ck"
  CHECK (("lat" IS NULL) = ("lng" IS NULL));
--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_spine_coords_ck"
  CHECK ("source" = 'custom' OR "lat" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_coords_pair_ck"
  CHECK (("destination_lat" IS NULL) = ("destination_lng" IS NULL));
