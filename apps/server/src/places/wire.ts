/**
 * Production wiring for the places ingest pipeline (T-6.4 / PL-1): DuckDB
 * GeoParquet reader + the app database (the TRANSACTION-CAPABLE Neon
 * WebSocket Pool — batch upserts are real transactions; landmine #1: never
 * the Neon-HTTP driver) + the in-process queue.
 *
 * Dataset URLs come from env (release snapshots are dated — deploy-time
 * config, src/env.ts documents the verified patterns). Unset URLs boot fine:
 * jobs fail VISIBLY on their region rows (R-places-4) and user requests are
 * never affected. Boot-warning about the gap is index.ts's job — wire
 * modules stay silent (T-5.5 UNCONFIGURED_OBJECT_STORAGE precedent); this
 * module just reports what's unconfigured.
 */
import { SPINE_SOURCE_PRIORITY, type SpineSource } from "@gogo/shared/config/places";
import type { Env } from "../env.js";
import { getDb } from "../db/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createDuckDbGeoParquetReader } from "./geoparquet-reader.js";
import { createPlacesIngestQueue, type PlacesIngestTrigger } from "./ingest-queue.js";
import { ingestRegionCell, type RegionIngestDatasets } from "./region-ingest.js";
import type { PlacesRouterDeps } from "./routes.js";

export interface PlacesIngestWiring {
  trigger: PlacesIngestTrigger;
  /** Spine sources with no dataset URL configured — index.ts owns the warn. */
  unconfiguredSources: readonly SpineSource[];
}

export function buildPlacesIngest(env: Env): PlacesIngestWiring {
  const datasets: RegionIngestDatasets = {
    ...(env.PLACES_OVERTURE_PARQUET_URL ? { overture: env.PLACES_OVERTURE_PARQUET_URL } : {}),
    ...(env.PLACES_FSQ_OS_PARQUET_URL ? { fsq_os: env.PLACES_FSQ_OS_PARQUET_URL } : {}),
  };

  const reader = createDuckDbGeoParquetReader();
  const trigger = createPlacesIngestQueue({
    // db resolves lazily per job so queue construction never races boot.
    ingestCell: (cell) => ingestRegionCell({ db: getDb(), reader, datasets }, cell),
  });

  return {
    trigger,
    unconfiguredSources: SPINE_SOURCE_PRIORITY.filter((source) => datasets[source] === undefined),
  };
}

/**
 * Process-wide store for the `GET /places/search` per-user window
 * (RATE_LIMITS.placesSearch — T-6.5 enqueue-volume posture). Bucket keys are
 * rule-namespaced, so one store per process is safe (trips/wire.ts pattern).
 */
const placesRateLimitStore = new InMemoryRateLimitStore();

/**
 * Production deps for the places router (T-6.5). The DB is the Neon
 * WebSocket `Pool` (`getDb()`); every route here is single-statement, but
 * the driver choice stays uniform with the rest of the app (landmine #1).
 * `placesIngest` is THE SAME queue instance the trips router fires — one
 * queue, two triggers (destination + search-miss), one serial drain.
 */
export function buildPlacesRouterDeps(placesIngest: PlacesIngestTrigger): PlacesRouterDeps {
  return { db: getDb(), rateLimit: { store: placesRateLimitStore }, placesIngest };
}
