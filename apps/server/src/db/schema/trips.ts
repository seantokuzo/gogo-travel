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

/**
 * The provenances `trips.destination_tz_source` may hold (B-30). A subset of
 * the wire's effective `DestinationTzSource`: `booking` and `default` are
 * resolved at read time and never stored. Single tuple → the CHECK below and
 * the resolver's `StoredZoneSource` type (R-shared-2 spirit).
 */
export const STORED_DESTINATION_TZ_SOURCES = ["user", "derived", "device"] as const;
export type StoredDestinationTzSource = (typeof STORED_DESTINATION_TZ_SOURCES)[number];

export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    destinationName: text("destination_name").notNull(),
    // NULL when the destination was picked from a coordinate-less custom
    // place (B-7 part 3) — the pair moves together (trips_destination_coords_pair_ck).
    destinationLat: numeric("destination_lat", { precision: 9, scale: 6 }),
    destinationLng: numeric("destination_lng", { precision: 9, scale: 6 }),
    /**
     * IANA zone of the destination (B-30) — the zone a trip's "today" is
     * evaluated in. Written ONLY by a person's choice (`user`), the
     * coordinate derivation (`derived`) or the creator's device-zone hint
     * (`device`) — `trips/destination-tz.ts`. NULL = nothing stored yet
     * (legacy rows, or a coordinate-less destination nobody gave a zone):
     * reads resolve the EFFECTIVE zone lazily (booking `arrives_tz`/
     * `departs_tz`, then UTC) and never write it back.
     */
    destinationTz: text("destination_tz"),
    /**
     * Provenance of `destination_tz` (B-30 zone-provenance decision): which
     * rung of the chain stored it, so a coordinates edit may re-derive a
     * `derived`/`device` zone but must NEVER overwrite a `user` one, and a
     * device hint ranks BELOW a booking zone on read. NULL iff
     * `destination_tz` is NULL (`trips_destination_tz_source_pair_ck`).
     */
    destinationTzSource: text("destination_tz_source"),
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
    // B-7 part 3: coordinates only ever come from a picked place — NULL
    // means the picked place had none (a custom place with no coordinates).
    check(
      "trips_destination_coords_pair_ck",
      sql`(${t.destinationLat} IS NULL) = (${t.destinationLng} IS NULL)`,
    ),
    // B-30: the cap mirrors `TIME_ZONE_ID_MAX_CHARS` (wire schema max).
    check(
      "trips_destination_tz_ck",
      sql`${t.destinationTz} IS NULL OR length(${t.destinationTz}) BETWEEN 1 AND 64`,
    ),
    // B-30 provenance: only the three STORED sources (`booking`/`default` are
    // read-time and never persisted), and the pair moves together — a zone
    // always has a source, a source never floats without a zone.
    check(
      "trips_destination_tz_source_ck",
      sql`${t.destinationTzSource} IS NULL OR ${t.destinationTzSource} IN (${sql.raw(
        STORED_DESTINATION_TZ_SOURCES.map((source) => `'${source}'`).join(", "),
      )})`,
    ),
    check(
      "trips_destination_tz_source_pair_ck",
      sql`(${t.destinationTz} IS NULL) = (${t.destinationTzSource} IS NULL)`,
    ),
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
    /**
     * ≥128-bit entropy, URL-safe (R-db-9); generation is the API layer's.
     * Stored plaintext DELIBERATELY (unique lookup by the invite link): the
     * defense is entropy + `expires_at` + `revoked_at`, not hash-at-rest.
     * Hashing is an additive later migration if the threat model tightens.
     */
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
