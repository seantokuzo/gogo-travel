/**
 * T-6.4 places-ingest integration suite (PL-1 acceptance checklist): the
 * region ingest job end-to-end on a real Postgres + the REAL DuckDB
 * GeoParquet reader over committed fixtures (scripts/generate-places-fixtures.ts
 * documents the row inventory — change either side in lockstep):
 *
 * - full destination ingest (9 cells × 2 sources), normalize (NFC/drops),
 *   cross-source dedup with `overture > fsq_os` priority (R-places-3/18)
 * - idempotent re-run: stable row counts, untouched unchanged rows (R-places-2)
 * - refresh window respected (R-places-5)
 * - failure path: region marked `failed` + error, ALL prior data intact
 *   (R-places-4); retry-with-backoff; recovery run
 * - trip-create / destination-change triggers fire POST-COMMIT and can never
 *   fail the request (R-places-1)
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. Fixtures are local files: DuckDB loads NO extensions and touches
 * NO network (Law #5).
 */
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { regionCellsForDestination } from "@gogo/shared/region-grid";
import type { SpineSource } from "@gogo/shared/config/places";
import { TripWithRoleSchema } from "@gogo/shared/domains/trip";
import { createApp } from "../app.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import {
  createDuckDbGeoParquetReader,
  type DuckDbGeoParquetReader,
  type GeoParquetReader,
} from "./geoparquet-reader.js";
import type { PlacesIngestTrigger } from "./ingest-queue.js";
import type { RawSpineRecord, SpineRecord } from "./normalize.js";
import { ingestRegionCell, type RegionIngestDeps } from "./region-ingest.js";
import { crossSourceDuplicateQuery } from "./spine-upsert.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place now: src/test/global-setup.ts (T-S3.3 shared container; the
// `--no-file-parallelism` workaround is retired — QUEUE P1).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
const INGEST_TIMEOUT_MS = 120_000;

const OVERTURE_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/overture-places.parquet", import.meta.url),
);
const FSQ_FIXTURE = fileURLToPath(new URL("./__fixtures__/fsq-os-places.parquet", import.meta.url));
const CORRUPT_FIXTURE = fileURLToPath(new URL("./__fixtures__/corrupt.parquet", import.meta.url));

/** Lisbon — T-6.1's canonical destination; center cell r:77:-19. */
const LISBON = { lat: 38.722252, lng: -9.139337 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Base wall-clock for the suite; refresh-window math derives from it. */
const T0 = new Date("2026-07-25T12:00:00.000Z");

describe.skipIf(!dockerAvailable)("T-6.4 places ingest pipeline (integration)", () => {
  let suiteDb: SuiteDb;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let reader: DuckDbGeoParquetReader;

  const goodDatasets = { overture: OVERTURE_FIXTURE, fsq_os: FSQ_FIXTURE };

  beforeAll(async () => {
    suiteDb = await createSuiteDb("places_region_ingest");
    client = suiteDb.client;
    db = suiteDb.db;
    reader = createDuckDbGeoParquetReader();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    reader?.close();
    await suiteDb?.drop();
  });

  const depsWith = (overrides: Partial<RegionIngestDeps> = {}): RegionIngestDeps => ({
    db,
    reader,
    datasets: goodDatasets,
    now: () => T0,
    sleep: () => Promise.resolve(),
    ...overrides,
  });

  const placesCount = async () => {
    const rows = await db.select({ id: schema.places.id }).from(schema.places);
    return rows.length;
  };

  const placeBySourceId = async (source: SpineSource, sourceId: string) => {
    const [row] = await db
      .select()
      .from(schema.places)
      .where(and(eq(schema.places.source, source), eq(schema.places.sourceId, sourceId)));
    return row;
  };

  const regionRowOf = async (regionKey: string, source: SpineSource) => {
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
  };

  const lisbonCells = regionCellsForDestination(LISBON.lat, LISBON.lng);
  const centerCell = lisbonCells[0]!;

  // ===========================================================================
  // Full destination ingest on the fixtures (§3.1.4; R-places-2/3/18)
  // ===========================================================================

  it(
    "ingests a destination's 9 cells from both sources: normalize, dedup, bookkeeping",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      for (const cell of lisbonCells) {
        const outcomes = await ingestRegionCell(depsWith(), cell);
        // Priority order is the execution order (R-places-18).
        expect(outcomes.map((o) => o.source)).toEqual(["overture", "fsq_os"]);
        expect(outcomes.every((o) => o.status === "ready")).toBe(true);
      }

      // Fixture inventory: 5 overture + 5 fsq survive normalize+dedup.
      expect(await placesCount()).toBe(10);

      // NFC normalization: the fixture name is NFD; the stored row is NFC.
      const belem = await placeBySourceId("overture", "ovt-belem-tower");
      expect(belem?.name).toBe("Belém Tower".normalize("NFC"));
      expect(belem?.name).toBe(belem?.name.normalize("NFC"));
      // Overture bbox columns are float32 (real schema) — coordinates carry
      // ~1e-6° quantization (≈ 0.1 m), invisible at map scale.
      expect(Number(belem?.lat)).toBeCloseTo(38.6916, 5);
      expect(belem?.category).toBe("tourist_attraction");
      expect(belem?.wikiRef).toBeNull();
      expect(belem?.createdBy).toBeNull();

      // Cross-source dedup (R-places-3): the FSQ twin of Time Out Market is
      // SKIPPED — one physical venue, one row, higher-priority source wins.
      expect(await placeBySourceId("fsq_os", "fsq-time-out")).toBeUndefined();
      expect(await placeBySourceId("overture", "ovt-time-out-market")).toBeDefined();
      // …but near-name-far-away and near-far-name candidates both survive:
      expect(await placeBySourceId("fsq_os", "fsq-timeout-far")).toBeDefined(); // distance half
      expect(await placeBySourceId("fsq_os", "fsq-ribeira")).toBeDefined(); // similarity half

      // Normalize drops: blank/NULL names never landed; out-of-coverage
      // Porto row never read (bbox filter).
      expect(await placeBySourceId("overture", "ovt-blank-name")).toBeUndefined();
      expect(await placeBySourceId("overture", "ovt-null-name")).toBeUndefined();
      expect(await placeBySourceId("overture", "ovt-porto")).toBeUndefined();
      expect(await placeBySourceId("fsq_os", "fsq-empty-name")).toBeUndefined();

      // Raw category strings stored as-is; NULL label list → NULL category.
      const pasteis = await placeBySourceId("fsq_os", "fsq-pasteis");
      expect(pasteis?.category).toBe("Dining and Drinking > Bakery");
      expect(pasteis?.name).toBe("Pastéis de Belém".normalize("NFC"));
      expect((await placeBySourceId("fsq_os", "fsq-null-cats"))?.category).toBeNull();
      expect((await placeBySourceId("overture", "ovt-null-category"))?.category).toBeNull();

      // Region bookkeeping (§3.1.2): 9 cells × 2 sources, all ready, counts
      // per cell, bbox recorded, ingested_at stamped with the job clock.
      const regionRows = await db.select().from(schema.placeIngestRegions);
      expect(regionRows).toHaveLength(18);
      expect(regionRows.every((row) => row.status === "ready")).toBe(true);
      expect(regionRows.every((row) => row.ingestedAt?.getTime() === T0.getTime())).toBe(true);

      const centerOverture = await regionRowOf(centerCell.key, "overture");
      expect(centerOverture?.rowCount).toBe(4);
      expect(Number(centerOverture?.minLat)).toBe(38.5);
      expect(Number(centerOverture?.maxLng)).toBe(-9);
      expect((await regionRowOf(centerCell.key, "fsq_os"))?.rowCount).toBe(4);
      expect((await regionRowOf("r:77:-18", "overture"))?.rowCount).toBe(1);
      expect((await regionRowOf("r:77:-18", "fsq_os"))?.rowCount).toBe(1);
      expect((await regionRowOf("r:78:-19", "overture"))?.rowCount).toBe(0);
    },
  );

  // ===========================================================================
  // Dedup probe plan shape (round-1 blocking #1)
  // ===========================================================================

  it("the dedup probe is SARGABLE — places_lat_lng_idx drives it, not a seq scan", async () => {
    // EXPLAIN the EXACT production query (exported unexecuted) with seq scans
    // penalized: if the box prefilter is index-usable the planner takes
    // places_lat_lng_idx; a non-sargable regression (cast/abs() on the
    // column) leaves only the penalized seq scan and fails here.
    const probe: SpineRecord[] = [
      { sourceId: "probe-1", name: "Probe Venue", lat: 38.7067, lng: -9.1459, category: null, wikiRef: null },
    ];
    const { sql: text, params } = crossSourceDuplicateQuery(db, "fsq_os", probe).toSQL();

    const planRows = await client.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx.unsafe(`explain (costs false) ${text}`, params as never[]);
    });
    const plan = planRows.map((row) => String(Object.values(row as object)[0])).join("\n");
    expect(plan).toContain("places_lat_lng_idx");
    expect(plan).not.toMatch(/Seq Scan on places\b/);
  });

  // ===========================================================================
  // Idempotent re-run + refresh window (R-places-2/5)
  // ===========================================================================

  it(
    "re-run past the refresh window is idempotent: stable counts, refresh PROPAGATES, nothing deleted",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      const before = await placeBySourceId("overture", "ovt-belem-tower");
      const t91 = new Date(T0.getTime() + 91 * DAY_MS);

      // R-places-2 pins (round-1 blocking #2) — a byte-identical re-run can't
      // tell DO UPDATE from DO NOTHING, and can't see deletes. So:
      // (a) STALE one row — the re-run must heal it (upsert propagates);
      const [staled] = await db
        .update(schema.places)
        .set({ name: "STALE NAME SENTINEL" })
        .where(
          and(eq(schema.places.source, "overture"), eq(schema.places.sourceId, "ovt-castelo")),
        )
        .returning();
      expect(staled?.name).toBe("STALE NAME SENTINEL");
      // (b) GHOST a row — upstream disappearance is NOT row removal; a
      // sync-to-snapshot deleter would kill it and still pass count checks
      // that only compare re-run to re-run.
      await db.insert(schema.places).values({
        source: "overture",
        sourceId: "ovt-ghost-vanished",
        name: "Ghost Venue (gone upstream)",
        lat: "38.600000",
        lng: "-9.300000",
      });

      for (const cell of lisbonCells) {
        const outcomes = await ingestRegionCell(depsWith({ now: () => t91 }), cell);
        expect(outcomes.every((o) => o.status === "ready")).toBe(true);
      }

      // Row counts stable (PL-1 acceptance): 10 fixture rows + the surviving
      // ghost — upsert never insert-dupes, refresh never deletes (R-places-2).
      expect(await placesCount()).toBe(11);
      expect(await placeBySourceId("overture", "ovt-ghost-vanished")).toBeDefined();

      // Refresh PROPAGATED: the staled row healed back to the dataset value
      // and its updated_at moved (a DO NOTHING regression fails here).
      const healed = await placeBySourceId("overture", "ovt-castelo");
      expect(healed?.name).toBe("Castelo de São Jorge".normalize("NFC"));
      expect(healed?.updatedAt.getTime()).not.toBe(staled?.updatedAt.getTime());

      // An unchanged row was not even touched (upsert setWhere): updated_at
      // did not move.
      const after = await placeBySourceId("overture", "ovt-belem-tower");
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
      // Bookkeeping refreshed.
      expect((await regionRowOf(centerCell.key, "overture"))?.ingestedAt?.getTime()).toBe(
        t91.getTime(),
      );
    },
  );

  it(
    "a trigger inside the refresh window SKIPS re-ingest (R-places-5)",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      const t91 = new Date(T0.getTime() + 91 * DAY_MS);
      const t92 = new Date(t91.getTime() + 1 * DAY_MS);

      const outcomes = await ingestRegionCell(depsWith({ now: () => t92 }), centerCell);
      expect(outcomes.map((o) => o.status)).toEqual(["fresh", "fresh"]);

      // ingested_at unchanged — nothing ran.
      expect((await regionRowOf(centerCell.key, "overture"))?.ingestedAt?.getTime()).toBe(
        t91.getTime(),
      );
      expect(await placesCount()).toBe(11);
    },
  );

  // ===========================================================================
  // Failure path (R-places-4): failed + error, data intact, retries, recovery
  // ===========================================================================

  it(
    "a failing source marks ITS region row failed, retries with backoff, and preserves all data",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      const t91 = new Date(T0.getTime() + 91 * DAY_MS);
      const t183 = new Date(T0.getTime() + 183 * DAY_MS); // past the window again
      const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

      const outcomes = await ingestRegionCell(
        depsWith({
          datasets: { overture: OVERTURE_FIXTURE, fsq_os: CORRUPT_FIXTURE },
          now: () => t183,
          sleep,
        }),
        centerCell,
      );

      // Sources are independent: overture re-ingested fine, fsq_os failed.
      expect(outcomes[0]).toMatchObject({ source: "overture", status: "ready", rowCount: 4 });
      expect(outcomes[1]?.source).toBe("fsq_os");
      expect(outcomes[1]?.status).toBe("failed");
      expect(outcomes[1]?.error).toBeTruthy();
      // Redaction (round-1 advisory #5): the configured dataset location
      // never persists verbatim — delivery may become token-gated.
      expect(outcomes[1]?.error).not.toContain(CORRUPT_FIXTURE);

      // Backoff: 3 attempts ⇒ 2 sleeps, exponential (§3.1.4 step 6).
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);

      // The failure is VISIBLE on the row; prior success telemetry is
      // PRESERVED (when data was last good), and no places row vanished.
      const failedRow = await regionRowOf(centerCell.key, "fsq_os");
      expect(failedRow?.status).toBe("failed");
      expect(failedRow?.error).toBeTruthy();
      expect(failedRow?.error).not.toContain(CORRUPT_FIXTURE);
      expect(failedRow?.ingestedAt?.getTime()).toBe(t91.getTime());
      expect(failedRow?.rowCount).toBe(4);
      expect(await placesCount()).toBe(11);
      expect(await placeBySourceId("fsq_os", "fsq-pasteis")).toBeDefined();
    },
  );

  it(
    "a failed region re-runs on the next trigger (no freshness shield) and recovers",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      const t183 = new Date(T0.getTime() + 183 * DAY_MS);

      const outcomes = await ingestRegionCell(depsWith({ now: () => t183 }), centerCell);
      // overture is now fresh (it succeeded at t183); fsq_os re-ran + healed.
      expect(outcomes[0]?.status).toBe("fresh");
      expect(outcomes[1]).toMatchObject({ source: "fsq_os", status: "ready", rowCount: 4 });

      const healed = await regionRowOf(centerCell.key, "fsq_os");
      expect(healed?.status).toBe("ready");
      expect(healed?.error).toBeNull();
      expect(healed?.ingestedAt?.getTime()).toBe(t183.getTime());
      expect(await placesCount()).toBe(11);
    },
  );

  it(
    "an unconfigured dataset URL fails VISIBLY on the region row — no retries, nothing breaks",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      // Porto — untouched cell, so this exercises the pending→failed path.
      const portoCell = regionCellsForDestination(41.1579, -8.6291)[0]!;
      const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
      const before = await placesCount();

      const outcomes = await ingestRegionCell(
        depsWith({ datasets: {}, sleep }),
        portoCell,
      );

      expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed"]);
      expect(outcomes[0]?.error).toMatch(/not configured/);
      expect(sleep).not.toHaveBeenCalled(); // misconfiguration ≠ transient

      const row = await regionRowOf(portoCell.key, "overture");
      expect(row?.status).toBe("failed");
      expect(row?.error).toMatch(/not configured/);
      expect(row?.ingestedAt).toBeNull();
      expect(await placesCount()).toBe(before);
    },
  );

  it(
    "a mid-stream reader failure keeps committed batches and marks the region failed",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      // Sydney — untouched cell. Stub reader: overture yields one good batch
      // then explodes (every attempt); fsq_os succeeds empty.
      const sydneyCell = regionCellsForDestination(-33.8688, 151.2093)[0]!;
      const midStreamReader: GeoParquetReader = {
        async *readBatches(opts) {
          await Promise.resolve(); // async seam parity with the real reader
          if (opts.source === "fsq_os") return;
          const batch: RawSpineRecord[] = [
            { sourceId: "ovt-syd-1", name: "Sydney Opera House", lat: -33.8568, lng: 151.2153, category: "landmark", wikiRef: null },
            { sourceId: "ovt-syd-2", name: "Royal Botanic Garden", lat: -33.8642, lng: 151.2166, category: "garden", wikiRef: null },
          ];
          yield batch;
          // Real reader errors embed the dataset location — deterministic
          // input for the URL-redaction assertion below (advisory #5).
          throw new Error(`mid-stream explosion reading ${opts.datasetUrl}`);
        },
      };

      const outcomes = await ingestRegionCell(
        depsWith({ reader: midStreamReader }),
        sydneyCell,
      );

      expect(outcomes[0]?.status).toBe("failed");
      expect(outcomes[0]?.error).toContain("mid-stream explosion");
      // The configured URL was REDACTED to a source placeholder before the
      // message hit the row (delivery may become token-gated; Law #1 posture).
      expect(outcomes[0]?.error).toContain("<overture dataset URL>");
      expect(outcomes[0]?.error).not.toContain(OVERTURE_FIXTURE);
      expect(outcomes[1]).toMatchObject({ source: "fsq_os", status: "ready", rowCount: 0 });

      // The batch that committed BEFORE the failure is intact (R-places-4:
      // leave previously ingested data intact) — atomic per batch, not
      // all-or-nothing per region.
      expect(await placeBySourceId("overture", "ovt-syd-1")).toBeDefined();
      expect(await placeBySourceId("overture", "ovt-syd-2")).toBeDefined();
      const failedRow = await regionRowOf(sydneyCell.key, "overture");
      expect(failedRow?.status).toBe("failed");
      expect(failedRow?.error).toContain("<overture dataset URL>");
      expect(failedRow?.error).not.toContain(OVERTURE_FIXTURE);
    },
  );

  it(
    "a transient failure heals within one job run (retry-then-success)",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      // Paris — untouched cell. First two attempts die, third succeeds.
      const parisCell = regionCellsForDestination(48.8566, 2.3522)[0]!;
      let attempts = 0;
      const flakyReader: GeoParquetReader = {
        async *readBatches(opts) {
          await Promise.resolve(); // async seam parity with the real reader
          if (opts.source === "fsq_os") return;
          attempts += 1;
          if (attempts < 3) throw new Error(`transient ${attempts}`);
          yield [
            { sourceId: "ovt-paris-1", name: "Tour Eiffel", lat: 48.8584, lng: 2.2945, category: "landmark", wikiRef: null },
          ] satisfies RawSpineRecord[];
        },
      };
      const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

      const outcomes = await ingestRegionCell(
        depsWith({ reader: flakyReader, sleep }),
        parisCell,
      );

      expect(outcomes[0]).toMatchObject({ source: "overture", status: "ready", rowCount: 1 });
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
      const row = await regionRowOf(parisCell.key, "overture");
      expect(row?.status).toBe("ready");
      expect(row?.error).toBeNull();
      expect(await placeBySourceId("overture", "ovt-paris-1")).toBeDefined();
    },
  );

  it(
    "an own-(source,source_id) row REFRESHES on re-ingest even once it duplicates a new higher-priority place",
    { timeout: INGEST_TIMEOUT_MS },
    async () => {
      // REVERSE landing order (round-1 advisory #9): fsq_os arrives FIRST
      // (overture snapshot down), then overture heals — the fsq twin now
      // matches the dedup predicate (identical name, ~2 m apart) but already
      // exists under its own (source, source_id): it must take the UPSERT
      // branch (payload refreshes) rather than dedup-skip into staleness.
      // Skip-inserting governs NEW candidates only (R-places-3); deletion is
      // forbidden either way (R-places-2).
      const romeCell = regionCellsForDestination(41.9028, 12.4964)[0]!;
      let overtureHealthy = false;
      let fsqCategory = "Retail > Market v1";
      const reorderReader: GeoParquetReader = {
        async *readBatches(opts) {
          await Promise.resolve();
          if (opts.source === "overture") {
            if (!overtureHealthy) throw new Error("overture snapshot unavailable");
            yield [
              { sourceId: "ovt-rome-market", name: "Mercato Centrale Roma", lat: 41.90101, lng: 12.50121, category: "market", wikiRef: null },
            ] satisfies RawSpineRecord[];
            return;
          }
          yield [
            { sourceId: "fsq-rome-twin", name: "Mercato Centrale Roma", lat: 41.901, lng: 12.5012, category: fsqCategory, wikiRef: null },
          ] satisfies RawSpineRecord[];
        },
      };

      // Run 1: overture fails all attempts; the fsq twin lands unopposed.
      const run1 = await ingestRegionCell(depsWith({ reader: reorderReader }), romeCell);
      expect(run1[0]?.status).toBe("failed");
      expect(run1[1]).toMatchObject({ source: "fsq_os", status: "ready", rowCount: 1 });
      expect((await placeBySourceId("fsq_os", "fsq-rome-twin"))?.category).toBe(
        "Retail > Market v1",
      );

      // Run 2 (past the window): overture heals; fsq re-ingests a CHANGED
      // payload for the same source_id.
      overtureHealthy = true;
      fsqCategory = "Retail > Market v2";
      const t91 = new Date(T0.getTime() + 91 * DAY_MS);
      const run2 = await ingestRegionCell(
        depsWith({ reader: reorderReader, now: () => t91 }),
        romeCell,
      );
      expect(run2[0]).toMatchObject({ source: "overture", status: "ready", rowCount: 1 });
      // rowCount 1 (upserted), not 0 (dedup-skipped) — the discriminator.
      expect(run2[1]).toMatchObject({ source: "fsq_os", status: "ready", rowCount: 1 });

      // The twin REFRESHED (new payload visible) and both rows exist; a
      // dedup-skip regression would strand v1 here.
      expect((await placeBySourceId("fsq_os", "fsq-rome-twin"))?.category).toBe(
        "Retail > Market v2",
      );
      expect(await placeBySourceId("overture", "ovt-rome-market")).toBeDefined();
    },
  );

  // ===========================================================================
  // Trip-create / destination-change triggers (R-places-1, enqueue half)
  // ===========================================================================

  describe("trip-create + destination-change triggers", () => {
    let app: ReturnType<typeof createApp>;
    let signer: AccessTokenSigner;
    let trigger: { enqueueDestination: ReturnType<typeof vi.fn>; enqueueSearchMiss: ReturnType<typeof vi.fn> };

    let seq = 0;
    const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

    beforeAll(async () => {
      const signerPair = await generateKeyPair("ES256");
      signer = { privateKey: signerPair.privateKey, kid: SIGNER_KID };
      const authDeps: AuthRouterDeps = {
        db,
        verifier: {
          appleJwks: createLocalJWKSet({ keys: [] }),
          googleJwks: createLocalJWKSet({ keys: [] }),
          appleAudience: "com.gogo.travel",
          googleAudiences: ["gid.apps.example"],
        },
        signer,
        accessVerify: { publicKey: signerPair.publicKey },
        appleExchange: { exchange: () => Promise.reject(new Error("unused in this suite")) },
        appleCredentialsKey: Buffer.alloc(32, 7),
        logger: { warn: () => undefined },
      };
      trigger = { enqueueDestination: vi.fn(), enqueueSearchMiss: vi.fn() };
      app = createApp({
        auth: authDeps,
        trips: { db, now: () => T0, placesIngest: trigger as unknown as PlacesIngestTrigger },
      });
    }, BOOT_TIMEOUT_MS);

    async function seedUserWithToken() {
      const { user } = await createUserWithEntitlements(db, {
        email: `places-${uniq()}@example.com`,
        displayName: "Places Tester",
        googleSub: `google-places-${uniq()}`,
      });
      const issued = await createSessionWithTokens(db, {
        userId: user.id,
        device: { platform: "ios" },
        signer,
      });
      return { userId: user.id, accessToken: issued.accessToken };
    }

    const VALID_CREATE = {
      name: "Lisbon",
      destination_name: "Lisbon, Portugal",
      destination_lat: LISBON.lat,
      destination_lng: LISBON.lng,
      start_date: "2026-08-01",
      end_date: "2026-08-10",
    };

    const request = (path: string, token: string, init?: RequestInit) =>
      app.request(path, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      });

    it("POST /trips enqueues the destination AFTER the create commits", async () => {
      const owner = await seedUserWithToken();
      trigger.enqueueDestination.mockClear();

      const res = await request("/api/trips", owner.accessToken, {
        method: "POST",
        body: JSON.stringify(VALID_CREATE),
      });
      expect(res.status).toBe(201);
      expect(trigger.enqueueDestination).toHaveBeenCalledExactlyOnceWith(LISBON.lat, LISBON.lng);
    });

    it("a rejected create (validation) never reaches the trigger", async () => {
      const owner = await seedUserWithToken();
      trigger.enqueueDestination.mockClear();

      const res = await request("/api/trips", owner.accessToken, {
        method: "POST",
        body: JSON.stringify({ ...VALID_CREATE, name: "" }),
      });
      expect(res.status).toBe(400);
      expect(trigger.enqueueDestination).not.toHaveBeenCalled();
    });

    it("a THROWING enqueue can never fail the user request (R-places-1)", async () => {
      const owner = await seedUserWithToken();
      trigger.enqueueDestination.mockClear();
      trigger.enqueueDestination.mockImplementationOnce(() => {
        throw new Error("queue wiring exploded");
      });

      const res = await request("/api/trips", owner.accessToken, {
        method: "POST",
        body: JSON.stringify(VALID_CREATE),
      });
      expect(res.status).toBe(201);
      // The trip row committed despite the trigger blowing up.
      const trip = TripWithRoleSchema.parse(await res.json());
      const [dbRow] = await db
        .select({ id: schema.trips.id })
        .from(schema.trips)
        .where(eq(schema.trips.id, trip.id));
      expect(dbRow).toBeDefined();
    });

    it("PATCH enqueues only on a destination VALUE change, post-commit", async () => {
      const owner = await seedUserWithToken();
      const createRes = await request("/api/trips", owner.accessToken, {
        method: "POST",
        body: JSON.stringify(VALID_CREATE),
      });
      const trip = TripWithRoleSchema.parse(await createRes.json());
      trigger.enqueueDestination.mockClear();

      // Name-only PATCH: no destination touch — no enqueue.
      const nameOnly = await request(`/api/trips/${trip.id}`, owner.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(nameOnly.status).toBe(200);
      expect(trigger.enqueueDestination).not.toHaveBeenCalled();

      // Same-value destination resubmit: key present, value unchanged — no
      // enqueue (value-diff, not key-presence).
      const sameValue = await request(`/api/trips/${trip.id}`, owner.accessToken, {
        method: "PATCH",
        body: JSON.stringify({
          destination_lat: LISBON.lat,
          destination_lng: LISBON.lng,
        }),
      });
      expect(sameValue.status).toBe(200);
      expect(trigger.enqueueDestination).not.toHaveBeenCalled();

      // Real move (Lisbon → Porto): enqueue with the NEW coordinates.
      const moved = await request(`/api/trips/${trip.id}`, owner.accessToken, {
        method: "PATCH",
        body: JSON.stringify({
          destination_name: "Porto, Portugal",
          destination_lat: 41.1579,
          destination_lng: -8.6291,
        }),
      });
      expect(moved.status).toBe(200);
      expect(trigger.enqueueDestination).toHaveBeenCalledExactlyOnceWith(41.1579, -8.6291);
    });

    it("a destination PATCH that fails its precondition does NOT enqueue", async () => {
      const owner = await seedUserWithToken();
      const createRes = await request("/api/trips", owner.accessToken, {
        method: "POST",
        body: JSON.stringify(VALID_CREATE),
      });
      const trip = TripWithRoleSchema.parse(await createRes.json());
      trigger.enqueueDestination.mockClear();

      const res = await request(`/api/trips/${trip.id}`, owner.accessToken, {
        method: "PATCH",
        body: JSON.stringify({
          destination_lat: 41.1579,
          destination_lng: -8.6291,
          expect_updated_at: "2020-01-01T00:00:00.000Z", // stale on purpose
        }),
      });
      expect(res.status).toBe(409);
      expect(trigger.enqueueDestination).not.toHaveBeenCalled();
    });
  });
});
