-- pg_trgm powers places_name_trgm_idx (type-ahead spine search, schema spec §3.3.7).
-- Hand-prepended: drizzle-kit does not manage extensions (baseline migration, R-db-12).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."ai_feature" AS ENUM('recommendations', 'expense_estimate', 'tour_guide', 'packing_list', 'recap', 'capture_parse');--> statement-breakpoint
CREATE TYPE "public"."booking_category" AS ENUM('lodging', 'flight', 'train', 'car_rental', 'moped_rental', 'activity', 'restaurant', 'other');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('manual', 'email', 'share', 'deeplink_return');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('idea', 'planned', 'booked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."bundle_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."capture_source" AS ENUM('email', 'share');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('passport', 'visa', 'insurance', 'other');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('lodging', 'transport', 'food', 'activities', 'shopping', 'other');--> statement-breakpoint
CREATE TYPE "public"."itinerary_item_kind" AS ENUM('booking', 'place_visit', 'custom');--> statement-breakpoint
CREATE TYPE "public"."parse_status" AS ENUM('pending', 'parsed', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."photo_visibility" AS ENUM('private', 'trip', 'public');--> statement-breakpoint
CREATE TYPE "public"."place_source" AS ENUM('overture', 'fsq_os', 'custom');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free');--> statement-breakpoint
CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('open', 'settled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."settlement_method" AS ENUM('venmo', 'cashapp', 'paypal', 'zelle', 'cash');--> statement-breakpoint
CREATE TYPE "public"."travel_mode" AS ENUM('driving', 'walking', 'cycling', 'transit');--> statement-breakpoint
CREATE TYPE "public"."trip_member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('planning', 'active', 'past');--> statement-breakpoint
CREATE TABLE "entitlements" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" "push_platform" NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_key" text,
	"apple_sub" text,
	"google_sub" text,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"venmo_username" text,
	"cashtag" text,
	"paypalme_username" text,
	"zelle_handle" text,
	"zelle_display_name" text,
	"forward_email_slug" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_apple_sub_unique" UNIQUE("apple_sub"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_forward_email_slug_unique" UNIQUE("forward_email_slug"),
	CONSTRAINT "users_identity_or_scrubbed_ck" CHECK ("users"."deleted_at" IS NOT NULL OR "users"."apple_sub" IS NOT NULL OR "users"."google_sub" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "apple_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_name" text,
	"platform" "push_platform" NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"token" text NOT NULL,
	"role" "trip_member_role" NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_unique" UNIQUE("token"),
	CONSTRAINT "invites_role_not_owner_ck" CHECK ("invites"."role" <> 'owner'),
	CONSTRAINT "invites_max_uses_positive_ck" CHECK ("invites"."max_uses" > 0)
);
--> statement-breakpoint
CREATE TABLE "trip_members" (
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "trip_member_role" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_members_trip_id_user_id_pk" PRIMARY KEY("trip_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"destination_name" text NOT NULL,
	"destination_lat" numeric(9, 6) NOT NULL,
	"destination_lng" numeric(9, 6) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "trip_status" DEFAULT 'planning' NOT NULL,
	"status_override" "trip_status",
	"base_currency" char(3) DEFAULT 'USD' NOT NULL,
	"budget_cap_cents" bigint,
	"theme" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_dates_ck" CHECK ("trips"."start_date" <= "trips"."end_date"),
	CONSTRAINT "trips_base_currency_upper_ck" CHECK ("trips"."base_currency" = upper("trips"."base_currency")),
	CONSTRAINT "trips_budget_cap_nonnegative_ck" CHECK ("trips"."budget_cap_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "place_ingest_regions" (
	"region_key" text NOT NULL,
	"source" "place_source" NOT NULL,
	"min_lat" numeric(9, 6) NOT NULL,
	"min_lng" numeric(9, 6) NOT NULL,
	"max_lat" numeric(9, 6) NOT NULL,
	"max_lng" numeric(9, 6) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"ingested_at" timestamp with time zone,
	"row_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_ingest_regions_region_key_source_pk" PRIMARY KEY("region_key","source")
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "place_source" NOT NULL,
	"source_id" text,
	"name" text NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"category" text,
	"wiki_ref" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "places_custom_source_id_ck" CHECK (("places"."source" = 'custom') = ("places"."source_id" IS NULL)),
	CONSTRAINT "places_custom_created_by_ck" CHECK ("places"."source" <> 'custom' OR "places"."created_by" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "saved_places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_places_trip_place_uq" UNIQUE("trip_id","place_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"category" "booking_category" NOT NULL,
	"status" "booking_status" DEFAULT 'idea' NOT NULL,
	"title" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"price_cents" bigint,
	"currency" char(3),
	"confirmation_code" text,
	"source" "booking_source" DEFAULT 'manual' NOT NULL,
	"capture_id" uuid,
	"place_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_time_order_ck" CHECK ("bookings"."starts_at" IS NULL OR "bookings"."ends_at" IS NULL OR "bookings"."starts_at" <= "bookings"."ends_at"),
	CONSTRAINT "bookings_price_nonnegative_ck" CHECK ("bookings"."price_cents" >= 0),
	CONSTRAINT "bookings_price_currency_ck" CHECK ("bookings"."price_cents" IS NULL OR "bookings"."currency" IS NOT NULL),
	CONSTRAINT "bookings_currency_upper_ck" CHECK ("bookings"."currency" = upper("bookings"."currency"))
);
--> statement-breakpoint
CREATE TABLE "itinerary_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"kind" "itinerary_item_kind" NOT NULL,
	"booking_id" uuid,
	"place_id" uuid,
	"title" text,
	"notes" text,
	"day" date NOT NULL,
	"end_day" date,
	"start_time" time,
	"end_time" time,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "itinerary_items_end_day_ck" CHECK ("itinerary_items"."end_day" IS NULL OR "itinerary_items"."end_day" >= "itinerary_items"."day"),
	CONSTRAINT "itinerary_items_booking_kind_ck" CHECK ("itinerary_items"."kind" <> 'booking' OR "itinerary_items"."booking_id" IS NOT NULL),
	CONSTRAINT "itinerary_items_place_visit_kind_ck" CHECK ("itinerary_items"."kind" <> 'place_visit' OR "itinerary_items"."place_id" IS NOT NULL),
	CONSTRAINT "itinerary_items_custom_title_ck" CHECK ("itinerary_items"."kind" <> 'custom' OR "itinerary_items"."title" IS NOT NULL),
	CONSTRAINT "itinerary_items_booking_only_ck" CHECK ("itinerary_items"."booking_id" IS NULL OR "itinerary_items"."kind" = 'booking')
);
--> statement-breakpoint
CREATE TABLE "travel_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_item_id" uuid NOT NULL,
	"to_item_id" uuid NOT NULL,
	"mode" "travel_mode" NOT NULL,
	"duration_seconds" integer NOT NULL,
	"distance_meters" integer NOT NULL,
	"provider" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "travel_legs_from_to_mode_uq" UNIQUE("from_item_id","to_item_id","mode"),
	CONSTRAINT "travel_legs_not_self_ck" CHECK ("travel_legs"."from_item_id" <> "travel_legs"."to_item_id"),
	CONSTRAINT "travel_legs_duration_nonnegative_ck" CHECK ("travel_legs"."duration_seconds" >= 0),
	CONSTRAINT "travel_legs_distance_nonnegative_ck" CHECK ("travel_legs"."distance_meters" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"category" "expense_category" NOT NULL,
	"cap_cents" bigint,
	"ai_estimate_cents" bigint,
	"ai_estimated_at" timestamp with time zone,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_trip_category_uq" UNIQUE("trip_id","category"),
	CONSTRAINT "budgets_cap_nonnegative_ck" CHECK ("budgets"."cap_cents" >= 0),
	CONSTRAINT "budgets_ai_estimate_nonnegative_ck" CHECK ("budgets"."ai_estimate_cents" >= 0),
	CONSTRAINT "budgets_currency_upper_ck" CHECK ("budgets"."currency" = upper("budgets"."currency"))
);
--> statement-breakpoint
CREATE TABLE "expense_shares" (
	"expense_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"share_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_shares_expense_id_user_id_pk" PRIMARY KEY("expense_id","user_id"),
	CONSTRAINT "expense_shares_nonnegative_ck" CHECK ("expense_shares"."share_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"description" text NOT NULL,
	"category" "expense_category" NOT NULL,
	"paid_by" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"fx_rate" numeric(18, 8),
	"base_amount_cents" bigint,
	"booking_id" uuid,
	"spent_at" date DEFAULT CURRENT_DATE NOT NULL,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_positive_ck" CHECK ("expenses"."amount_cents" > 0),
	CONSTRAINT "expenses_currency_upper_ck" CHECK ("expenses"."currency" = upper("expenses"."currency")),
	CONSTRAINT "expenses_fx_pair_ck" CHECK (("expenses"."fx_rate" IS NULL) = ("expenses"."base_amount_cents" IS NULL)),
	CONSTRAINT "expenses_deleted_pair_ck" CHECK (("expenses"."deleted_at" IS NULL) = ("expenses"."deleted_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "settlement_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"note" text,
	"status" "request_status" DEFAULT 'open' NOT NULL,
	"settlement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_requests_not_self_ck" CHECK ("settlement_requests"."from_user_id" <> "settlement_requests"."to_user_id"),
	CONSTRAINT "settlement_requests_amount_positive_ck" CHECK ("settlement_requests"."amount_cents" > 0),
	CONSTRAINT "settlement_requests_currency_upper_ck" CHECK ("settlement_requests"."currency" = upper("settlement_requests"."currency"))
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"method" "settlement_method" NOT NULL,
	"note" text,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_not_self_ck" CHECK ("settlements"."from_user_id" <> "settlements"."to_user_id"),
	CONSTRAINT "settlements_amount_positive_ck" CHECK ("settlements"."amount_cents" > 0),
	CONSTRAINT "settlements_currency_upper_ck" CHECK ("settlements"."currency" = upper("settlements"."currency"))
);
--> statement-breakpoint
CREATE TABLE "capture_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"trip_id" uuid,
	"source" "capture_source" NOT NULL,
	"raw_ref" text,
	"parse_status" "parse_status" DEFAULT 'pending' NOT NULL,
	"parsed" jsonb,
	"error" text,
	"parsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_senders_verification_token_unique" UNIQUE("verification_token"),
	CONSTRAINT "capture_senders_user_email_uq" UNIQUE("user_id","email"),
	CONSTRAINT "capture_senders_email_lower_ck" CHECK ("capture_senders"."email" = lower("capture_senders"."email"))
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"taken_at" timestamp with time zone,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"place_id" uuid,
	"itinerary_item_id" uuid,
	"visibility" "photo_visibility" DEFAULT 'private' NOT NULL,
	"caption" text,
	"blurhash" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photos_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "ai_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"feature" "ai_feature" NOT NULL,
	"schema_version" integer NOT NULL,
	"model" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"user_id" uuid NOT NULL,
	"feature" "ai_feature" NOT NULL,
	"day" date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_user_id_feature_day_pk" PRIMARY KEY("user_id","feature","day")
);
--> statement-breakpoint
CREATE TABLE "recaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"status" "bundle_status" DEFAULT 'pending' NOT NULL,
	"content" jsonb,
	"model" text,
	"batch_id" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recaps_trip_id_uq" UNIQUE("trip_id"),
	CONSTRAINT "recaps_ready_content_ck" CHECK ("recaps"."status" <> 'ready' OR "recaps"."content" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tour_guide_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"status" "bundle_status" DEFAULT 'pending' NOT NULL,
	"content" jsonb,
	"model" text,
	"batch_id" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tour_guide_bundles_trip_place_uq" UNIQUE("trip_id","place_id"),
	CONSTRAINT "tour_guide_bundles_ready_content_ck" CHECK ("tour_guide_bundles"."status" <> 'ready' OR "tour_guide_bundles"."content" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"trip_id" uuid,
	"kind" "document_kind" NOT NULL,
	"title" text NOT NULL,
	"storage_key" text,
	"expires_at" date,
	"remind_days_before" integer,
	"last_reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_remind_days_positive_ck" CHECK ("documents"."remind_days_before" > 0)
);
--> statement-breakpoint
CREATE TABLE "packing_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" uuid,
	"title" text DEFAULT 'Packing list' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weather_cache" (
	"location_key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_credentials" ADD CONSTRAINT "apple_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_capture_id_capture_inbox_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."capture_inbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_legs" ADD CONSTRAINT "travel_legs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_legs" ADD CONSTRAINT "travel_legs_from_item_id_itinerary_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."itinerary_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_legs" ADD CONSTRAINT "travel_legs_to_item_id_itinerary_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."itinerary_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_requests" ADD CONSTRAINT "settlement_requests_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_requests" ADD CONSTRAINT "settlement_requests_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_requests" ADD CONSTRAINT "settlement_requests_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_requests" ADD CONSTRAINT "settlement_requests_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_inbox" ADD CONSTRAINT "capture_inbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_inbox" ADD CONSTRAINT "capture_inbox_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_senders" ADD CONSTRAINT "capture_senders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_itinerary_item_id_itinerary_items_id_fk" FOREIGN KEY ("itinerary_item_id") REFERENCES "public"."itinerary_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recaps" ADD CONSTRAINT "recaps_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_guide_bundles" ADD CONSTRAINT "tour_guide_bundles_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_guide_bundles" ADD CONSTRAINT "tour_guide_bundles_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_lists" ADD CONSTRAINT "packing_lists_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_lists" ADD CONSTRAINT "packing_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_tokens_user_id_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "invites_trip_id_idx" ON "invites" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "invites_created_by_idx" ON "invites" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trip_single_owner" ON "trip_members" USING btree ("trip_id") WHERE "trip_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "trip_members_user_id_idx" ON "trip_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trips_created_by_idx" ON "trips" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "places_source_source_id_uq" ON "places" USING btree ("source","source_id") WHERE "places"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "places_lat_lng_idx" ON "places" USING btree ("lat","lng");--> statement-breakpoint
CREATE INDEX "places_name_trgm_idx" ON "places" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "places_created_by_idx" ON "places" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "saved_places_place_id_idx" ON "saved_places" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "saved_places_created_by_idx" ON "saved_places" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "bookings_trip_starts_at_idx" ON "bookings" USING btree ("trip_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_trip_status_idx" ON "bookings" USING btree ("trip_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_capture_id_uq" ON "bookings" USING btree ("capture_id") WHERE "bookings"."capture_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bookings_place_id_idx" ON "bookings" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "bookings_created_by_idx" ON "bookings" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "itinerary_items_trip_day_sort_idx" ON "itinerary_items" USING btree ("trip_id","day","sort_order");--> statement-breakpoint
CREATE INDEX "itinerary_items_booking_id_idx" ON "itinerary_items" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "itinerary_items_place_id_idx" ON "itinerary_items" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "itinerary_items_created_by_idx" ON "itinerary_items" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "travel_legs_trip_id_idx" ON "travel_legs" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "travel_legs_to_item_id_idx" ON "travel_legs" USING btree ("to_item_id");--> statement-breakpoint
CREATE INDEX "expense_shares_user_id_idx" ON "expense_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "expenses_trip_spent_at_idx" ON "expenses" USING btree ("trip_id","spent_at");--> statement-breakpoint
CREATE INDEX "expenses_paid_by_idx" ON "expenses" USING btree ("paid_by");--> statement-breakpoint
CREATE INDEX "expenses_booking_id_idx" ON "expenses" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "expenses_created_by_idx" ON "expenses" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "expenses_deleted_by_idx" ON "expenses" USING btree ("deleted_by");--> statement-breakpoint
CREATE INDEX "settlement_requests_trip_status_idx" ON "settlement_requests" USING btree ("trip_id","status");--> statement-breakpoint
CREATE INDEX "settlement_requests_from_user_id_idx" ON "settlement_requests" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "settlement_requests_to_user_id_idx" ON "settlement_requests" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "settlement_requests_settlement_id_idx" ON "settlement_requests" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "settlements_trip_id_idx" ON "settlements" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "settlements_from_user_id_idx" ON "settlements" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "settlements_to_user_id_idx" ON "settlements" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "settlements_created_by_idx" ON "settlements" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "capture_inbox_user_parse_status_idx" ON "capture_inbox" USING btree ("user_id","parse_status");--> statement-breakpoint
CREATE INDEX "capture_inbox_trip_id_idx" ON "capture_inbox" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "photos_trip_place_idx" ON "photos" USING btree ("trip_id","place_id");--> statement-breakpoint
CREATE INDEX "photos_trip_taken_at_idx" ON "photos" USING btree ("trip_id","taken_at");--> statement-breakpoint
CREATE INDEX "photos_public_place_idx" ON "photos" USING btree ("place_id") WHERE "photos"."visibility" = 'public';--> statement-breakpoint
CREATE INDEX "photos_itinerary_item_id_idx" ON "photos" USING btree ("itinerary_item_id");--> statement-breakpoint
CREATE INDEX "photos_place_id_idx" ON "photos" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "photos_user_id_idx" ON "photos" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_cache_expires_at_idx" ON "ai_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ai_usage_day_idx" ON "ai_usage" USING btree ("day");--> statement-breakpoint
CREATE INDEX "recaps_pending_batch_idx" ON "recaps" USING btree ("batch_id") WHERE "recaps"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tour_guide_bundles_place_id_idx" ON "tour_guide_bundles" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "tour_guide_bundles_pending_batch_idx" ON "tour_guide_bundles" USING btree ("batch_id") WHERE "tour_guide_bundles"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_trip_id_idx" ON "documents" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "documents_expires_at_idx" ON "documents" USING btree ("expires_at") WHERE "documents"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "packing_lists_shared_trip_uq" ON "packing_lists" USING btree ("trip_id") WHERE "packing_lists"."user_id" IS NULL;--> statement-breakpoint
CREATE INDEX "packing_lists_trip_id_idx" ON "packing_lists" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "packing_lists_user_id_idx" ON "packing_lists" USING btree ("user_id");