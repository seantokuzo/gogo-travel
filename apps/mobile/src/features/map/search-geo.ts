/**
 * Map-search geo bound (T-8.3 / MAP-2 — R-map-25; PL-3 search scale bounds).
 *
 * `GET /places/search` allows 2–3-char typeahead ONLY with a geo bound
 * (`PLACES_SEARCH_TEXT_ONLY_MIN_CHARS` — the trgm-GIN scale wall,
 * `@gogo/shared` config/places.ts), so the map search always sends a `bbox`.
 *
 * WHICH BOX — the destination region, not the viewport (PR interpretation):
 * R-map-25 says "geo-biased to the current viewport", but the viewport lives
 * behind the frozen screen's MapView ref (`getVisibleBounds` is
 * ref-imperative) and the T-8.2 seam carries no camera state. The principled
 * substitute is the envelope of `regionCellsForDestination` — the EXACT grid
 * cells the POI ingestion covered (places spec §3.1.3/§3.5: "one region
 * definition, two consumers"), i.e. the only area spine search can answer
 * from anyway. 3×3 cells of 0.5° ⇒ ≤1.5° per axis, inside the server's 2°
 * clamp, so the box is never silently shrunk. Swapping to a live-viewport
 * box is a ONE-CALL-SITE change here once the integration rider exposes
 * camera state (PR escalation list).
 *
 * ANTIMERIDIAN: `PlaceSearchQuerySchema` rejects inverted boxes ("v1 has no
 * antimeridian-crossing viewport; a wrap-around search is two calls"), and
 * neighbor cells across ±180 wrap to the far side. Those wrapped cells are
 * DROPPED from the envelope — a destination within 0.5° of the antimeridian
 * searches a clipped (1°-wide) box instead of erroring (degrade-not-reject,
 * mirroring the server's own clamp posture). Pole edges need no handling:
 * `regionCellsForDestination` already drops neighbors past a pole.
 */
import { PLACES_REGION_GRID_DEGREES, regionCellsForDestination } from "@gogo/shared";

export interface SearchGeoBound {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** Cells jump by ~359.5° when wrapped; contiguous neighbors differ by ≤0.5°. */
const CONTIGUOUS_LNG_DELTA = PLACES_REGION_GRID_DEGREES * 1.5;

/**
 * Envelope of the destination's ingest-coverage cells (module doc). Total
 * over any schema-valid destination: the center cell always exists, so the
 * envelope is never empty.
 */
export function searchGeoBoundFor(destination: { lat: number; lng: number }): SearchGeoBound {
  const cells = regionCellsForDestination(destination.lat, destination.lng);
  // Center-first contract (region-grid doc) — the anchor for the wrap test.
  const center = cells[0];
  if (center === undefined) {
    // Unreachable per the shared contract; keep the function total (the
    // camera module's malformed-row posture: degrade, never crash).
    return { minLng: -180, minLat: -90, maxLng: 180, maxLat: 90 };
  }
  let minLng = center.minLng;
  let minLat = center.minLat;
  let maxLng = center.maxLng;
  let maxLat = center.maxLat;
  for (const cell of cells) {
    if (Math.abs(cell.minLng - center.minLng) > CONTIGUOUS_LNG_DELTA) continue; // wrapped
    if (cell.minLng < minLng) minLng = cell.minLng;
    if (cell.minLat < minLat) minLat = cell.minLat;
    if (cell.maxLng > maxLng) maxLng = cell.maxLng;
    if (cell.maxLat > maxLat) maxLat = cell.maxLat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/** The `bbox` wire format: `minLng,minLat,maxLng,maxLat` (PL-3 §3.3). */
export function bboxParamFor(bound: SearchGeoBound): string {
  return `${bound.minLng},${bound.minLat},${bound.maxLng},${bound.maxLat}`;
}
