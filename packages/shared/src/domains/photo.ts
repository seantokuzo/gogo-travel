/**
 * Photos domain (contracts spec §3.4; schema spec §3.3.17).
 *
 * Law #3: privacy is a boundary. `canViewPhoto` is the SINGLE shared
 * implementation of the visibility check, so server authz and mobile UI can
 * never drift.
 */
import { z } from "zod";
import { PhotoVisibilitySchema, type PhotoVisibility } from "../enums.js";
import { ISODateTimeSchema, LatSchema, LngSchema, UuidSchema } from "../scalars.js";

export const PhotoSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  /** Uploader/owner. */
  user_id: UuidSchema,
  storage_key: z.string(),
  taken_at: ISODateTimeSchema.nullable(),
  /** EXIF GPS — location data; Law #3 applies to every read. */
  lat: LatSchema.nullable(),
  lng: LngSchema.nullable(),
  place_id: UuidSchema.nullable(),
  itinerary_item_id: UuidSchema.nullable(),
  /** DB default 'private' (R-db-3). */
  visibility: PhotoVisibilitySchema,
  /** Photo + caption IS the whole v1 review surface. */
  caption: z.string().nullable(),
  blurhash: z.string().nullable(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type Photo = z.infer<typeof PhotoSchema>;

export interface PhotoViewer {
  /** The viewer owns (uploaded) the photo. */
  isOwner: boolean;
  /** The viewer is a member of the photo's trip. */
  isTripMember: boolean;
}

/**
 * Law #3's check, implemented once (contracts spec §3.4):
 * - `private` → owner only
 * - `trip`    → owner or trip member
 * - `public`  → anyone
 */
export function canViewPhoto(viewer: PhotoViewer, visibility: PhotoVisibility): boolean {
  if (viewer.isOwner) return true;
  switch (visibility) {
    case "private":
      return false;
    case "trip":
      return viewer.isTripMember;
    case "public":
      return true;
  }
}
