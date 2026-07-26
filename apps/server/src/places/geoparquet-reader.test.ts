/**
 * DuckDB GeoParquet reader — THE prod read path (round-1 blocking #3): the
 * batch-boundary logic (pending-slice reset) and the chunk-fetch loop never
 * executed under the tiny-fixture db suite (8 rows vs batchSize 500). These
 * tests force both: small batchSize over the committed fixture, and a
 * >2048-row generated file so multiple DuckDB chunks stream through.
 *
 * No Docker, no network — local parquet only (DuckDB loads zero extensions).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, describe, expect, it } from "vitest";
import { createDuckDbGeoParquetReader } from "./geoparquet-reader.js";
import type { RawSpineRecord } from "./normalize.js";

const OVERTURE_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/overture-places.parquet", import.meta.url),
);

/** The committed fixture's full row inventory (generator script header). */
const OVERTURE_FIXTURE_IDS = [
  "ovt-belem-tower",
  "ovt-time-out-market",
  "ovt-castelo",
  "ovt-null-category",
  "ovt-setubal",
  "ovt-porto",
  "ovt-blank-name",
  "ovt-null-name",
];

/** Wide bbox containing every fixture row (incl. Porto at 41.15, -8.61). */
const ALL_ROWS_BBOX = { minLat: 30, maxLat: 45, minLng: -10, maxLng: -8 };

const reader = createDuckDbGeoParquetReader();

afterAll(() => {
  reader.close();
});

async function collect(
  batches: AsyncGenerator<RawSpineRecord[], void, undefined>,
): Promise<RawSpineRecord[][]> {
  const out: RawSpineRecord[][] = [];
  for await (const batch of batches) out.push(batch);
  return out;
}

describe("DuckDbGeoParquetReader", () => {
  it("slices the stream into bounded batches — [3,3,2] over the 8-row fixture, no dupes, no boundary drops", async () => {
    const batches = await collect(
      reader.readBatches({
        source: "overture",
        datasetUrl: OVERTURE_FIXTURE,
        bbox: ALL_ROWS_BBOX,
        batchSize: 3,
      }),
    );

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 2]);
    const ids = batches.flat().map((record) => record.sourceId);
    expect(ids).toHaveLength(8); // exactly once each — a pending-reset dup
    expect(new Set(ids)).toEqual(new Set(OVERTURE_FIXTURE_IDS)); // or drop fails here
  });

  it("maps source columns faithfully and the fixture NFD assumption holds", async () => {
    const [batch] = await collect(
      reader.readBatches({
        source: "overture",
        datasetUrl: OVERTURE_FIXTURE,
        bbox: ALL_ROWS_BBOX,
        batchSize: 100,
      }),
    );
    const byId = new Map(batch?.map((record) => [record.sourceId, record]));

    // Field mapping: bbox.ymin/xmin ARE the point (float32 quantization dust).
    const porto = byId.get("ovt-porto");
    expect(porto?.name).toBe("Livraria Lello");
    expect(porto?.category).toBe("bookstore");
    expect(porto?.lat).toBeCloseTo(41.1469, 4);
    expect(porto?.lng).toBeCloseTo(-8.6147, 4);
    expect(porto?.wikiRef).toBeNull(); // neither open snapshot carries one

    // Self-guard the fixture's NFD assumption (round-1 advisory #8): the
    // committed parquet stores "Belém" DECOMPOSED — if a fixture regen ever
    // ships NFC bytes, the db suite's NFC-normalization assertion would go
    // tautological; fail HERE instead.
    const belemRaw = byId.get("ovt-belem-tower")?.name;
    expect(belemRaw).toBeDefined();
    expect(belemRaw).not.toBe(belemRaw?.normalize("NFC"));

    // NULL columns surface as nulls, not strings.
    expect(byId.get("ovt-null-category")?.category).toBeNull();
    expect(byId.get("ovt-null-name")?.name).toBeNull();
  });

  it("crosses DuckDB chunk boundaries (>2048 rows) with no loss or duplication", async () => {
    // Generate a 5,000-row FSQ-shaped parquet at test time (temp dir, no
    // committed blob): 5,000 rows > 2 full 2,048-row chunks, and batchSize
    // 999 forces batch boundaries that straddle chunk boundaries.
    const dir = mkdtempSync(join(tmpdir(), "gogo-places-reader-"));
    try {
      const bigPath = join(dir, "many-places.parquet");
      const instance = await DuckDBInstance.create(":memory:");
      const connection = await instance.connect();
      await connection.run(`
        copy (
          select
            'fsq-big-' || i::varchar             as fsq_place_id,
            'Venue ' || i::varchar               as name,
            38.5 + (i % 100) * 0.001             as latitude,
            -9.4 + (i // 100) * 0.001            as longitude,
            CAST(NULL AS VARCHAR[])              as fsq_category_labels
          from range(5000) t(i)
        ) to '${bigPath.replaceAll("'", "''")}' (format parquet)
      `);
      connection.closeSync();
      instance.closeSync();

      const batches = await collect(
        reader.readBatches({
          source: "fsq_os",
          datasetUrl: bigPath,
          bbox: { minLat: 38, maxLat: 39, minLng: -10, maxLng: -9 },
          batchSize: 999,
        }),
      );

      expect(batches.map((batch) => batch.length)).toEqual([999, 999, 999, 999, 999, 5]);
      const ids = batches.flat().map((record) => record.sourceId);
      expect(ids).toHaveLength(5000);
      expect(new Set(ids).size).toBe(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
