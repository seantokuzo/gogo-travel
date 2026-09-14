/**
 * Pin-builder pins (T-8.2 / MAP-1 — R-map-1/2, §2.1/§2.2/§2.8).
 *
 * These carry the real pin behavior (jest never renders the native MapView):
 * coordinate resolution through the place index, [lng, lat] wire order,
 * §2.8 testID grammar, the Euclidean-modulo day colors on NEGATIVE indexes,
 * the empty-in-prod photo family, and press classification (cluster ≠ pin).
 */
import { mapColors, mapDayColors } from "@gogo/tokens";

import { makeBooking, makeItineraryItem } from "@/test-utils/itinerary-fixtures";
import { lightTheme } from "@/test-utils/render";
import { makePlace, makeSavedPlaceWithPlace } from "@/test-utils/trip-fixtures";

import { dayColorIndex } from "./day-colors";
import {
  buildPlaceIndex,
  classifyMapPress,
  itineraryPinFeatures,
  photoPinFeatures,
  savedPinFeatures,
} from "./pin-features";

const colors = mapColors(lightTheme);
const dayColors = mapDayColors(lightTheme);

const PLACE_A = "44444444-4444-4444-8444-444444444441";
const PLACE_B = "44444444-4444-4444-8444-444444444442";
const TRIP_START = "2027-03-01";

const savedA = makeSavedPlaceWithPlace({
  id: "55555555-5555-4555-8555-555555555551",
  place_id: PLACE_A,
  place: { id: PLACE_A, name: "Fushimi Inari", lat: 34.9671, lng: 135.7727 },
});
const savedB = makeSavedPlaceWithPlace({
  id: "55555555-5555-4555-8555-555555555552",
  place_id: PLACE_B,
  place: { id: PLACE_B, name: "Nishiki Market", lat: 35.005, lng: 135.7646 },
});

describe("buildPlaceIndex", () => {
  it("indexes embedded place coordinates by place id", () => {
    const index = buildPlaceIndex([savedA, savedB]);
    expect(index.get(PLACE_A)).toEqual({ lat: 34.9671, lng: 135.7727 });
    expect(index.get(PLACE_B)).toEqual({ lat: 35.005, lng: 135.7646 });
    expect(index.get("unknown")).toBeUndefined();
  });

  // B-7 part 3: a coordinate-less custom place is unrepresentable in the
  // index — never `{lat: null, lng: null}`, and never crashes the index
  // build. Falsification: drop the null-skip and this throws (`.set` with
  // a null coordinate type-errors upstream) or seeds a bogus entry.
  it("skips a coordinate-less custom place entirely — never seeds a null entry", () => {
    const CUSTOM_ID = "66666666-6666-4666-8666-666666666661";
    const savedCustom = makeSavedPlaceWithPlace({
      id: "55555555-5555-4555-8555-555555555553",
      place_id: CUSTOM_ID,
      place: { id: CUSTOM_ID, source: "custom", name: "Nowhereville", lat: null, lng: null },
    });
    const index = buildPlaceIndex([savedA, savedCustom, savedB]);
    expect(index.size).toBe(2);
    expect(index.get(CUSTOM_ID)).toBeUndefined();
    expect(index.get(PLACE_A)).toEqual({ lat: 34.9671, lng: 135.7727 });
  });
});

describe("savedPinFeatures", () => {
  it("emits one accent-colored feature per saved place, [lng, lat] order", () => {
    const collection = savedPinFeatures([savedA, savedB], colors);
    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(2);
    const [a] = collection.features;
    expect(a?.id).toBe(PLACE_A);
    // Mapbox Position order — lng FIRST (a swapped pair renders in the ocean).
    expect(a?.geometry).toEqual({ type: "Point", coordinates: [135.7727, 34.9671] });
    expect(a?.properties).toEqual({
      family: "saved",
      testID: `map-pin-saved-${PLACE_A}`,
      placeId: PLACE_A,
      itemId: null,
      photoId: null,
      dayIndex: null,
      endDayIndex: null,
      color: colors.pinSaved,
      label: null,
    });
  });

  // B-7 part 3: a coordinate-less custom place produces NO feature — never
  // malformed GeoJSON `coordinates: [null, null]` handed to the native
  // ShapeSource. Falsification: remove the filter and this either throws
  // (the coordinates tuple no longer type-checks as [number, number]) or,
  // if forced through with `as`, emits a feature with null coordinates.
  it("filters out a coordinate-less custom place — no malformed [null, null] feature", () => {
    const CUSTOM_ID = "66666666-6666-4666-8666-666666666662";
    const savedCustom = makeSavedPlaceWithPlace({
      id: "55555555-5555-4555-8555-555555555554",
      place_id: CUSTOM_ID,
      place: { id: CUSTOM_ID, source: "custom", name: "Nowhereville", lat: null, lng: null },
    });
    const collection = savedPinFeatures([savedA, savedCustom, savedB], colors);
    expect(collection.features).toHaveLength(2);
    expect(collection.features.map((f) => f.id)).toEqual([PLACE_A, PLACE_B]);
    expect(collection.features.some((f) => f.id === CUSTOM_ID)).toBe(false);
  });
});

describe("itineraryPinFeatures", () => {
  const placeIndex = buildPlaceIndex([savedA, savedB]);

  it("pins a place_visit item with day-color + day-number glyph (§2.2)", () => {
    const item = makeItineraryItem({
      id: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      kind: "place_visit",
      place_id: PLACE_A,
      title: null,
      day: "2027-03-03",
    });
    const collection = itineraryPinFeatures({
      items: [item],
      bookings: [],
      placeIndex,
      dayColors,
      tripStart: TRIP_START,
    });
    expect(collection.features).toHaveLength(1);
    const feature = collection.features[0];
    expect(feature?.geometry.coordinates).toEqual([135.7727, 34.9671]);
    expect(feature?.properties).toEqual({
      family: "itinerary",
      testID: "map-pin-itinerary-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      placeId: PLACE_A,
      itemId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      photoId: null,
      dayIndex: 2,
      endDayIndex: null,
      color: dayColors[2],
      label: "3",
    });
  });

  it("SPAN-AWARE (R1 review): a multi-day item carries endDayIndex, wears CHECK-IN color + glyph", () => {
    const stay = makeItineraryItem({
      id: "aaaaaaa7-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
      kind: "place_visit",
      place_id: PLACE_A,
      title: null,
      day: "2027-03-02", // dayIndex 1
      end_day: "2027-03-05", // dayIndex 4 — the check-out date (§3.3.10)
    });
    const collection = itineraryPinFeatures({
      items: [stay],
      bookings: [],
      placeIndex,
      dayColors,
      tripStart: TRIP_START,
    });
    const properties = collection.features[0]?.properties;
    expect(properties?.dayIndex).toBe(1);
    expect(properties?.endDayIndex).toBe(4);
    // Check-in day owns the visual identity: color + glyph never shift mid-stay.
    expect(properties?.color).toBe(dayColors[1]);
    expect(properties?.label).toBe("2");
  });

  it("NEGATIVE-INDEX ARM (binding ruling): a pre-trip item day gets a DEFINED wrapped color", () => {
    const item = makeItineraryItem({
      id: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      kind: "place_visit",
      place_id: PLACE_A,
      title: null,
      day: "2027-02-27", // two days BEFORE trip start → dayIndex -2
    });
    const collection = itineraryPinFeatures({
      items: [item],
      bookings: [],
      placeIndex,
      dayColors,
      tripStart: TRIP_START,
    });
    const properties = collection.features[0]?.properties;
    expect(properties?.dayIndex).toBe(-2);
    // Euclidean modulo: -2 → 6. A naive `% 8` would index -2 → undefined,
    // an invalid Mapbox paint value (the day-colors CONTROL pins that).
    expect(properties?.color).toBe(dayColors[dayColorIndex(-2)]);
    expect(properties?.color).toBe(dayColors[6]);
    expect(typeof properties?.color).toBe("string");
  });

  it("resolves a booking-kind item through the PARENT booking's place", () => {
    const booking = makeBooking({
      id: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      place_id: PLACE_B,
    });
    const item = makeItineraryItem({
      id: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      kind: "booking",
      booking_id: booking.id,
      title: null,
      day: "2027-03-02",
    });
    const collection = itineraryPinFeatures({
      items: [item],
      bookings: [booking],
      placeIndex,
      dayColors,
      tripStart: TRIP_START,
    });
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties.placeId).toBe(PLACE_B);
    expect(collection.features[0]?.geometry.coordinates).toEqual([135.7646, 35.005]);
  });

  it("omits items with no resolvable coordinate (no place / place not indexed)", () => {
    const noPlace = makeItineraryItem({ id: "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4" });
    const unindexed = makeItineraryItem({
      id: "aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      kind: "place_visit",
      place_id: "44444444-4444-4444-8444-444444444449",
      title: null,
    });
    const pinnable = makeItineraryItem({
      id: "aaaaaaa6-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
      kind: "place_visit",
      place_id: PLACE_A,
      title: null,
    });
    const collection = itineraryPinFeatures({
      items: [noPlace, unindexed, pinnable],
      bookings: [],
      placeIndex,
      dayColors,
      tripStart: TRIP_START,
    });
    // CONTROL: the pinnable sibling proves the builder wasn't just empty.
    expect(collection.features.map((feature) => feature.id)).toEqual([
      "aaaaaaa6-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
    ]);
  });
});

describe("photoPinFeatures (fixture-tested, EMPTY-IN-PROD until P-12)", () => {
  it("builds ring-colored features from fixture rows", () => {
    const collection = photoPinFeatures([{ id: "photo-1", lat: 35.01, lng: 135.77 }], colors);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties).toEqual({
      family: "photo",
      testID: "map-pin-photo-photo-1",
      placeId: null,
      itemId: null,
      photoId: "photo-1",
      dayIndex: null,
      endDayIndex: null,
      color: colors.pinPhotoRing,
      label: null,
    });
  });

  it("returns an empty collection for the prod input (no photo data before P-12)", () => {
    expect(photoPinFeatures([], colors)).toEqual({ type: "FeatureCollection", features: [] });
  });
});

describe("classifyMapPress (R-map-2: cluster ≠ pin)", () => {
  it("classifies SDK cluster features (point_count) as clusters", () => {
    const feature = { properties: { point_count: 4, cluster: true } };
    expect(classifyMapPress({ features: [feature] })).toEqual({ kind: "cluster", feature });
  });

  it("classifies builder features as pins with their entity refs", () => {
    const collection = savedPinFeatures([savedA], colors);
    const feature = collection.features[0] as unknown as { properties: Record<string, unknown> };
    expect(classifyMapPress({ features: [feature] })).toEqual({
      kind: "pin",
      family: "saved",
      placeId: PLACE_A,
      itemId: null,
      photoId: null,
    });
  });

  it("returns none for empty or foreign features", () => {
    expect(classifyMapPress({ features: [] })).toEqual({ kind: "none" });
    expect(classifyMapPress({ features: [{ properties: { family: "mystery" } }] })).toEqual({
      kind: "none",
    });
  });
});

describe("place fixture sanity", () => {
  it("makePlace overrides keep the custom-source invariant untouched", () => {
    // Guard for the fixtures used above: spine place, source_id present.
    const place = makePlace({ id: PLACE_A });
    expect(place.source).toBe("overture");
    expect(place.source_id).not.toBeNull();
  });
});
