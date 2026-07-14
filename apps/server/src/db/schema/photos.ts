/**
 * Photos domain — `photos` (schema spec §3.3.17).
 *
 * Law #3: visibility is a DB-level boundary — NOT NULL DEFAULT 'private'
 * (R-db-3), and the partial public index makes the privacy-correct
 * cross-user query the cheap one (R-db-4).
 */
import { sql } from "drizzle-orm";
import { index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { photoVisibility } from "./enums.js";
import { timestamps } from "./_shared.js";
import { users } from "./identity.js";
import { itineraryItems } from "./itinerary.js";
import { places } from "./places.js";
import { trips } from "./trips.js";

export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /** Uploader/owner. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull().unique(),
    /** EXIF. */
    takenAt: timestamp("taken_at", { withTimezone: true }),
    /** EXIF GPS — location data, Law #3 applies to every read. */
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    itineraryItemId: uuid("itinerary_item_id").references(() => itineraryItems.id, {
      onDelete: "set null",
    }),
    visibility: photoVisibility("visibility").notNull().default("private"),
    /** Photo + caption IS the whole v1 review surface. */
    caption: text("caption"),
    blurhash: text("blurhash"),
    width: integer("width"),
    height: integer("height"),
    ...timestamps(),
  },
  (t) => [
    // "Photos by place within a trip" (map pin tap → photos).
    index("photos_trip_place_idx").on(t.tripId, t.placeId),
    // Trip timeline/album ordering.
    index("photos_trip_taken_at_idx").on(t.tripId, t.takenAt),
    // Cross-user surface touches ONLY public rows (R-db-4).
    index("photos_public_place_idx")
      .on(t.placeId)
      .where(sql`${t.visibility} = 'public'`),
    index("photos_itinerary_item_id_idx").on(t.itineraryItemId),
    // Blanket §1 FK-index rule: the partial public index can't serve
    // SET NULL scans on place delete (non-public rows aren't in it).
    index("photos_place_id_idx").on(t.placeId),
    index("photos_user_id_idx").on(t.userId),
  ],
);
