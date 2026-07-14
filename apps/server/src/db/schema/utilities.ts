/**
 * Utilities domain — `packing_lists`, `documents`, `weather_cache`
 * (schema spec §3.3.21–§3.3.23).
 */
import type { PackingItem } from "@gogo/shared/domains/packing";
import type { WeatherForecast } from "@gogo/shared/domains/weather";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { documentKind } from "./enums.js";
import { createdAt, timestamps } from "./_shared.js";
import { users } from "./identity.js";
import { trips } from "./trips.js";

export const packingLists = pgTable(
  "packing_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /** Always NULL in v1 (shared trip list); seam for later per-member lists. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Packing list"),
    /** Items live in JSONB, not a child table; whole-list PATCHes (§3.3.21). */
    items: jsonb("items")
      .$type<PackingItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Seeded from `/ai/packing-list`, then user-edited. */
    aiGenerated: boolean("ai_generated").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    // One shared list per trip (Gate-2 resolution).
    uniqueIndex("packing_lists_shared_trip_uq")
      .on(t.tripId)
      .where(sql`${t.userId} IS NULL`),
    index("packing_lists_trip_id_idx").on(t.tripId),
    index("packing_lists_user_id_idx").on(t.userId),
  ],
);

/**
 * Travel-document vault. Strictly private to the owning user (R-db-18) —
 * `trip_id` is association only and NEVER grants trip members visibility.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tripId: uuid("trip_id").references(() => trips.id, { onDelete: "set null" }),
    kind: documentKind("kind").notNull(),
    title: text("title").notNull(),
    /** Scan/photo object key; NULL = metadata-only reminder entry. */
    storageKey: text("storage_key"),
    expiresAt: date("expires_at"),
    /** NULL = no reminder. */
    remindDaysBefore: integer("remind_days_before"),
    /** Reminder-job dedup. */
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // Vault screen.
    index("documents_user_id_idx").on(t.userId),
    index("documents_trip_id_idx").on(t.tripId),
    // Document-expiry reminder job scans by date.
    index("documents_expires_at_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
    check("documents_remind_days_positive_ck", sql`${t.remindDaysBefore} > 0`),
  ],
);

/**
 * Provider-agnostic forecast cache. One current forecast blob per ~1.1 km
 * cell; refresh = upsert. Immutable shape (no `updated_at`).
 */
export const weatherCache = pgTable("weather_cache", {
  /** `"{lat:.2f},{lng:.2f}"` rounded to 2 dp — derivation in `@gogo/shared`. */
  locationKey: text("location_key").primaryKey(),
  payload: jsonb("payload").$type<WeatherForecast>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  /** Short TTL (hours; config) — volatile, online-refreshed. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
