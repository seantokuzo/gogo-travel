/**
 * Camera-fit math (T-8.2 / MAP-1 — map spec §2.1 "Camera").
 *
 * Pure module: pin coordinates → a camera target the screen applies via the
 * `Camera` ref. Jest never renders the native MapView (P-8 prep ruling), so
 * the fit decisions live here where they are directly testable; the screen
 * only translates a target into one `setCamera` call.
 *
 * §2.1 ladder: fit all visible pins (padded) → no pins: destination point
 * at z12 → no coordinates: world view + EmptyState overlay. The world arm
 * is structurally dormant in prod — `destination_lat/lng` are
 * schema-guaranteed (Gate 2: destination input is structured) — but the
 * function stays total so a malformed row degrades to a world map, never a
 * crash.
 */
import type { CameraStop } from "@rnmapbox/maps";

import type { LngLat } from "./pin-features";

/** §2.1: "fallback when no pins = destination point at z12". */
export const DESTINATION_FALLBACK_ZOOM = 12;

/**
 * Fitting ZERO-SPAN bounds is degenerate (ne === sw ⇒ fitBounds at ~max
 * zoom, a rooftop view): one pin, or N pins at the SAME coordinate — the
 * common first-use state when a saved place is also an itinerary item.
 * Those collapse to a center stop at street-block zoom instead.
 * Spec-uncovered choice — PR interpretation.
 */
export const SINGLE_PIN_ZOOM = 14;

/** Fit padding in pt, all edges (§2.1 "padded"; overlays sit inside the map). */
export const CAMERA_FIT_PADDING = 48;

/** Camera animation for user-initiated refits (day filter, R-map-3). */
export const CAMERA_ANIMATION_MS = 350;

export interface CameraBoundsBox {
  ne: LngLat;
  sw: LngLat;
}

export type CameraTarget =
  | { kind: "bounds"; bounds: CameraBoundsBox }
  | { kind: "center"; center: LngLat; zoom: number }
  | { kind: "world" };

const isFinitePair = ([lng, lat]: LngLat): boolean => Number.isFinite(lng) && Number.isFinite(lat);

/** Coordinate envelope (ne/sw) of ≥1 finite coordinates, else undefined. */
export function boundsFor(coordinates: readonly LngLat[]): CameraBoundsBox | undefined {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let count = 0;
  for (const pair of coordinates) {
    if (!isFinitePair(pair)) continue;
    const [lng, lat] = pair;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    count += 1;
  }
  if (count === 0) return undefined;
  return { ne: [maxLng, maxLat], sw: [minLng, minLat] };
}

/** The §2.1 ladder (module doc). `destination` may be omitted for totality. */
export function cameraTargetFor(
  pinCoordinates: readonly LngLat[],
  destination: { lat: number; lng: number } | undefined,
): CameraTarget {
  const finite = pinCoordinates.filter(isFinitePair);
  const bounds = boundsFor(finite);
  if (bounds !== undefined) {
    // Zero-span envelope (single pin OR N identical coordinates) — the
    // degenerate-fit guard; subsumes the old single-pin-only arm.
    if (bounds.ne[0] === bounds.sw[0] && bounds.ne[1] === bounds.sw[1]) {
      return { kind: "center", center: bounds.ne, zoom: SINGLE_PIN_ZOOM };
    }
    return { kind: "bounds", bounds };
  }
  if (
    destination !== undefined &&
    Number.isFinite(destination.lat) &&
    Number.isFinite(destination.lng)
  ) {
    return {
      kind: "center",
      center: [destination.lng, destination.lat],
      zoom: DESTINATION_FALLBACK_ZOOM,
    };
  }
  return { kind: "world" };
}

/**
 * Translate a target into the `CameraStop` handed to `setCamera` /
 * `defaultSettings`. World targets return undefined — the camera's default
 * state IS the world view, so there is nothing to set.
 */
export function cameraStopFor(
  target: CameraTarget,
  options?: { animate?: boolean },
): CameraStop | undefined {
  const animationDuration = options?.animate === true ? CAMERA_ANIMATION_MS : 0;
  switch (target.kind) {
    case "bounds":
      return {
        bounds: { ne: target.bounds.ne, sw: target.bounds.sw },
        padding: {
          paddingTop: CAMERA_FIT_PADDING,
          paddingBottom: CAMERA_FIT_PADDING,
          paddingLeft: CAMERA_FIT_PADDING,
          paddingRight: CAMERA_FIT_PADDING,
        },
        animationDuration,
      };
    case "center":
      return { centerCoordinate: target.center, zoomLevel: target.zoom, animationDuration };
    case "world":
      return undefined;
  }
}
