/**
 * Batch upsert + cross-source dedup (places spec §3.1.4 steps 4–5).
 *
 * - Upserts on `(source, source_id)` (R-places-2; schema R-db-6's partial
 *   unique index) — refresh NEVER deletes rows (`ON DELETE RESTRICT`
 *   references make deletion moot anyway).
 * - When ingesting a lower-priority source, a candidate that resolves as a
 *   duplicate of an existing higher-priority place — within
 *   `PLACES_DEDUP_DISTANCE_M` AND name trigram similarity ≥
 *   `PLACES_DEDUP_NAME_SIMILARITY` — is SKIPPED (R-places-3), so one physical
 *   venue yields one row. Priority `overture > fsq_os` (R-places-18).
 * - Each batch (dedup check + upsert) is ONE transaction — atomic on the
 *   transaction-capable drivers (WS Pool / postgres-js; landmine #1: never
 *   the Neon-HTTP driver). A mid-run failure loses at most the in-flight
 *   batch; committed batches stay (R-places-4's "data intact" posture).
 */
import { sql } from "drizzle-orm";
import {
  PLACES_DEDUP_DISTANCE_M,
  PLACES_DEDUP_NAME_SIMILARITY,
  spineSourcesAbove,
  type SpineSource,
} from "@gogo/shared/config/places";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { SpineRecord } from "./normalize.js";

/** Meters per degree of latitude (spherical mean) — box prefilter scale. */
const METERS_PER_DEGREE_LAT = 111_320;

export interface UpsertBatchResult {
  /** Rows written (inserted or refreshed) this batch. */
  upserted: number;
  /** Candidates skipped as cross-source duplicates (R-places-3). */
  dedupSkipped: number;
}

/**
 * Which of `records` duplicate an existing higher-priority place. Runs as a
 * single set query: VALUES-join the batch against `places`, box-prefilter,
 * then the exact §3.1.4 predicate — equirectangular distance (exact to
 * centimeters at 50 m scale) + pg_trgm `similarity()` (index-backed by the
 * pg_trgm GIN from migration 0000). Candidates that already exist under
 * their OWN `(source, source_id)` are NOT dupes — they're ours; skipping
 * them would strand stale rows (upsert refreshes them instead; deletion is
 * forbidden either way, R-places-2).
 */
async function findCrossSourceDuplicates(
  db: DbClient,
  source: SpineSource,
  records: SpineRecord[],
): Promise<Set<string>> {
  const higher = spineSourcesAbove(source);
  if (higher.length === 0 || records.length === 0) return new Set();

  const latBox = PLACES_DEDUP_DISTANCE_M / METERS_PER_DEGREE_LAT;
  const tuples = records.map(
    (r) =>
      sql`(${r.sourceId}, ${r.name}, ${r.lat}::double precision, ${r.lng}::double precision)`,
  );
  const higherList = sql.join(
    higher.map((s) => sql`${s}::place_source`),
    sql`, `,
  );

  const rows: Array<{ sourceId: string }> = await db
    .select({ sourceId: sql<string>`v.source_id` })
    .from(sql`(values ${sql.join(tuples, sql`, `)}) as v(source_id, name, lat, lng)`)
    .where(
      sql`exists (
        select 1 from places p
        where p.source in (${higherList})
          and abs(p.lat::double precision - v.lat) <= ${latBox}
          and abs(p.lng::double precision - v.lng)
            <= ${latBox} / greatest(cos(radians(v.lat)), 0.01)
          and similarity(p.name, v.name) >= ${PLACES_DEDUP_NAME_SIMILARITY}
          and ${METERS_PER_DEGREE_LAT}::double precision * sqrt(
                power(p.lat::double precision - v.lat, 2)
                + power((p.lng::double precision - v.lng) * cos(radians(v.lat)), 2)
              ) <= ${PLACES_DEDUP_DISTANCE_M}
      )
      and not exists (
        select 1 from places own
        where own.source = ${source}::place_source and own.source_id = v.source_id
      )`,
    );

  return new Set(rows.map((row) => row.sourceId));
}

/** One batch: dedup-filter, then upsert — atomically. */
export async function upsertSpineBatch(
  db: DbClient,
  source: SpineSource,
  records: SpineRecord[],
): Promise<UpsertBatchResult> {
  // Within-batch dedupe by source_id (first wins): a multi-row INSERT that
  // hits the same conflict target twice is a Postgres error, not an upsert.
  const bySourceId = new Map<string, SpineRecord>();
  for (const record of records) {
    if (!bySourceId.has(record.sourceId)) bySourceId.set(record.sourceId, record);
  }
  const batch = [...bySourceId.values()];
  if (batch.length === 0) return { upserted: 0, dedupSkipped: 0 };

  return db.transaction(async (tx) => {
    const duplicates = await findCrossSourceDuplicates(tx, source, batch);
    const inserts = batch.filter((record) => !duplicates.has(record.sourceId));
    if (inserts.length === 0) return { upserted: 0, dedupSkipped: duplicates.size };

    await tx
      .insert(schema.places)
      .values(
        inserts.map((record) => ({
          source,
          sourceId: record.sourceId,
          name: record.name,
          // numeric columns are string-mode (db/schema/_shared.ts).
          lat: String(record.lat),
          lng: String(record.lng),
          category: record.category,
          wikiRef: record.wikiRef,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.places.source, schema.places.sourceId],
        // The upsert key is a PARTIAL unique index (WHERE source_id IS NOT
        // NULL — custom places are excluded); ON CONFLICT must repeat the
        // predicate to match it.
        targetWhere: sql`source_id is not null`,
        set: {
          name: sql`excluded.name`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          category: sql`excluded.category`,
          wikiRef: sql`excluded.wiki_ref`,
          // 🔴 $onUpdate does NOT fire through onConflictDoUpdate
          // (db/schema/_shared.ts landmine) — set updated_at by hand…
          updatedAt: sql`now()`,
        },
        // …but ONLY when something actually changed: an idempotent re-run
        // must not churn rows (or updated_at) at all.
        setWhere: sql`(${schema.places.name}, ${schema.places.lat}, ${schema.places.lng}, ${schema.places.category}, ${schema.places.wikiRef})
          is distinct from
          (excluded.name, excluded.lat, excluded.lng, excluded.category, excluded.wiki_ref)`,
      });

    return { upserted: inserts.length, dedupSkipped: duplicates.size };
  });
}
