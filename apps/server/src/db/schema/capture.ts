/**
 * Capture domain — `capture_inbox` (the visible review queue, R-db-7) and
 * `capture_senders` (verified sender addresses, capture spec R-cap-3)
 * (schema spec §3.3.16, §3.3.27).
 */
import type { ProposedBooking } from "@gogo/shared/domains/capture";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { captureSource, parseStatus } from "./enums.js";
import { timestamps } from "./_shared.js";
import { users } from "./identity.js";
import { trips } from "./trips.js";

export const captureInbox = pgTable(
  "capture_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** NULL until inferred/assigned at review. */
    tripId: uuid("trip_id").references(() => trips.id, { onDelete: "set null" }),
    source: captureSource("source").notNull(),
    /**
     * Object-storage key of the raw payload. NOT NULL at ingest (app-enforced);
     * set NULL when the raw object is purged — on landing or at 30 days,
     * whichever comes first (R-db-22).
     */
    rawRef: text("raw_ref"),
    parseStatus: parseStatus("parse_status").notNull().default("pending"),
    parsed: jsonb("parsed").$type<ProposedBooking>(),
    /** Failure reason, user-visible in the review queue (R-db-7). */
    error: text("error"),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // The review-queue query ("your captures needing review").
    index("capture_inbox_user_parse_status_idx").on(t.userId, t.parseStatus),
    index("capture_inbox_trip_id_idx").on(t.tripId),
  ],
);

export const captureSenders = pgTable(
  "capture_senders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /**
     * ≥128-bit entropy, URL-safe (R-db-9 precedent). Stored plaintext
     * DELIBERATELY (unique lookup from the verification link): defense is
     * entropy + single-use verification, not hash-at-rest. Hashing is an
     * additive later migration if the threat model tightens.
     */
    verificationToken: text("verification_token").notNull().unique(),
    /** NULL = pending; only verified rows participate in sender matching. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique("capture_senders_user_email_uq").on(t.userId, t.email),
    check("capture_senders_email_lower_ck", sql`${t.email} = lower(${t.email})`),
  ],
);
