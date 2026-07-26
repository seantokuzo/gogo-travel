/**
 * GeoParquet reading seam (places spec §3.1.4 steps 1–2): bbox-filtered,
 * BATCHED reads of the Overture / FSQ OS Places snapshots. The interface is
 * the test seam (stub readers exercise failure paths); the DuckDB
 * implementation is production — `@duckdb/node-api` (the current DuckDB Node
 * client, prebuilt native bindings, in-process, no server).
 *
 * Memory posture: results STREAM through DuckDB's chunked reader — a batch
 * (≤ batchSize rows) is the largest unit ever held, never a whole country
 * parquet (§3.1 bounded-batch contract).
 *
 * Network posture: local file paths read with ZERO extensions (tests/fixtures
 * — no network, Law #5-safe in CI). Remote `s3://`/`https://` dataset URLs
 * (prod) autoload DuckDB's httpfs at first use — prod-only, never in tests.
 */
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import type { SpineSource } from "@gogo/shared/config/places";
import type { RawSpineRecord } from "./normalize.js";

export interface SpineBbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface ReadBatchesOptions {
  source: SpineSource;
  /** Dataset location — local path (tests/fixtures) or remote URL (prod). */
  datasetUrl: string;
  bbox: SpineBbox;
  batchSize: number;
}

export interface GeoParquetReader {
  /** Yields raw records in bounded batches; throws on unreadable datasets. */
  readBatches(opts: ReadBatchesOptions): AsyncGenerator<RawSpineRecord[], void, undefined>;
}

// ---------------------------------------------------------------------------
// Per-source SELECTs — the ONLY place source column layouts are known.
// Output column order is fixed: source_id, name, lat, lng, category.
// Neither open snapshot carries a Wikidata ref (§3.1.4 step 3: "mapped when
// the source carries" one) — wiki_ref is NULL for both until a source grows
// the column.
// ---------------------------------------------------------------------------

/** Single-quote a path/URL for embedding in SQL (config-provided, not user input). */
function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sourceSelect(source: SpineSource, datasetUrl: string): string {
  const from = `read_parquet(${quoteSqlString(datasetUrl)})`;
  switch (source) {
    case "overture":
      // Overture GeoParquet: geometry is WKB, but every row carries a bbox
      // struct and places are points (bbox.xmin = lng, bbox.ymin = lat) — so
      // the bbox columns ARE the coordinates. This sidesteps the spatial
      // extension entirely (a runtime extension download = network in CI).
      return `
        select
          id                    as source_id,
          names."primary"       as name,
          bbox.ymin             as lat,
          bbox.xmin             as lng,
          categories."primary"  as category
        from ${from}
        where bbox.ymin >= $min_lat and bbox.ymin < $max_lat
          and bbox.xmin >= $min_lng and bbox.xmin < $max_lng`;
    case "fsq_os":
      // FSQ OS Places: flat latitude/longitude doubles; categories are a
      // label list — the FIRST label is the primary raw taxonomy string
      // (stored as-is per §3.1.4 step 3).
      return `
        select
          fsq_place_id as source_id,
          name         as name,
          latitude     as lat,
          longitude    as lng,
          case
            when fsq_category_labels is not null and len(fsq_category_labels) > 0
            then fsq_category_labels[1]
            else null
          end          as category
        from ${from}
        where latitude  >= $min_lat and latitude  < $max_lat
          and longitude >= $min_lng and longitude < $max_lng`;
  }
}

function asString(value: DuckDBValue): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: DuckDBValue): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

export interface DuckDbGeoParquetReader extends GeoParquetReader {
  /** Tear down the in-process DuckDB instance (test teardown / shutdown). */
  close(): void;
}

export function createDuckDbGeoParquetReader(): DuckDbGeoParquetReader {
  let instance: DuckDBInstance | undefined;

  async function connect(): Promise<DuckDBConnection> {
    instance ??= await DuckDBInstance.create(":memory:");
    return instance.connect();
  }

  return {
    async *readBatches(opts) {
      const connection = await connect();
      try {
        const result = await connection.stream(sourceSelect(opts.source, opts.datasetUrl), {
          min_lat: opts.bbox.minLat,
          max_lat: opts.bbox.maxLat,
          min_lng: opts.bbox.minLng,
          max_lng: opts.bbox.maxLng,
        });

        let pending: RawSpineRecord[] = [];
        for (;;) {
          const chunk = await result.fetchChunk();
          if (!chunk || chunk.rowCount === 0) break;
          for (const row of chunk.getRows()) {
            pending.push({
              sourceId: asString(row[0] ?? null),
              name: asString(row[1] ?? null),
              lat: asNumber(row[2] ?? null),
              lng: asNumber(row[3] ?? null),
              category: asString(row[4] ?? null),
              wikiRef: null,
            });
            if (pending.length >= opts.batchSize) {
              yield pending;
              pending = [];
            }
          }
        }
        if (pending.length > 0) yield pending;
      } finally {
        connection.closeSync();
      }
    },

    close() {
      instance?.closeSync();
      instance = undefined;
    },
  };
}
