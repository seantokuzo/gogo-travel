-- B-8 DoD: revert migration 0001's TEMPORARY 12h flight/train inversion grace
-- and restore the strict `starts_at <= ends_at` for every category. B-9 gave
-- the client an airport table with IANA zones, so a date-line flight now
-- composes real offsets (Tokyo 17:00+09:00 -> LAX 10:00-07:00) and its
-- instants are ordered — nothing legitimate needs the window any more.
--
-- HAND-EDITED: `NOT VALID` appended to the ADD (drizzle-kit cannot emit it).
-- Rows written WHILE the grace was live hold genuinely inverted instants (the
-- device-QA Tokyo->LA flight), so a validating ADD CONSTRAINT would abort with
-- 23514 and this migration would never apply to that database. `NOT VALID`
-- checks every new INSERT and every UPDATE while leaving the existing rows
-- unchecked; the migration deletes and rewrites NOTHING (data mutation is a
-- human call). Re-enter the bad bookings, then
-- `ALTER TABLE bookings VALIDATE CONSTRAINT bookings_time_order_ck;`
-- promotes it to fully validated.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_time_order_ck";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_time_order_ck" CHECK ("bookings"."starts_at" IS NULL OR "bookings"."ends_at" IS NULL OR "bookings"."starts_at" <= "bookings"."ends_at") NOT VALID;
