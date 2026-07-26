/**
 * Production wiring for the places ingest pipeline (T-6.4 / PL-1): DuckDB
 * GeoParquet reader + the app database (the TRANSACTION-CAPABLE Neon
 * WebSocket Pool — batch upserts are real transactions; landmine #1: never
 * the Neon-HTTP driver) + the in-process queue.
 *
 * Dataset URLs come from env (release snapshots are dated — deploy-time
 * config, src/env.ts documents the verified patterns). Unset URLs boot fine:
 * jobs fail VISIBLY on their region rows (R-places-4), user requests are
 * never affected, and we warn once at boot so it's not a silent gap.
 */
import type { Env } from "../env.js";
import { getDb } from "../db/index.js";
import { createDuckDbGeoParquetReader } from "./geoparquet-reader.js";
import { createPlacesIngestQueue, type PlacesIngestTrigger } from "./ingest-queue.js";
import { ingestRegionCell, type RegionIngestDatasets } from "./region-ingest.js";

export function buildPlacesIngest(env: Env): PlacesIngestTrigger {
  const datasets: RegionIngestDatasets = {
    ...(env.PLACES_OVERTURE_PARQUET_URL ? { overture: env.PLACES_OVERTURE_PARQUET_URL } : {}),
    ...(env.PLACES_FSQ_OS_PARQUET_URL ? { fsq_os: env.PLACES_FSQ_OS_PARQUET_URL } : {}),
  };
  if (!datasets.overture || !datasets.fsq_os) {
    console.warn(
      "[boot] places ingest dataset URL(s) not configured — region ingests will record `failed` until PLACES_*_PARQUET_URL are set",
    );
  }

  const reader = createDuckDbGeoParquetReader();
  return createPlacesIngestQueue({
    // db resolves lazily per job so queue construction never races boot.
    ingestCell: (cell) => ingestRegionCell({ db: getDb(), reader, datasets }, cell),
  });
}
