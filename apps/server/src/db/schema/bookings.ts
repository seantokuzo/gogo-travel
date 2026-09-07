/**
 * Bookings domain — `bookings` (schema spec §3.3.9).
 */
import type { BookingDetails } from "@gogo/shared/domains/booking";
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bookingCategory, bookingSource, bookingStatus } from "./enums.js";
import { timestamps } from "./_shared.js";
import { captureInbox } from "./capture.js";
import { users } from "./identity.js";
import { places } from "./places.js";
import { trips } from "./trips.js";

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    category: bookingCategory("category").notNull(),
    status: bookingStatus("status").notNull().default("idea"),
    title: text("title").notNull(),
    /** Per-category shape (§3.4.1), Zod-validated before write (R-db-11). */
    details: jsonb("details")
      .$type<BookingDetails>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Denormalized UTC instant for sorting/legs; display truth is `details`. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** NULL = unknown (ideas often have no price). */
    priceCents: bigint("price_cents", { mode: "number" }),
    currency: char("currency", { length: 3 }),
    confirmationCode: text("confirmation_code"),
    source: bookingSource("source").notNull().default("manual"),
    /** One booking per capture; "capture landed" = this reverse reference exists. */
    captureId: uuid("capture_id").references(() => captureInbox.id, { onDelete: "set null" }),
    /** Map pin (hotel, venue, restaurant). */
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    // Chronological booking list + leg/today-view queries.
    index("bookings_trip_starts_at_idx").on(t.tripId, t.startsAt),
    // "Ideas" vs "booked" tabs.
    index("bookings_trip_status_idx").on(t.tripId, t.status),
    uniqueIndex("bookings_capture_id_uq")
      .on(t.captureId)
      .where(sql`${t.captureId} IS NOT NULL`),
    index("bookings_place_id_idx").on(t.placeId),
    index("bookings_created_by_idx").on(t.createdBy),
    // Instants are ordered, for EVERY category — the schema spec's shape
    // verbatim (`.specs/database/schema.spec.md`, bookings.ends_at).
    // Migration 0001's temporary 12h flight/train widening (B-8, 2026-08-29)
    // is reverted by migration 0003 (2026-09-06) now that B-9 gave the client
    // an airport table with IANA zones: a date-line flight composes real
    // offsets (Tokyo 17:00+09:00 → LAX 10:00-07:00) and its instants are
    // ordered, so no window is needed to admit it. Mirrored as a 400 in
    // `bookings/service.ts` `derivedInstantsOf` — change the two together.
    //
    // Migration 0003 adds this NOT VALID on purpose: rows written DURING the
    // grace hold genuinely inverted instants, and a validating ADD would fail
    // to apply against them. New writes and updates are checked; the
    // grandfathered rows are Sean's to re-enter (never a migration's to
    // rewrite), after which `VALIDATE CONSTRAINT` can promote it.
    check(
      "bookings_time_order_ck",
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.startsAt} <= ${t.endsAt}`,
    ),
    check("bookings_price_nonnegative_ck", sql`${t.priceCents} >= 0`),
    // R-db-13: a non-null price requires a currency.
    check("bookings_price_currency_ck", sql`${t.priceCents} IS NULL OR ${t.currency} IS NOT NULL`),
    check("bookings_currency_upper_ck", sql`${t.currency} = upper(${t.currency})`),
  ],
);
