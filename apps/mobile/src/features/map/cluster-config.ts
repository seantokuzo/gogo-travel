/**
 * Cluster + layer style config (T-8.2 / MAP-1 — R-map-2, map spec §2.1/§2.2).
 *
 * Pure module: ShapeSource cluster settings and the style objects for every
 * layer the shell renders. EVERY color comes from `mapColors`/`mapDayColors`
 * via the Theme (R-map-7; P-8 acceptance criterion: no literal colors on
 * the map layer) — pin fills ride each feature's `color` property
 * (data-driven `['get', 'color']`), written by the pin builders from token
 * colors only. Numbers here are geometry (radii, text sizes), not colors.
 */
import type { CircleLayerStyle, SymbolLayerStyle } from "@rnmapbox/maps";
import type { MapColors } from "@gogo/tokens";

/** SDK-native clustering (§2.1) — radius in pt around each cluster anchor. */
export const CLUSTER_RADIUS = 50;

/** Above this zoom pins never cluster (street-level always shows members). */
export const CLUSTER_MAX_ZOOM = 14;

/** Cluster features are SDK-synthesized and carry `point_count`. */
export const CLUSTERED_FILTER: ["has", string] = ["has", "point_count"];

export const UNCLUSTERED_FILTER: ["!", ["has", string]] = ["!", ["has", "point_count"]];

/** Cluster bubble — primary fill, count-scaled radius (R-map-2 count badge). */
export function clusterCircleStyle(colors: MapColors): CircleLayerStyle {
  return {
    circleColor: colors.clusterFill,
    // Step by member count: small → medium → large bubbles.
    circleRadius: ["step", ["get", "point_count"], 14, 10, 18, 50, 24],
    circlePitchAlignment: "map",
  };
}

/** Cluster count badge (R-map-2) — AA-paired ink on the bubble fill. */
export function clusterCountStyle(colors: MapColors): SymbolLayerStyle {
  return {
    textField: ["get", "point_count_abbreviated"],
    textSize: 12,
    textColor: colors.clusterText,
    textAllowOverlap: true,
    textIgnorePlacement: true,
  };
}

/**
 * Unclustered pin dot — fill rides the feature's builder-written `color`
 * property. `opacity` implements the R-map-3 dim for saved/photo families
 * (`contextPinOpacity`); the itinerary family always passes 1.
 */
export function pinCircleStyle(opacity: number): CircleLayerStyle {
  return {
    circleColor: ["get", "color"],
    circleRadius: 10,
    circleOpacity: opacity,
    circlePitchAlignment: "map",
  };
}

/**
 * Photo-pin ring (§2.2 "neutral ring with thumbnail" — the thumbnail is the
 * T-8.3+/P-12 MarkerView concern; the shell ships the ring dot).
 */
export function photoPinCircleStyle(colors: MapColors, opacity: number): CircleLayerStyle {
  return {
    circleColor: ["get", "color"],
    circleRadius: 8,
    circleStrokeWidth: 2,
    circleStrokeColor: colors.pinPhotoRing,
    circleOpacity: opacity,
    circleStrokeOpacity: opacity,
    circlePitchAlignment: "map",
  };
}

/**
 * Itinerary pin day-number glyph (§2.2: color is never the only signal).
 * Ink = `clusterText` (`primary.onSolid`) — the token pairing validated for
 * solid chips; the mid/deep status stops the day cycle draws from carry it.
 */
export function itineraryPinLabelStyle(colors: MapColors): SymbolLayerStyle {
  return {
    textField: ["get", "label"],
    textSize: 11,
    textColor: colors.clusterText,
    textAllowOverlap: true,
    textIgnorePlacement: true,
  };
}
