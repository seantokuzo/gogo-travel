/**
 * Search temp-pin builder + classifier (T-8.3 / MAP-2 — R-map-25, §2.8).
 * Load-bearing: features carry the inventory testID + the token color
 * (R-map-7: tokens only), the empty input empties the collection ("clearing
 * the search removes temporary pins" — the rider's source just re-renders),
 * and the classifier only answers for the search family.
 */
import { mapColors } from "@gogo/tokens";

import { classifySearchPinPress, searchPinFeatures } from "./search-pins";
import { lightTheme } from "@/test-utils/render";
import { makePlace } from "@/test-utils/trip-fixtures";

const colors = mapColors(lightTheme);

const PLACE_ID = "44444444-4444-4444-8444-444444444441";

describe("searchPinFeatures", () => {
  it("builds one feature per result with the §2.8 testID and token color", () => {
    const place = makePlace({ id: PLACE_ID, lat: 35.1, lng: 135.9 });
    const collection = searchPinFeatures([place], colors);

    expect(collection.features).toHaveLength(1);
    const feature = collection.features[0];
    expect(feature?.id).toBe(PLACE_ID);
    expect(feature?.geometry.coordinates).toEqual([135.9, 35.1]); // [lng, lat]
    expect(feature?.properties).toEqual({
      family: "search",
      testID: `map-pin-search-${PLACE_ID}`,
      placeId: PLACE_ID,
      color: colors.pinSelectedRing,
    });
  });

  it("empty results ⇒ empty collection (clear removes temp pins)", () => {
    expect(searchPinFeatures([], colors).features).toHaveLength(0);
  });
});

describe("classifySearchPinPress", () => {
  it("answers the placeId for a search-family feature", () => {
    const place = makePlace({ id: PLACE_ID });
    const feature = searchPinFeatures([place], colors).features[0];
    expect(feature).toBeDefined();
    // Press payloads arrive as plain JSON from the SDK — spread to the
    // structural Record the classifier reads.
    const properties: Record<string, unknown> = { ...feature?.properties };
    expect(classifySearchPinPress({ features: [{ properties }] })).toBe(PLACE_ID);
  });

  it("ignores empty presses and foreign families", () => {
    expect(classifySearchPinPress({ features: [] })).toBeNull();
    expect(
      classifySearchPinPress({ features: [{ properties: { family: "saved", placeId: PLACE_ID } }] }),
    ).toBeNull();
    expect(
      classifySearchPinPress({ features: [{ properties: { point_count: 3 } }] }),
    ).toBeNull();
  });
});
