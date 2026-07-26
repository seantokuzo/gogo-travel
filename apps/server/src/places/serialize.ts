/**
 * Row → wire serialization for the places surface (T-6.5 / PL-2). Responses
 * are shaped, never raw DB rows (server rule). `coarse_category` is DERIVED
 * here at the boundary via the shared §3.2.3 mapping — it is not a DB column
 * (`places.category` stays the raw source-taxonomy string). `numeric`
 * coordinates arrive as STRINGS (db/schema/_shared.ts) and convert here.
 */
import { coarseCategory, type Place } from "@gogo/shared/domains/place";
import type * as schema from "../db/schema/index.js";

export type PlaceRow = typeof schema.places.$inferSelect;

export function toPlaceWire(row: PlaceRow): Place {
  return {
    id: row.id,
    source: row.source,
    source_id: row.sourceId,
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    category: row.category,
    coarse_category: coarseCategory(row.source, row.category),
    wiki_ref: row.wikiRef,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
