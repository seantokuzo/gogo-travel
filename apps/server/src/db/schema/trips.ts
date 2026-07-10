/**
 * Trips domain — `trips`, `trip_members`, `invites`
 * (schema spec §3.3.4–§3.3.6).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tripMemberRole, tripStatus } from "./enums.js";
import { timestamps } from "./_shared.js";
import { users } from "./identity.js";

export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    destinationName: text("destination_name").notNull(),
    destinationLat: numeric("destination_lat", { precision: 9, scale: 6 }).notNull(),
    destinationLng: numeric("destination_lng", { precision: 9, scale: 6 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: tripStatus("status").notNull().default("planning"),
    /** Manual override; wins until cleared (R-db-19). Owner-only write. */
    statusOverride: tripStatus("status_override"),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("USD"),
    /** Optional overall trip cap in `base_currency`; NULL = no overall cap. */
    budgetCapCents: bigint("budget_cap_cents", { mode: "number" }),
    theme: text("theme"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    index("trips_created_by_idx").on(t.createdBy),
    check("trips_dates_ck", sql`${t.startDate} <= ${t.endDate}`),
    check("trips_base_currency_upper_ck", sql`${t.baseCurrency} = upper(${t.baseCurrency})`),
    check("trips_budget_cap_nonnegative_ck", sql`${t.budgetCapCents} >= 0`),
  ],
);

export const tripMembers = pgTable(
  "trip_members",
  {
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: tripMemberRole("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tripId, t.userId] }),
    // At most one owner per trip (R-db-8); at-least-one enforced server-side.
    uniqueIndex("uq_trip_single_owner")
      .on(t.tripId)
      .where(sql`${t.role} = 'owner'`),
    // "My trips" is the app's root query.
    index("trip_members_user_id_idx").on(t.userId),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /** ≥128-bit entropy, URL-safe (R-db-9); generation is the API layer's. */
    token: text("token").notNull().unique(),
    role: tripMemberRole("role").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Application-supplied on create (default now() + 7 days; adjustable). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("invites_trip_id_idx").on(t.tripId),
    index("invites_created_by_idx").on(t.createdBy),
    // Invites grant editor/viewer only (§3.2 trip_member_role note).
    check("invites_role_not_owner_ck", sql`${t.role} <> 'owner'`),
    check("invites_max_uses_positive_ck", sql`${t.maxUses} > 0`),
  ],
);
