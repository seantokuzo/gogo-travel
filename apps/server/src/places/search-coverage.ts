/**
 * Search-miss coverage check (T-6.5; R-places-7's "targets an area with no
 * ingested region"): which grid cells of a geo search's area lack FRESH
 * coverage — i.e. for at least one spine source there is no `ready`
 * `place_ingest_regions` row within the refresh window (R-places-5's exact
 * freshness rule; the job re-checks per source, so a false positive here
 * costs one no-op job, never duplicate data).
 *
 * The route feeds the result to `enqueueSearchMiss` (T-6.4's seam), which
 * owns the per-cell throttle + the global budget. Everything here is
 * best-effort by contract — the caller wraps it so a failure can never fail
 * the search (R-places-7: never an error, never a block).
 */
import { inArray } from "drizzle-orm";
import { SPINE_SOURCE_PRIORITY } from "@gogo/shared/config/places";
import type { RegionCell } from "@gogo/shared/region-grid";
import { PLACES_REFRESH_WINDOW_MS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { SearchBox } from "./search-query.js";

/** Intersection of two boxes (both filters given ⇒ the searched area is the
 * overlap); `null` when they don't meet. */
export function intersectBoxes(a: SearchBox, b: SearchBox): SearchBox | null {
  const box = {
    minLat: Math.max(a.minLat, b.minLat),
    minLng: Math.max(a.minLng, b.minLng),
    maxLat: Math.min(a.maxLat, b.maxLat),
    maxLng: Math.min(a.maxLng, b.maxLng),
  };
  return box.minLat <= box.maxLat && box.minLng <= box.maxLng ? box : null;
}

/** The cells among `cells` lacking fresh full-source coverage. */
export async function staleSearchCells(
  db: DbClient,
  cells: readonly RegionCell[],
  now: Date,
): Promise<RegionCell[]> {
  if (cells.length === 0) return [];

  const rows = await db
    .select({
      regionKey: schema.placeIngestRegions.regionKey,
      source: schema.placeIngestRegions.source,
      status: schema.placeIngestRegions.status,
      ingestedAt: schema.placeIngestRegions.ingestedAt,
    })
    .from(schema.placeIngestRegions)
    .where(
      inArray(
        schema.placeIngestRegions.regionKey,
        cells.map((cell) => cell.key),
      ),
    );

  const freshSources = new Map<string, Set<string>>();
  for (const row of rows) {
    const fresh =
      row.status === "ready" &&
      row.ingestedAt !== null &&
      now.getTime() - row.ingestedAt.getTime() < PLACES_REFRESH_WINDOW_MS;
    if (!fresh) continue;
    const set = freshSources.get(row.regionKey) ?? new Set<string>();
    set.add(row.source);
    freshSources.set(row.regionKey, set);
  }

  return cells.filter((cell) => {
    const fresh = freshSources.get(cell.key);
    return SPINE_SOURCE_PRIORITY.some((source) => !fresh?.has(source));
  });
}
