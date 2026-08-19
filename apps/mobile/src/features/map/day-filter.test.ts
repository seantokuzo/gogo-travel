/**
 * Day-filter model pins (T-8.2 / MAP-1 — R-map-3, §2.2).
 */
import { mapDayColors } from "@gogo/tokens";

import { lightTheme } from "@/test-utils/render";

import { dayColorIndex } from "./day-colors";
import { contextPinOpacity, dayFilterChips, itineraryFeaturesForFilter } from "./day-filter";
import type { PinFeature, PinFeatureCollection } from "./pin-features";

const dayColors = mapDayColors(lightTheme);

function itineraryFeature(
  id: string,
  dayIndex: number | null,
  endDayIndex: number | null = null,
): PinFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [135, 35] },
    properties: {
      family: "itinerary",
      testID: `map-pin-itinerary-${id}`,
      placeId: "p",
      itemId: id,
      photoId: null,
      dayIndex,
      endDayIndex,
      color: "#000000",
      label: "1",
    },
  };
}

const collectionOf = (features: PinFeature[]): PinFeatureCollection => ({
  type: "FeatureCollection",
  features,
});

describe("dayFilterChips", () => {
  it("spans the trip range: one chip per day, 0-based, day-color mapped", () => {
    const chips = dayFilterChips({ start_date: "2026-09-10", end_date: "2026-09-13" }, dayColors);
    expect(chips).toHaveLength(4);
    expect(chips.map((chip) => chip.dayIndex)).toEqual([0, 1, 2, 3]);
    expect(chips.map((chip) => chip.day)).toEqual([
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
    expect(chips.map((chip) => chip.label)).toEqual(["1", "2", "3", "4"]);
    // §2.2: "The same mapping colors the day-filter chips."
    expect(chips.map((chip) => chip.color)).toEqual(dayColors.slice(0, 4));
  });

  it("wraps chip colors through the 8-cycle on long trips", () => {
    const chips = dayFilterChips({ start_date: "2026-09-01", end_date: "2026-09-10" }, dayColors);
    expect(chips).toHaveLength(10);
    expect(chips[8]?.color).toBe(dayColors[dayColorIndex(8)]);
    expect(chips[9]?.color).toBe(dayColors[1]);
  });

  it("renders no chips (not an infinite loop) for a malformed inverted range", () => {
    expect(dayFilterChips({ start_date: "2026-09-10", end_date: "2026-09-01" }, dayColors)).toEqual(
      [],
    );
  });
});

describe("itineraryFeaturesForFilter (R-map-3)", () => {
  const collection = collectionOf([
    itineraryFeature("a", 0),
    itineraryFeature("b", 2),
    itineraryFeature("c", 2),
    itineraryFeature("d", -1),
  ]);

  it("passes everything through under 'all' (the default), by reference", () => {
    expect(itineraryFeaturesForFilter(collection, "all")).toBe(collection);
  });

  it("keeps ONLY the selected day's features", () => {
    const filtered = itineraryFeaturesForFilter(collection, 2);
    expect(filtered.features.map((feature) => feature.id)).toEqual(["b", "c"]);
  });

  it("CONTROL: a day with no features filters to empty (the predicate can exclude)", () => {
    expect(itineraryFeaturesForFilter(collection, 5).features).toEqual([]);
  });

  describe("SPAN-AWARE matching (R1 review — hotel day 0→4)", () => {
    // A spanning stay (check-in day 0, check-out day 4) + a point sibling.
    const spanning = collectionOf([
      itineraryFeature("stay", 0, 4),
      itineraryFeature("point", 2),
    ]);

    it("a MID-STAY day keeps the spanning pin (the itinerary grid parity arm)", () => {
      // Filter day 1: inside the span, no point item — the stay alone.
      expect(itineraryFeaturesForFilter(spanning, 1).features.map((f) => f.id)).toEqual(["stay"]);
      // Filter day 2: span + the point sibling.
      expect(itineraryFeaturesForFilter(spanning, 2).features.map((f) => f.id)).toEqual([
        "stay",
        "point",
      ]);
    });

    it("matches BOTH end days (check-in and check-out) and nothing outside", () => {
      expect(itineraryFeaturesForFilter(spanning, 0).features.map((f) => f.id)).toEqual(["stay"]);
      expect(itineraryFeaturesForFilter(spanning, 4).features.map((f) => f.id)).toEqual(["stay"]);
      expect(itineraryFeaturesForFilter(spanning, 5).features).toEqual([]);
      expect(itineraryFeaturesForFilter(spanning, -1).features).toEqual([]);
    });

    it("a malformed INVERTED span degrades to point behavior (check-in day only)", () => {
      const inverted = collectionOf([itineraryFeature("bad", 3, 1)]);
      expect(itineraryFeaturesForFilter(inverted, 3).features.map((f) => f.id)).toEqual(["bad"]);
      expect(itineraryFeaturesForFilter(inverted, 2).features).toEqual([]);
    });
  });
});

describe("contextPinOpacity (R-map-3 dim)", () => {
  it("keeps saved/photo pins full-opacity under 'all'", () => {
    expect(contextPinOpacity("all", 0.35)).toBe(1);
  });

  it("dims to the token opacity when a day is selected", () => {
    expect(contextPinOpacity(2, 0.35)).toBe(0.35);
  });
});
