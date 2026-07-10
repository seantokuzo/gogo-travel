/**
 * Places domain — the open-data spine (contracts spec §3.4; schema spec
 * §3.3.7/§3.3.8). Deliberately minimal: rich/volatile details (hours,
 * ratings, photos) are fetch-fresh and never persisted (licensing).
 */
import { z } from "zod";
import { PlaceSourceSchema } from "../enums.js";
import { ISODateTimeSchema, LatSchema, LngSchema, UuidSchema } from "../scalars.js";

export const PlaceSchema = z
  .object({
    /** Our stable id — everything references this, never `source_id`. */
    id: UuidSchema,
    source: PlaceSourceSchema,
    /** Upstream id (Overture GERS / FSQ). NULL iff `source = 'custom'` (R-db-6). */
    source_id: z.string().nullable(),
    name: z.string(),
    lat: LatSchema,
    lng: LngSchema,
    /** Source taxonomy string, normalized where cheap. */
    category: z.string().nullable(),
    /** Wikidata QID preferred (`Q…`); Wikipedia title accepted. Grounds the tour guide. */
    wiki_ref: z.string().nullable(),
    /** Set iff `source = 'custom'` (authz for edits to user-created places). */
    created_by: UuidSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .superRefine((val, ctx) => {
    // Mirrors the DB check: (source = 'custom') = (source_id IS NULL)
    if ((val.source === "custom") !== (val.source_id === null)) {
      ctx.addIssue({
        code: "custom",
        message: "source_id must be null exactly when source is 'custom'",
        path: ["source_id"],
      });
    }
  });
export type Place = z.infer<typeof PlaceSchema>;

export const SavedPlaceSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  place_id: UuidSchema,
  note: z.string().nullable(),
  /** Attribution in collab trips; nullable so member removal doesn't lose the pin. */
  created_by: UuidSchema.nullable(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type SavedPlace = z.infer<typeof SavedPlaceSchema>;
