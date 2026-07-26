/**
 * Region grid (places spec §3.1.3, exported per §3.5): regions are cells of a
 * fixed 0.5° × 0.5° grid, `region_key = "r:{floor(lat/0.5)}:{floor(lng/0.5)}"`.
 * A destination ingests the cell containing it plus the 8 neighbors (~165 km
 * square — metro + day trips).
 *
 * ONE region definition, TWO consumers: the server's POI ingest coverage
 * (`place_ingest_regions.region_key`) and the client's offline TileRegion
 * bounds (map spec §2.5) — they must never disagree about what "the
 * destination area" means. Pure math, platform-agnostic (R-shared-9).
 */
import { PLACES_REGION_GRID_DEGREES } from "./config/places.js";

/** One grid cell: canonical key + its bbox (degrees, [min, min+0.5)). */
export interface RegionCell {
  /** Canonical region key — the `place_ingest_regions` PK component. */
  key: string;
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const GRID = PLACES_REGION_GRID_DEGREES;
/** floor(±90 / 0.5) — the last valid lat cell index is 179 ([89.5, 90]). */
const LAT_IDX_MIN = -180;
const LAT_IDX_MAX = 179;
/** Full longitude ring in cell indices: 360° / 0.5° = 720 cells. */
const LNG_IDX_SPAN = 720;

/** Wrap a longitude cell index onto the [-360, 359] ring (antimeridian). */
function wrapLngIdx(idx: number): number {
  return ((((idx % LNG_IDX_SPAN) + LNG_IDX_SPAN + LNG_IDX_SPAN / 2) % LNG_IDX_SPAN) -
    LNG_IDX_SPAN / 2);
}

function cellFromIndices(latIdx: number, lngIdx: number): RegionCell {
  // 0.5° multiples are exact in binary floating point — keys and bboxes are
  // bit-stable across platforms (idempotency by key depends on this).
  return {
    key: `r:${latIdx}:${lngIdx}`,
    minLat: latIdx * GRID,
    minLng: lngIdx * GRID,
    maxLat: latIdx * GRID + GRID,
    maxLng: lngIdx * GRID + GRID,
  };
}

function assertCoordinate(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError(`lng out of range: ${lng}`);
  }
}

/** The grid cell containing a point (spec formula; poles clamp, lng wraps). */
export function regionCellAt(lat: number, lng: number): RegionCell {
  assertCoordinate(lat, lng);
  const latIdx = Math.min(LAT_IDX_MAX, Math.max(LAT_IDX_MIN, Math.floor(lat / GRID)));
  const lngIdx = wrapLngIdx(Math.floor(lng / GRID));
  return cellFromIndices(latIdx, lngIdx);
}

/**
 * The destination's ingest coverage (§3.1.3): its cell plus the 8 neighbors.
 * The containing cell comes FIRST (ingest starts where the user actually is);
 * neighbors follow in deterministic reading order. Neighbors past a pole
 * don't exist and are dropped (8 → 5 there); neighbors across the
 * antimeridian wrap.
 */
export function regionCellsForDestination(lat: number, lng: number): RegionCell[] {
  const center = regionCellAt(lat, lng);
  const centerLatIdx = Math.min(LAT_IDX_MAX, Math.max(LAT_IDX_MIN, Math.floor(lat / GRID)));
  const centerLngIdx = wrapLngIdx(Math.floor(lng / GRID));

  const cells: RegionCell[] = [center];
  for (const dLat of [1, 0, -1]) {
    for (const dLng of [-1, 0, 1]) {
      if (dLat === 0 && dLng === 0) continue;
      const latIdx = centerLatIdx + dLat;
      if (latIdx < LAT_IDX_MIN || latIdx > LAT_IDX_MAX) continue; // past a pole
      cells.push(cellFromIndices(latIdx, wrapLngIdx(centerLngIdx + dLng)));
    }
  }
  return cells;
}
