/**
 * Search geo bound (T-8.3 / MAP-2 — R-map-25 typeahead legality). Load-
 * bearing: the envelope must (a) equal the shared ingest coverage — the
 * "one region definition" doctrine, (b) stay inside the server's 2° clamp
 * so boxes are never silently shrunk, and (c) never emit an inverted box
 * at the antimeridian (`PlaceSearchQuerySchema` REJECTS minLng > maxLng —
 * an inverted box is a live 400 on every map search for that trip).
 */
import {
  PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES,
  regionCellsForDestination,
} from "@gogo/shared";

import { bboxParamFor, searchGeoBoundFor } from "./search-geo";

describe("searchGeoBoundFor (destination-region envelope)", () => {
  it("wraps the exact 9-cell ingest coverage for an interior destination (Kyoto)", () => {
    const bound = searchGeoBoundFor({ lat: 35.0116, lng: 135.7681 });

    // Envelope of the shared cells — computed independently here.
    const cells = regionCellsForDestination(35.0116, 135.7681);
    expect(cells).toHaveLength(9);
    expect(bound.minLat).toBe(Math.min(...cells.map((cell) => cell.minLat)));
    expect(bound.maxLat).toBe(Math.max(...cells.map((cell) => cell.maxLat)));
    expect(bound.minLng).toBe(Math.min(...cells.map((cell) => cell.minLng)));
    expect(bound.maxLng).toBe(Math.max(...cells.map((cell) => cell.maxLng)));

    // 3×3 of 0.5° cells ⇒ exactly 1.5° per axis.
    expect(bound.maxLat - bound.minLat).toBeCloseTo(1.5, 10);
    expect(bound.maxLng - bound.minLng).toBeCloseTo(1.5, 10);
  });

  it("stays inside the server clamp — the box is never silently shrunk", () => {
    for (const destination of [
      { lat: 35.0116, lng: 135.7681 },
      { lat: -33.8688, lng: 151.2093 },
      { lat: 64.1466, lng: -21.9426 },
    ]) {
      const bound = searchGeoBoundFor(destination);
      expect(bound.maxLat - bound.minLat).toBeLessThanOrEqual(
        PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES,
      );
      expect(bound.maxLng - bound.minLng).toBeLessThanOrEqual(
        PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES,
      );
    }
  });

  it("clips at the antimeridian instead of inverting (Fiji-adjacent trip)", () => {
    const bound = searchGeoBoundFor({ lat: -17.7, lng: 179.9 });
    // Wrapped neighbor cells (-180 side) are dropped — the box stays
    // ordered and 1° wide on the east side.
    expect(bound.minLng).toBeLessThanOrEqual(bound.maxLng);
    expect(bound.minLng).toBe(179);
    expect(bound.maxLng).toBe(180);
  });

  it("clips symmetrically on the west side of the antimeridian", () => {
    const bound = searchGeoBoundFor({ lat: -17.7, lng: -179.9 });
    expect(bound.minLng).toBeLessThanOrEqual(bound.maxLng);
    expect(bound.minLng).toBe(-180);
    expect(bound.maxLng).toBe(-179);
  });

  it("survives a pole-adjacent destination (neighbors past the pole drop)", () => {
    const bound = searchGeoBoundFor({ lat: 89.9, lng: 10 });
    expect(bound.maxLat).toBe(90);
    expect(bound.minLat).toBe(89);
    expect(bound.minLng).toBeLessThanOrEqual(bound.maxLng);
  });
});

describe("bboxParamFor (wire format)", () => {
  it("serializes minLng,minLat,maxLng,maxLat — the PL-3 §3.3 order", () => {
    expect(bboxParamFor({ minLng: 135, minLat: 34.5, maxLng: 136.5, maxLat: 36 })).toBe(
      "135,34.5,136.5,36",
    );
  });
});
