/**
 * Place-detail pure logic (T-8.4 / MAP-3+MAP-6 — map spec §2.3, R-map-8,
 * R-map-12..14, R-map-23/24).
 *
 * OWN FEATURE DIR (`features/places/`), not `features/map/`: T-8.3 extends
 * the map barrel concurrently (sheet/search/location), so the place-detail
 * surface keeps a disjoint file set — the W3 parallel-worktree contract.
 *
 * All pure, all tested directly (the pin-features precedent): the screen
 * only composes.
 */
import {
  canViewPhoto,
  type Booking,
  type CoarseCategory,
  type ItineraryItem,
  type Photo,
  type Place,
} from "@gogo/shared";

import type { IconName } from "@/components";
import { GOOGLE_MAPS_DIRECTIONS_BASE } from "@/features/deeplinks";

/**
 * Coarse-category glyphs (§2.3 "coarse-category icon + category") — the
 * shared `COARSE_CATEGORIES` tuple, one Ionicons glyph each (names verified
 * against the installed glyph map). Exhaustive by type: a new coarse
 * category fails tsc here instead of silently rendering nothing.
 */
export const COARSE_CATEGORY_ICONS: Readonly<Record<CoarseCategory, IconName>> = {
  food: "restaurant-outline",
  drink: "cafe-outline",
  lodging: "bed-outline",
  attraction: "star-outline",
  culture: "library-outline",
  outdoors: "leaf-outline",
  shopping: "cart-outline",
  nightlife: "moon-outline",
  transport: "train-outline",
  other: "location-outline",
};

/**
 * The category line under the place name: the raw source-taxonomy string
 * when present (already display-normalized where cheap — shared place doc),
 * else the coarse bucket, capitalized ("Other" places still get a line).
 */
export function categoryLabel(place: Pick<Place, "category" | "coarse_category">): string {
  const raw = place.category?.trim();
  if (raw !== undefined && raw !== "") return raw;
  const coarse = place.coarse_category;
  return coarse.charAt(0).toUpperCase() + coarse.slice(1);
}

/**
 * R-map-14: "the place's itinerary items". An item belongs to a place by
 * its OWN `place_id` or — for `booking`-kind items — the parent booking's
 * (EXACTLY the resolution `pin-features.ts` uses for coordinates, so the
 * map's pins and the detail's linked list can never disagree about which
 * items live at a place). Composite-read order is preserved (day,
 * sort_order — the calendar order the user expects).
 */
export function linkedItineraryItems(
  items: readonly ItineraryItem[],
  bookings: readonly Booking[],
  placeId: string,
): ItineraryItem[] {
  const bookingPlaceById = new Map(bookings.map((b) => [b.id, b.place_id]));
  return items.filter((item) => {
    const itemPlaceId =
      item.place_id ??
      (item.booking_id !== null ? (bookingPlaceById.get(item.booking_id) ?? null) : null);
    return itemPlaceId === placeId;
  });
}

/** The viewer facts `canViewPhoto` needs, resolved once by the screen. */
export interface PlacePhotoViewer {
  /** The signed-in user id (photo ownership check). */
  viewerId: string;
  /** Always true under the membership-guarded `[tripId]` shell. */
  isTripMember: boolean;
}

/**
 * R-map-14's photo strip source: THIS place's photos the viewer may see —
 * Law #3 through the ONE shared `canViewPhoto` helper (R-map-5 rule), never
 * a local visibility re-derivation. FIXTURE-TESTED, EMPTY-IN-PROD until
 * P-12 (the photo-pins prep ruling — no photos API exists yet; the screen
 * passes `[]`, so the strip ships wired but empty).
 */
export function visiblePlacePhotos(
  photos: readonly Photo[],
  viewer: PlacePhotoViewer,
  placeId: string,
): Photo[] {
  return photos.filter(
    (photo) =>
      photo.place_id === placeId &&
      canViewPhoto(
        { isOwner: photo.user_id === viewer.viewerId, isTripMember: viewer.isTripMember },
        photo.visibility,
      ),
  );
}

/**
 * R-map-8: external nav handoff "via URL scheme with the place's
 * coordinates — never in-app turn-by-turn". Same research-verified Maps
 * URLs API contract as `features/deeplinks/directions.ts` (`api=1` pins the
 * parameter set; the base is imported so the app keeps ONE outbound-maps
 * contract): `destination=lat,lng` is the documented coordinate form, and
 * origin is deliberately omitted — the API defaults it to the user's
 * current location, which is exactly what "navigate here" means. The
 * maps.apple.com variant stays unshipped for the same reason directions.ts
 * documents (no research-verified format row — flagged to the spec-sync
 * batch there).
 */
export function placeNavigateUrl(place: Pick<Place, "lat" | "lng">): string {
  const destination = encodeURIComponent(`${place.lat},${place.lng}`);
  return `${GOOGLE_MAPS_DIRECTIONS_BASE}&destination=${destination}`;
}
