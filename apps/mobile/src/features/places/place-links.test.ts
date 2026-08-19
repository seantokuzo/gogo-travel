/**
 * Place-detail pure-logic pins (T-8.4 / MAP-3+MAP-6).
 *
 * Load-bearing: `linkedItineraryItems` must resolve an item's place EXACTLY
 * like the pin builder (own place_id, else the parent booking's) — a fork
 * here means the map shows a pin at a place whose detail screen denies the
 * item exists. `visiblePlacePhotos` is the R-map-5/14 Law-#3 filter, driven
 * by the shared `canViewPhoto` truth table.
 */
import { COARSE_CATEGORIES, type Photo } from "@gogo/shared";

import {
  BOOKING_FLIGHT_ID,
  makeBooking,
  makeItineraryItem,
} from "@/test-utils/itinerary-fixtures";
import { makePlace, TEST_PLACE_ID } from "@/test-utils/trip-fixtures";

import {
  categoryLabel,
  COARSE_CATEGORY_ICONS,
  linkedItineraryItems,
  placeNavigateUrl,
  visiblePlacePhotos,
} from "./place-links";

const OTHER_PLACE_ID = "44444444-4444-4444-8444-444444444442";
const VIEWER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// Category presentation
// ---------------------------------------------------------------------------

it("every coarse category has a glyph (exhaustive over the shared tuple)", () => {
  for (const coarse of COARSE_CATEGORIES) {
    expect(typeof COARSE_CATEGORY_ICONS[coarse]).toBe("string");
    expect(COARSE_CATEGORY_ICONS[coarse].length).toBeGreaterThan(0);
  }
});

it("categoryLabel: raw source taxonomy wins; absent/blank falls back to the capitalized coarse bucket", () => {
  expect(categoryLabel({ category: "Ramen Restaurant", coarse_category: "food" })).toBe(
    "Ramen Restaurant",
  );
  expect(categoryLabel({ category: null, coarse_category: "food" })).toBe("Food");
  expect(categoryLabel({ category: "   ", coarse_category: "nightlife" })).toBe("Nightlife");
});

// ---------------------------------------------------------------------------
// linkedItineraryItems (R-map-14)
// ---------------------------------------------------------------------------

it("matches an item by its OWN place_id", () => {
  const mine = makeItineraryItem({ id: "aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaa5", kind: "place_visit", place_id: TEST_PLACE_ID });
  const other = makeItineraryItem({ id: "aaaaaaa6-aaaa-4aaa-8aaa-aaaaaaaaaaa6", kind: "place_visit", place_id: OTHER_PLACE_ID });
  const unplaced = makeItineraryItem({ id: "aaaaaaa7-aaaa-4aaa-8aaa-aaaaaaaaaaa7" });
  expect(linkedItineraryItems([mine, other, unplaced], [], TEST_PLACE_ID)).toEqual([mine]);
});

it("matches a booking-kind item through its PARENT booking's place (the pin-builder resolution)", () => {
  const bookingItem = makeItineraryItem({
    id: "aaaaaaa8-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
    kind: "booking",
    booking_id: BOOKING_FLIGHT_ID,
    place_id: null,
  });
  const parentAtPlace = makeBooking({ id: BOOKING_FLIGHT_ID, place_id: TEST_PLACE_ID });
  expect(linkedItineraryItems([bookingItem], [parentAtPlace], TEST_PLACE_ID)).toEqual([
    bookingItem,
  ]);
  // CONTROLS — each proves the arm above could have failed: a parent at a
  // DIFFERENT place, a parent with NO place, and a missing parent all miss.
  expect(
    linkedItineraryItems(
      [bookingItem],
      [makeBooking({ id: BOOKING_FLIGHT_ID, place_id: OTHER_PLACE_ID })],
      TEST_PLACE_ID,
    ),
  ).toEqual([]);
  expect(
    linkedItineraryItems([bookingItem], [makeBooking({ id: BOOKING_FLIGHT_ID })], TEST_PLACE_ID),
  ).toEqual([]);
  expect(linkedItineraryItems([bookingItem], [], TEST_PLACE_ID)).toEqual([]);
});

it("an item's own place_id OUTRANKS the parent booking's (?? not ||: own id wins when both exist)", () => {
  const item = makeItineraryItem({
    id: "aaaaaaa9-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
    kind: "booking",
    booking_id: BOOKING_FLIGHT_ID,
    place_id: OTHER_PLACE_ID,
  });
  const parent = makeBooking({ id: BOOKING_FLIGHT_ID, place_id: TEST_PLACE_ID });
  // The item pins at ITS place, not the parent's — so it links there too.
  expect(linkedItineraryItems([item], [parent], TEST_PLACE_ID)).toEqual([]);
  expect(linkedItineraryItems([item], [parent], OTHER_PLACE_ID)).toEqual([item]);
});

// ---------------------------------------------------------------------------
// visiblePlacePhotos (R-map-5/14 — Law #3 via the shared truth table)
// ---------------------------------------------------------------------------

function makePhoto(overrides: Partial<Photo> & { id: string }): Photo {
  return {
    trip_id: "11111111-1111-4111-8111-111111111111",
    user_id: OTHER_USER_ID,
    storage_key: "photos/x.jpg",
    taken_at: null,
    lat: null,
    lng: null,
    place_id: TEST_PLACE_ID,
    itinerary_item_id: null,
    visibility: "private",
    caption: null,
    blurhash: null,
    width: null,
    height: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

it("filters by place AND canViewPhoto: another member's private photo NEVER surfaces", () => {
  const viewer = { viewerId: VIEWER_ID, isTripMember: true };
  const ownPrivate = makePhoto({ id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", user_id: VIEWER_ID });
  const theirPrivate = makePhoto({ id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2" });
  const theirTrip = makePhoto({ id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd3", visibility: "trip" });
  const theirPublic = makePhoto({ id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4", visibility: "public" });
  const elsewhere = makePhoto({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd5",
    visibility: "public",
    place_id: OTHER_PLACE_ID,
  });

  const visible = visiblePlacePhotos(
    [ownPrivate, theirPrivate, theirTrip, theirPublic, elsewhere],
    viewer,
    TEST_PLACE_ID,
  );
  expect(visible.map((photo) => photo.id)).toEqual([
    ownPrivate.id,
    theirTrip.id,
    theirPublic.id,
  ]);
});

// ---------------------------------------------------------------------------
// placeNavigateUrl (R-map-8)
// ---------------------------------------------------------------------------

it("builds the Maps URLs API coordinate handoff — encoded, origin omitted (defaults to current location)", () => {
  const url = placeNavigateUrl(makePlace({ lat: 35.0116, lng: 135.7681 }));
  expect(url).toBe(
    "https://www.google.com/maps/dir/?api=1&destination=35.0116%2C135.7681",
  );
});
