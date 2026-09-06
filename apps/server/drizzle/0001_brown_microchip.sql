ALTER TABLE "bookings" DROP CONSTRAINT "bookings_time_order_ck";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_time_order_ck" CHECK ("bookings"."starts_at" IS NULL OR "bookings"."ends_at" IS NULL OR "bookings"."starts_at" <= "bookings"."ends_at"
        OR ("bookings"."category" IN ('flight', 'train')
            AND "bookings"."ends_at" >= "bookings"."starts_at" - interval '12 hours'));