/**
 * Itinerary domain — `itinerary_items`, `travel_legs`
 * (schema spec §3.3.10, §3.3.11).
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bookings } from "./bookings.js";
import { itineraryItemKind, travelMode } from "./enums.js";
import { createdAt, timestamps } from "./_shared.js";
import { users } from "./identity.js";
import { places } from "./places.js";
import { trips } from "./trips.js";

export const itineraryItems = pgTable(
  "itinerary_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    kind: itineraryItemKind("kind").notNull(),
    /** Booking removed ⇒ its calendar item goes. */
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "restrict" }),
    /** Required for `custom`; derived from booking/place otherwise. */
    title: text("title"),
    notes: text("notes"),
    /** Trip-local calendar day (wall-date, no tz math). */
    day: date("day").notNull(),
    /** Set for multi-day spanning items (one spanning row — §3.3.10 note). */
    endDay: date("end_day"),
    /** Local wall-time on `day`; NULL = all-day/unscheduled. */
    startTime: time("start_time"),
    endTime: time("end_time"),
    /** Order within a day; app assigns gapped values (1024 steps). */
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    // THE itinerary query (day list and calendar grid read a day/range ordered).
    index("itinerary_items_trip_day_sort_idx").on(t.tripId, t.day, t.sortOrder),
    index("itinerary_items_booking_id_idx").on(t.bookingId),
    index("itinerary_items_place_id_idx").on(t.placeId),
    index("itinerary_items_created_by_idx").on(t.createdBy),
    check("itinerary_items_end_day_ck", sql`${t.endDay} IS NULL OR ${t.endDay} >= ${t.day}`),
    // Kind-shape checks (§3.3.10).
    check(
      "itinerary_items_booking_kind_ck",
      sql`${t.kind} <> 'booking' OR ${t.bookingId} IS NOT NULL`,
    ),
    check(
      "itinerary_items_place_visit_kind_ck",
      sql`${t.kind} <> 'place_visit' OR ${t.placeId} IS NOT NULL`,
    ),
    check("itinerary_items_custom_title_ck", sql`${t.kind} <> 'custom' OR ${t.title} IS NOT NULL`),
    check("itinerary_items_booking_only_ck", sql`${t.bookingId} IS NULL OR ${t.kind} = 'booking'`),
  ],
);

/**
 * Derived data — precomputed at trip sync for offline ETAs. Rebuildable at
 * any time; rows are replaced, not edited (no `updated_at`). App-layer
 * invariant: both items belong to `trip_id` (enforced by the leg-computation
 * job, the only writer).
 */
export const travelLegs = pgTable(
  "travel_legs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    fromItemId: uuid("from_item_id")
      .notNull()
      .references(() => itineraryItems.id, { onDelete: "cascade" }),
    toItemId: uuid("to_item_id")
      .notNull()
      .references(() => itineraryItems.id, { onDelete: "cascade" }),
    mode: travelMode("mode").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    distanceMeters: integer("distance_meters").notNull(),
    /** 'mapbox' / 'transitous' — text, not enum (providers are a moving target). */
    provider: text("provider").notNull(),
    /** Staleness input for the leg-ETA refresh job. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Leg identity (R-db-15).
    unique("travel_legs_from_to_mode_uq").on(t.fromItemId, t.toItemId, t.mode),
    // Offline bundle downloads all legs for a trip in one query.
    index("travel_legs_trip_id_idx").on(t.tripId),
    index("travel_legs_to_item_id_idx").on(t.toItemId),
    check("travel_legs_not_self_ck", sql`${t.fromItemId} <> ${t.toItemId}`),
    check("travel_legs_duration_nonnegative_ck", sql`${t.durationSeconds} >= 0`),
    check("travel_legs_distance_nonnegative_ck", sql`${t.distanceMeters} >= 0`),
  ],
);
