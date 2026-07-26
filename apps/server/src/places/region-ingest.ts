/**
 * Region ingest job (places spec §3.1.4, PL-1): for ONE grid cell, ingest
 * both spine sources in priority order (R-places-18) — GeoParquet read →
 * normalize → dedup → batched atomic upserts → region bookkeeping.
 *
 * `place_ingest_regions` status machine, per (region, source) row:
 *   pending → running → ready | failed
 * - `ready` stamps `ingested_at` (drives the refresh window, R-places-5) +
 *   `row_count` (observability).
 * - `failed` records the error VISIBLY on the row and leaves every
 *   previously ingested `places` row intact (R-places-4) — failure is
 *   ops-visible, never data-destructive. Retries with backoff (max
 *   PLACES_INGEST_MAX_ATTEMPTS) happen inside the job before `failed` is
 *   terminal for this run; the next trigger re-enqueues (R-places-1/7).
 * - A `ready` row fresher than the refresh window SKIPS re-ingest
 *   (R-places-5); a stale/failed/partial row re-runs. No cron sweep —
 *   demand-driven only.
 */
import { and, eq, sql } from "drizzle-orm";
import { SPINE_SOURCE_PRIORITY, type SpineSource } from "@gogo/shared/config/places";
import type { RegionCell } from "@gogo/shared/region-grid";
import {
  PLACES_INGEST_BATCH_SIZE,
  PLACES_INGEST_ERROR_MAX_CHARS,
  PLACES_INGEST_MAX_ATTEMPTS,
  PLACES_INGEST_RETRY_BASE_MS,
  PLACES_REFRESH_WINDOW_MS,
} from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { GeoParquetReader } from "./geoparquet-reader.js";
import { normalizeSpineRecord } from "./normalize.js";
import { upsertSpineBatch } from "./spine-upsert.js";

/** Dataset locations per source — from env config (src/env.ts documents the
 * verified release URL patterns). Absent = that source FAILS VISIBLY on the
 * region row; it never silently no-ops (R-places-4 posture). */
export type RegionIngestDatasets = Partial<Record<SpineSource, string>>;

export interface RegionIngestDeps {
  db: DbClient;
  reader: GeoParquetReader;
  datasets: RegionIngestDatasets;
  /** Clock seam (refresh-window tests). */
  now?: () => Date;
  /** Backoff seam (tests inject a no-op to avoid real delays). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SourceIngestOutcome {
  source: SpineSource;
  /** `fresh` = skipped, last success within the refresh window (R-places-5). */
  status: "ready" | "failed" | "fresh";
  rowCount: number;
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, PLACES_INGEST_ERROR_MAX_CHARS);
}

async function regionRow(db: DbClient, regionKey: string, source: SpineSource) {
  const [row] = await db
    .select()
    .from(schema.placeIngestRegions)
    .where(
      and(
        eq(schema.placeIngestRegions.regionKey, regionKey),
        eq(schema.placeIngestRegions.source, source),
      ),
    );
  return row;
}

/** One full pass over one source's dataset for the cell. Throws on failure. */
async function ingestSourceOnce(
  deps: RegionIngestDeps,
  cell: RegionCell,
  source: SpineSource,
  datasetUrl: string,
): Promise<number> {
  let rowCount = 0;
  const batches = deps.reader.readBatches({
    source,
    datasetUrl,
    bbox: { minLat: cell.minLat, minLng: cell.minLng, maxLat: cell.maxLat, maxLng: cell.maxLng },
    batchSize: PLACES_INGEST_BATCH_SIZE,
  });
  for await (const rawBatch of batches) {
    // Junk rows drop record-by-record (normalize.ts); only infra errors
    // (reader/DB) escape and fail the attempt.
    const records = rawBatch
      .map((raw) => normalizeSpineRecord(raw))
      .filter((record) => record !== null);
    const { upserted } = await upsertSpineBatch(deps.db, source, records);
    rowCount += upserted;
  }
  return rowCount;
}

async function ingestSource(
  deps: RegionIngestDeps,
  cell: RegionCell,
  source: SpineSource,
): Promise<SourceIngestOutcome> {
  const db = deps.db;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;

  // Refresh gate (R-places-5): a fresh, successful ingest is not repeated.
  const existing = await regionRow(db, cell.key, source);
  if (
    existing &&
    existing.status === "ready" &&
    existing.ingestedAt !== null &&
    now().getTime() - existing.ingestedAt.getTime() < PLACES_REFRESH_WINDOW_MS
  ) {
    return { source, status: "fresh", rowCount: existing.rowCount ?? 0 };
  }

  // Claim the row: pending/absent/stale/failed → running. Prior
  // ingested_at/row_count are deliberately preserved until a new terminal
  // state — a failed refresh must keep showing when data was last good.
  await db
    .insert(schema.placeIngestRegions)
    .values({
      regionKey: cell.key,
      source,
      // numeric columns are string-mode (db/schema/_shared.ts).
      minLat: String(cell.minLat),
      minLng: String(cell.minLng),
      maxLat: String(cell.maxLat),
      maxLng: String(cell.maxLng),
      status: "running",
    })
    .onConflictDoUpdate({
      target: [schema.placeIngestRegions.regionKey, schema.placeIngestRegions.source],
      set: { status: "running", updatedAt: sql`now()` },
    });

  const datasetUrl = deps.datasets[source];
  const attempts = datasetUrl === undefined ? 1 : PLACES_INGEST_MAX_ATTEMPTS;
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (datasetUrl === undefined) {
        // Misconfiguration is terminal for the attempt loop but still lands
        // on the row — visible in ops queries, not fatal to anything.
        throw new Error(`${source} dataset URL is not configured`);
      }
      const rowCount = await ingestSourceOnce(deps, cell, source, datasetUrl);
      await db
        .update(schema.placeIngestRegions)
        .set({ status: "ready", error: null, ingestedAt: now(), rowCount })
        .where(
          and(
            eq(schema.placeIngestRegions.regionKey, cell.key),
            eq(schema.placeIngestRegions.source, source),
          ),
        );
      return { source, status: "ready", rowCount };
    } catch (err) {
      lastError = errorMessage(err);
      if (attempt < attempts) {
        await sleep(PLACES_INGEST_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  // All attempts failed: mark the row failed + error (R-places-4). places
  // rows from earlier successful runs — and earlier committed batches of
  // this run — are untouched; search degrades to whatever the spine holds.
  await db
    .update(schema.placeIngestRegions)
    .set({ status: "failed", error: lastError })
    .where(
      and(
        eq(schema.placeIngestRegions.regionKey, cell.key),
        eq(schema.placeIngestRegions.source, source),
      ),
    );
  return { source, status: "failed", rowCount: 0, error: lastError };
}

/**
 * Ingest one region cell across the full v1 source set, in priority order
 * (R-places-18) — overture lands first so fsq_os dedup (R-places-3) always
 * sees the higher-priority rows. One source failing does NOT stop the other:
 * each (region, source) row carries its own status.
 */
export async function ingestRegionCell(
  deps: RegionIngestDeps,
  cell: RegionCell,
): Promise<SourceIngestOutcome[]> {
  const outcomes: SourceIngestOutcome[] = [];
  for (const source of SPINE_SOURCE_PRIORITY) {
    outcomes.push(await ingestSource(deps, cell, source));
  }
  return outcomes;
}
