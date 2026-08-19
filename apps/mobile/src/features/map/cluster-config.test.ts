/**
 * Cluster/layer style pins (T-8.2 / MAP-1 — R-map-2/7).
 *
 * The P-8 acceptance criterion "no literal colors on the map layer" is
 * pinned here: every color a layer style carries either equals a
 * `mapColors` token or is the data-driven `['get', 'color']` expression
 * (whose values the builders write from tokens).
 */
import { mapColors } from "@gogo/tokens";

import { darkTheme, lightTheme } from "@/test-utils/render";

import {
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS,
  CLUSTERED_FILTER,
  clusterCircleStyle,
  clusterCountStyle,
  itineraryPinLabelStyle,
  photoPinCircleStyle,
  pinCircleStyle,
  UNCLUSTERED_FILTER,
} from "./cluster-config";

const light = mapColors(lightTheme);

describe("cluster source config", () => {
  it("splits clustered vs unclustered on the SDK's point_count property", () => {
    expect(CLUSTERED_FILTER).toEqual(["has", "point_count"]);
    expect(UNCLUSTERED_FILTER).toEqual(["!", ["has", "point_count"]]);
  });

  it("keeps sane cluster geometry constants", () => {
    expect(CLUSTER_RADIUS).toBeGreaterThan(0);
    expect(CLUSTER_MAX_ZOOM).toBeGreaterThan(0);
    expect(CLUSTER_MAX_ZOOM).toBeLessThan(22);
  });
});

describe("token-only colors (R-map-7)", () => {
  it("cluster bubble + count use the paired cluster tokens", () => {
    expect(clusterCircleStyle(light).circleColor).toBe(light.clusterFill);
    expect(clusterCountStyle(light).textColor).toBe(light.clusterText);
    // Count badge reads the SDK's abbreviated count (R-map-2 count badge).
    expect(clusterCountStyle(light).textField).toEqual(["get", "point_count_abbreviated"]);
  });

  it("pin fills are data-driven from the builder-written color property", () => {
    expect(pinCircleStyle(1).circleColor).toEqual(["get", "color"]);
    expect(photoPinCircleStyle(light, 1).circleColor).toEqual(["get", "color"]);
    expect(photoPinCircleStyle(light, 1).circleStrokeColor).toBe(light.pinPhotoRing);
    expect(itineraryPinLabelStyle(light).textColor).toBe(light.clusterText);
    expect(itineraryPinLabelStyle(light).textField).toEqual(["get", "label"]);
  });

  it("opacity plumbs the R-map-3 dim through both photo channels", () => {
    const dimmed = photoPinCircleStyle(light, 0.35);
    expect(dimmed.circleOpacity).toBe(0.35);
    expect(dimmed.circleStrokeOpacity).toBe(0.35);
    expect(pinCircleStyle(0.35).circleOpacity).toBe(0.35);
  });

  it("tracks the theme: dark-scheme tokens flow through unchanged", () => {
    const dark = mapColors(darkTheme);
    expect(clusterCircleStyle(dark).circleColor).toBe(dark.clusterFill);
    expect(photoPinCircleStyle(dark, 1).circleStrokeColor).toBe(dark.pinPhotoRing);
  });
});
