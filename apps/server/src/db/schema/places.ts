/**
 * Places domain — `places` (the open-data spine), `saved_places`,
 * `place_ingest_regions` (schema spec §3.3.7, §3.3.8, §3.3.24).
 *
 * `places` is deliberately minimal: rich/volatile details (hours, ratings,
 * photos) are fetch-fresh from the hosted API and never cached (licensing) —
 * do not add such columns.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { placeSource } from "./enums.js";
import { timestamps } from "./_shared.js";
import { users } from "./identity.js";
import { trips } from "./trips.js";

export const places = pgTable(
  "places",
  {
    /** Our stable id — everything references this, never `source_id`. */
    id: uuid("id").primaryKey().defaultRandom(),
    source: placeSource("source").notNull(),
    /** Upstream id (Overture GERS id / FSQ id); NULL iff `source = 'custom'`. */
    sourceId: text("source_id"),
    name: text("name").notNull(),
    lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
    lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
    category: text("category"),
    /** Wikidata QID preferred (`Q…`); Wikipedia title accepted. */
    wikiRef: text("wiki_ref"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    // Import upsert key (R-db-6).
    uniqueIndex("places_source_source_id_uq")
      .on(t.source, t.sourceId)
      .where(sql`${t.sourceId} IS NOT NULL`),
    // Map viewport bbox queries.
    index("places_lat_lng_idx").on(t.lat, t.lng),
    // Type-ahead search on our spine (pg_trgm, enabled in the initial migration).
    index("places_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("places_created_by_idx").on(t.createdBy),
    check("places_custom_source_id_ck", sql`(${t.source} = 'custom') = (${t.sourceId} IS NULL)`),
    check(
      "places_custom_created_by_ck",
      sql`${t.source} <> 'custom' OR ${t.createdBy} IS NOT NULL`,
    ),
  ],
);

export const savedPlaces = pgTable(
  "saved_places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    // A pinned spine row must not vanish.
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "restrict" }),
    note: text("note"),
    /** Attribution only; nullable so member removal doesn't lose the pin. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    // A place is saved once per trip; also serves the trip's saved-list query.
    unique("saved_places_trip_place_uq").on(t.tripId, t.placeId),
    index("saved_places_place_id_idx").on(t.placeId),
    index("saved_places_created_by_idx").on(t.createdBy),
  ],
);

export const placeIngestRegions = pgTable(
  "place_ingest_regions",
  {
    /** Canonical region-grid key (places spec §3.1.3). */
    regionKey: text("region_key").notNull(),
    source: placeSource("source").notNull(),
    minLat: numeric("min_lat", { precision: 9, scale: 6 }).notNull(),
    minLng: numeric("min_lng", { precision: 9, scale: 6 }).notNull(),
    maxLat: numeric("max_lat", { precision: 9, scale: 6 }).notNull(),
    maxLng: numeric("max_lng", { precision: 9, scale: 6 }).notNull(),
    /** pending / running / ready / failed — text, not enum (job-internal). */
    status: text("status").notNull().default("pending"),
    error: text("error"),
    /** Last success — drives the 90-day refresh window (R-places-5). */
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
    rowCount: integer("row_count"),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.regionKey, t.source] })],
);
