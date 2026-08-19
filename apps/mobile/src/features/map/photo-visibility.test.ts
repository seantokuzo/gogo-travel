/**
 * Photo-pin visibility (T-8.3 / MAP-2 — R-map-5, Law #3). The spec's
 * mandated fixture set: "another member's private photo absent from map —
 * canViewPhoto truth table drives fixtures". Owner/member/stranger ×
 * private/trip/public through the SHARED helper, plus the GPS-less
 * narrowing (a null-coordinate photo is unrepresentable as a pin, never
 * zero-defaulted).
 */
import type { Photo } from "@gogo/shared";

import { visiblePhotoPinSources } from "./photo-visibility";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const TRIP_ID = "33333333-3333-4333-8333-333333333333";

let photoSeq = 0;
function makePhoto(overrides?: Partial<Photo>): Photo {
  photoSeq += 1;
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(photoSeq).padStart(12, "0")}`,
    trip_id: TRIP_ID,
    user_id: OWNER_ID,
    storage_key: `photos/${photoSeq}.jpg`,
    taken_at: null,
    lat: 35.0116,
    lng: 135.7681,
    place_id: null,
    itinerary_item_id: null,
    visibility: "private",
    caption: null,
    blurhash: null,
    width: null,
    height: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("visiblePhotoPinSources (Law #3 truth table)", () => {
  it("a member's map NEVER shows another member's private photo", () => {
    const photos = [makePhoto({ visibility: "private" })];
    expect(
      visiblePhotoPinSources(photos, { viewerId: MEMBER_ID, isTripMember: true }),
    ).toHaveLength(0);
  });

  it("the owner sees their own photo at every visibility", () => {
    for (const visibility of ["private", "trip", "public"] as const) {
      const photos = [makePhoto({ visibility })];
      expect(
        visiblePhotoPinSources(photos, { viewerId: OWNER_ID, isTripMember: true }),
      ).toHaveLength(1);
    }
  });

  it("members see trip + public, strangers see only public", () => {
    const photos = [
      makePhoto({ visibility: "trip" }),
      makePhoto({ visibility: "public" }),
      makePhoto({ visibility: "private" }),
    ];
    const member = visiblePhotoPinSources(photos, { viewerId: MEMBER_ID, isTripMember: true });
    expect(member).toHaveLength(2);
    const stranger = visiblePhotoPinSources(photos, {
      viewerId: MEMBER_ID,
      isTripMember: false,
    });
    expect(stranger).toHaveLength(1);
    expect(stranger[0]?.id).toBe(photos[1]?.id);
  });

  it("GPS-less photos are dropped by narrowing, never zero-defaulted", () => {
    const photos = [
      makePhoto({ visibility: "public", lat: null, lng: null }),
      makePhoto({ visibility: "public", lat: 35, lng: null }),
      makePhoto({ visibility: "public", lat: 35.1, lng: 135.9 }),
    ];
    const visible = visiblePhotoPinSources(photos, { viewerId: MEMBER_ID, isTripMember: true });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toEqual({ id: photos[2]?.id, lat: 35.1, lng: 135.9 });
  });
});
