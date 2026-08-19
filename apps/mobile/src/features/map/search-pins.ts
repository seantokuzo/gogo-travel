/**
 * Search temp-pin builder (T-8.3 / MAP-2 — R-map-25 "results as temporary
 * pins", §2.8 `map-pin-search-{placeId}`).
 *
 * DORMANT-EMITTER (T-6.3/T-7.1 precedent — see the PR escalation list): a
 * ShapeSource must be a MapView child and the T-8.2 screen is frozen, so no
 * source consumes this collection yet. The builder + press classifier ship
 * tested and ready; the integration rider adds one non-clustered
 * ShapeSource block (≤ `MAP_SEARCH_PAGE_LIMIT` features never need
 * clustering) reusing `pinCircleStyle(1)` — the paint reads `['get',
 * 'color']` exactly like the T-8.2 families. Clearing the search clears the
 * input collection, which empties the source (R-map-25 "clearing the search
 * removes temporary pins").
 *
 * The `search` family deliberately does NOT extend T-8.2's `PinFamily`
 * union (`pin-features.ts` is frozen shell surface): types here are
 * structural GeoJSON, same as the shell's, and `classifySearchPinPress`
 * covers the family that `classifyMapPress` (by design) reports as
 * `none`-adjacent. Folding `search` into the shell union is a rider-time
 * cleanup, not a T-8.3 edit.
 *
 * Color: `mapColors.pinSelectedRing` — the focus-ring semantic
 * (`border.focus` kin) is the closest existing token to "transient
 * highlight"; §2.2 predates R-map-25 and names no search-pin color, and
 * tokens are the ONLY color source (R-map-7), so no literal and no new
 * token field (PR interpretation).
 */
import type { Place } from "@gogo/shared";
import type { MapColors } from "@gogo/tokens";

import type { LngLat, MapPressFeature } from "./pin-features";

export interface SearchPinFeatureProperties {
  family: "search";
  /** §2.8 inventory id — carried in properties (style-layer pins, shell doc). */
  testID: string;
  placeId: string;
  /** Paint color — data-driven via `['get', 'color']` (cluster-config.ts). */
  color: string;
}

export interface SearchPinFeature {
  type: "Feature";
  /** Stable entity id (§2.8: never a render index). */
  id: string;
  geometry: { type: "Point"; coordinates: LngLat };
  properties: SearchPinFeatureProperties;
}

export interface SearchPinFeatureCollection {
  type: "FeatureCollection";
  features: SearchPinFeature[];
}

/** Result rows → temp-pin features. Empty input ⇒ empty collection (clear). */
export function searchPinFeatures(
  places: readonly Place[],
  colors: MapColors,
): SearchPinFeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.map((place) => ({
      type: "Feature",
      id: place.id,
      geometry: { type: "Point", coordinates: [place.lng, place.lat] },
      properties: {
        family: "search",
        testID: `map-pin-search-${place.id}`,
        placeId: place.id,
        color: colors.pinSelectedRing,
      },
    })),
  };
}

/**
 * Classify a press on the (rider-wired) search source: a search-pin feature
 * yields its placeId — the value the rider feeds `onPinSelect`… except a
 * search pin's row may not be in the saved-places index, so the rider feeds
 * the SHEET's search-selection path instead (slot doc). Anything else
 * (no feature, foreign family) yields null.
 */
export function classifySearchPinPress(event: { features: MapPressFeature[] }): string | null {
  const feature = event.features[0];
  if (feature === undefined) return null;
  const props = feature.properties ?? {};
  if (props["family"] !== "search") return null;
  const placeId = props["placeId"];
  return typeof placeId === "string" ? placeId : null;
}
