/**
 * AI domain — `ai_usage`, `ai_cache`, `tour_guide_bundles`, `recaps`
 * (schema spec §3.3.18–§3.3.20, §3.3.26).
 */
import type { Recap } from "@gogo/shared/ai/recap";
import type { TourGuideBundle } from "@gogo/shared/ai/tour-guide";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { aiFeature, bundleStatus } from "./enums.js";
import { createdAt, timestamps } from "./_shared.js";
import { users } from "./identity.js";
import { places } from "./places.js";
import { trips } from "./trips.js";

/**
 * Per user/feature/day counters — caps + kill-switch (ADR-005 seam, R-db-5).
 * Cost is computed at read time from token counts × pricing config in
 * `@gogo/shared` — storing tokens, not dollars, keeps Law #2 clean.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    feature: aiFeature("feature").notNull(),
    /** UTC day. */
    day: date("day").notNull(),
    calls: integer("calls").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    // Single upsert-increment per call.
    primaryKey({ columns: [t.userId, t.feature, t.day] }),
    // Global daily/monthly rollup for the $50 alert / $100 kill-switch job.
    index("ai_usage_day_idx").on(t.day),
  ],
);

/**
 * Destination-keyed response cache, shareable across users (R-db-10) —
 * deliberately NO user_id, NO trip_id. Immutable rows (no `updated_at`).
 */
export const aiCache = pgTable(
  "ai_cache",
  {
    /** `sha256(feature ∥ destination ∥ travel_style ∥ season ∥ schema_version)` — derivation in `@gogo/shared`. */
    cacheKey: text("cache_key").primaryKey(),
    feature: aiFeature("feature").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    model: text("model").notNull(),
    /** Zod-validated structured output (per-feature shapes, contracts spec). */
    payload: jsonb("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Eviction sweep.
    index("ai_cache_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * Per trip+place, Batch-pre-generated at trip creation, offline-downloadable
 * (SmartGuide pattern). Batch API is async (hours).
 */
export const tourGuideBundles = pgTable(
  "tour_guide_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "restrict" }),
    status: bundleStatus("status").notNull().default("pending"),
    content: jsonb("content").$type<TourGuideBundle>(),
    model: text("model"),
    /** Anthropic Batch API id — job reconciliation. */
    batchId: text("batch_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // One bundle per place per trip; also the download-manifest query.
    unique("tour_guide_bundles_trip_place_uq").on(t.tripId, t.placeId),
    index("tour_guide_bundles_place_id_idx").on(t.placeId),
    // Batch-result reconciliation job lookup.
    index("tour_guide_bundles_pending_batch_idx")
      .on(t.batchId)
      .where(sql`${t.status} = 'pending'`),
    check(
      "tour_guide_bundles_ready_content_ck",
      sql`${t.status} <> 'ready' OR ${t.content} IS NOT NULL`,
    ),
  ],
);

/**
 * Post-trip recap persistence — mirrors `tour_guide_bundles` (status + jsonb
 * + batch reconciliation). Generated exactly once per trip when it
 * transitions to `past` (`custom_id` = `recap:{trip_id}`).
 */
export const recaps = pgTable(
  "recaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    status: bundleStatus("status").notNull().default("pending"),
    content: jsonb("content").$type<Recap>(),
    model: text("model"),
    batchId: text("batch_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // One recap per trip.
    unique("recaps_trip_id_uq").on(t.tripId),
    index("recaps_pending_batch_idx")
      .on(t.batchId)
      .where(sql`${t.status} = 'pending'`),
    check("recaps_ready_content_ck", sql`${t.status} <> 'ready' OR ${t.content} IS NOT NULL`),
  ],
);
