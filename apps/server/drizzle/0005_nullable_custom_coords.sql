-- B-7 part 3: nullable coordinates for custom places.
--
-- REVERSE PATH (round-1 fix — the PR body's original draft below was WRONG
-- and has been corrected; no down-migration convention exists in this repo,
-- so this is documentation, not runnable tooling):
--
-- `UPDATE ... SET lat = 0, lng = 0 WHERE lat IS NULL` is NOT a valid
-- reverse, even restricted to `source = 'custom'` rows. It RE-MINTS the
-- exact bug this migration fixes: every custom place created (or cleared
-- via `PATCH /places/:placeId`) AFTER this migration with genuinely no
-- coordinates would be silently relabeled as sitting at Null Island —
-- indistinguishable from a real place someone picked there. The original
-- part-2 backfill above is a ONE-TIME, migration-time operation over rows
-- that predate this feature; it has no post-hoc inverse, because after this
-- ships "coordinates are NULL" stops meaning "this row predates the
-- feature" and starts meaning "the user genuinely hasn't set any."
--
-- The HONEST reverse: re-add NOT NULL only after every affected row
-- carries real coordinates — i.e. the rollback is gated on a precondition,
-- not a mechanical inverse of the backfill.
--   1. Find what would violate NOT NULL:
--        SELECT id FROM places WHERE source = 'custom' AND lat IS NULL;
--        SELECT id FROM trips WHERE destination_lat IS NULL;
--   2. For every row that finds, get a REAL coordinate (a map-drop via
--      `PATCH /places/:placeId`, or delete the row) — there is no
--      automatic, information-preserving way to do this; it is exactly the
--      unknown information nullability exists to hold.
--   3. Only once both queries in step 1 return zero rows:
--        ALTER TABLE "places" DROP CONSTRAINT "places_coords_pair_ck";
--        ALTER TABLE "places" DROP CONSTRAINT "places_spine_coords_ck";
--        ALTER TABLE "trips" DROP CONSTRAINT "trips_destination_coords_pair_ck";
--        ALTER TABLE "places" ALTER COLUMN "lat" SET NOT NULL;
--        ALTER TABLE "places" ALTER COLUMN "lng" SET NOT NULL;
--        ALTER TABLE "trips" ALTER COLUMN "destination_lat" SET NOT NULL;
--        ALTER TABLE "trips" ALTER COLUMN "destination_lng" SET NOT NULL;
--
-- If any row can never get a real coordinate (an abandoned custom place),
-- the rollback is blocked on deleting it — that is the accurate, if
-- unsatisfying, answer, not a reason to fabricate (0,0).
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
