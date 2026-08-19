/**
 * Photo-pin visibility filter (T-8.3 / MAP-2 — R-map-5, Law #3): the
 * caller-side filter the `photoPinFeatures` builder contract demands
 * ("the CALLER filters through the shared `canViewPhoto` helper — no
 * visibility logic lives here", pin-features.ts).
 *
 * ONE derivation, shared truth: ownership is `photo.user_id === viewerId`,
 * the check itself is `@gogo/shared`'s `canViewPhoto` — the SINGLE Law-#3
 * implementation server authz uses, so map rendering can never drift from
 * the wire boundary. GPS-less photos (schema allows null lat/lng) are
 * dropped by narrowing, not zero-defaulted: a pin without a position is
 * unrepresentable (builder doc), and a photo at [0,0] would be a location
 * LEAK of nothing but still a lie.
 *
 * DORMANT until P-12 (prep ruling: photo pins fixture-tested,
 * empty-in-prod): no screen calls this yet — the frozen shell passes `[]`
 * to the builder. When P-12's photo data lands, the wiring is
 * `photoPinFeatures(visiblePhotoPinSources(photos, viewer), colors)`.
 *
 * Anyone on the trip surface IS a member (the [tripId] layout admits only
 * membership-verified viewers — trip-context doc), but `isTripMember` stays
 * an explicit input: this filter must also serve surfaces where that
 * guarantee is weaker (the public place-detail strip renders through a
 * different contract), and Law #3 checks are never implied by call-site
 * position.
 */
import { canViewPhoto, type Photo } from "@gogo/shared";

import type { PhotoPinSource } from "./pin-features";

export interface PhotoPinViewer {
  /** The signed-in user id — ownership derives from it per photo. */
  viewerId: string;
  /** Membership of the trip whose map is rendering. */
  isTripMember: boolean;
}

/** Located AND viewer-visible photos, narrowed to the builder's source rows. */
export function visiblePhotoPinSources(
  photos: readonly Photo[],
  viewer: PhotoPinViewer,
): PhotoPinSource[] {
  const sources: PhotoPinSource[] = [];
  for (const photo of photos) {
    if (photo.lat === null || photo.lng === null) continue;
    const allowed = canViewPhoto(
      { isOwner: photo.user_id === viewer.viewerId, isTripMember: viewer.isTripMember },
      photo.visibility,
    );
    if (!allowed) continue;
    sources.push({ id: photo.id, lat: photo.lat, lng: photo.lng });
  }
  return sources;
}
