/**
 * Camera-fit ladder pins (T-8.2 / MAP-1 — map spec §2.1 "Camera").
 */
import {
  boundsFor,
  CAMERA_ANIMATION_MS,
  CAMERA_FIT_PADDING,
  cameraStopFor,
  cameraTargetFor,
  DESTINATION_FALLBACK_ZOOM,
  SINGLE_PIN_ZOOM,
} from "./camera";
import type { LngLat } from "./pin-features";

const KYOTO: LngLat = [135.7681, 35.0116];
const OSAKA: LngLat = [135.5023, 34.6937];
const TOKYO: LngLat = [139.6917, 35.6895];

describe("boundsFor", () => {
  it("computes the ne/sw envelope of multiple coordinates", () => {
    expect(boundsFor([KYOTO, OSAKA, TOKYO])).toEqual({
      ne: [139.6917, 35.6895],
      sw: [135.5023, 34.6937],
    });
  });

  it("returns undefined for an empty set", () => {
    expect(boundsFor([])).toBeUndefined();
  });

  it("skips non-finite coordinates instead of poisoning the envelope", () => {
    expect(boundsFor([[Number.NaN, 10], KYOTO, OSAKA])).toEqual({
      ne: [135.7681, 35.0116],
      sw: [135.5023, 34.6937],
    });
  });
});

describe("cameraTargetFor (§2.1 ladder)", () => {
  const destination = { lat: 35.0116, lng: 135.7681 };

  it("fits bounds for ≥2 pins", () => {
    expect(cameraTargetFor([KYOTO, OSAKA], destination)).toEqual({
      kind: "bounds",
      bounds: { ne: [135.7681, 35.0116], sw: [135.5023, 34.6937] },
    });
  });

  it("centers a SINGLE pin at street zoom (degenerate-bounds guard)", () => {
    expect(cameraTargetFor([KYOTO], destination)).toEqual({
      kind: "center",
      center: KYOTO,
      zoom: SINGLE_PIN_ZOOM,
    });
  });

  it("ZERO-SPAN (R1 review): N≥2 IDENTICAL coordinates center at street zoom, never a rooftop fit", () => {
    // The common first-use state: one saved place that is also an itinerary
    // item — two pins, one coordinate. fitBounds(ne === sw) ⇒ ~max zoom.
    expect(cameraTargetFor([KYOTO, [135.7681, 35.0116], KYOTO], destination)).toEqual({
      kind: "center",
      center: KYOTO,
      zoom: SINGLE_PIN_ZOOM,
    });
  });

  it("falls back to the destination at z12 with no pins", () => {
    expect(cameraTargetFor([], destination)).toEqual({
      kind: "center",
      center: [135.7681, 35.0116],
      zoom: DESTINATION_FALLBACK_ZOOM,
    });
  });

  it("degrades to world view with no coordinates at all (dormant arm)", () => {
    expect(cameraTargetFor([], undefined)).toEqual({ kind: "world" });
    expect(cameraTargetFor([], { lat: Number.NaN, lng: 135 })).toEqual({ kind: "world" });
  });
});

describe("cameraStopFor", () => {
  it("emits a padded bounds stop (§2.1 'fit all visible pins (padded)')", () => {
    const stop = cameraStopFor({
      kind: "bounds",
      bounds: { ne: TOKYO, sw: OSAKA },
    });
    expect(stop).toEqual({
      bounds: { ne: TOKYO, sw: OSAKA },
      padding: {
        paddingTop: CAMERA_FIT_PADDING,
        paddingBottom: CAMERA_FIT_PADDING,
        paddingLeft: CAMERA_FIT_PADDING,
        paddingRight: CAMERA_FIT_PADDING,
      },
      animationDuration: 0,
    });
  });

  it("emits a center stop with the target zoom, animated on request", () => {
    expect(
      cameraStopFor({ kind: "center", center: KYOTO, zoom: 12 }, { animate: true }),
    ).toEqual({
      centerCoordinate: KYOTO,
      zoomLevel: 12,
      animationDuration: CAMERA_ANIMATION_MS,
    });
  });

  it("returns undefined for the world target (nothing to set)", () => {
    expect(cameraStopFor({ kind: "world" })).toBeUndefined();
  });
});
