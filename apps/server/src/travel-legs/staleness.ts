/**
 * Leg-ETA staleness sweep (T-7.3 / IB-3; R-ib-23, §3.5 step 7): find
 * `travel_legs` older than the TTL for trips that are `active` or start
 * within the horizon (default 7 days), and re-mark their days dirty through
 * the normal worker — recompute rides the standard debounce/diff path (one
 * freshness rule: recompute.ts treats rows past TTL as non-reusable, so a
 * re-marked day's stale rows get real provider calls while everything fresh
 * is left alone).
 *
 * Eligibility uses the trips status seam (`trips/status.ts`): the EFFECTIVE
 * status (owner override wins, else date derivation at UTC-today) — never
 * the stored column, which converges lazily. Day-of traffic-aware cadence is
 * explicitly out of scope (§3.5 step 7 — today bundle).
 *
 * QUERY SHAPE (bounded, sargable): the stale set of finished trips grows
 * monotonically forever (their legs are never recomputed and never deleted),
 * so the sweep NEVER scans `travel_legs` by `computed_at` alone. It selects
 * the ELIGIBLE trips first — a bounded set (`status_override = 'active'`,
 * date-window active, or starting inside the horizon; the SQL predicate
 * mirrors `effectiveTripStatus` + the starts-soon rule and the JS filter
 * below stays the authoritative seam arbiter) — then fetches only THOSE
 * trips' stale legs via `travel_legs_trip_id_idx` + the `computed_at`
 * cutoff. Historical legs of past/archived trips are never materialized.
 *
 * The sweep only MARKS (via the seam's swallow helper — it can never throw
 * into the interval driver); the worker/recomputer own all writes (R-ib-22
 * only-writer holds). Prod cadence: an in-process interval in wire.ts —
 * this module stays pure-async for tests.
 */
import { and, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { TRAVEL_LEGS_REFRESH_HORIZON_DAYS, TRAVEL_LEGS_TTL_MS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { markDaysDirty, type DirtyDayMark, type DirtyDayMarker } from "../bookings/dirty-days.js";
import { effectiveTripStatus, todayUtc } from "../trips/status.js";
import { itemChainDays } from "./adjacency.js";

/** `iso + n days` on the UTC calendar (wall-date arithmetic, no tz math). */
function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface StalenessSweepDeps {
  db: DbClient;
  /** The live worker (or any marker) — marks ride the normal debounce. */
  marker: DirtyDayMarker;
  ttlMs?: number;
  horizonDays?: number;
  now?: () => Date;
}

export interface StalenessSweepResult {
  /** Stale rows found on eligible trips (pre-dedup). */
  staleLegs: number;
  /** Distinct `{trip, day}` marks enqueued. */
  markedDays: number;
}

export async function sweepStaleLegs(deps: StalenessSweepDeps): Promise<StalenessSweepResult> {
  const ttlMs = deps.ttlMs ?? TRAVEL_LEGS_TTL_MS;
  const horizonDays = deps.horizonDays ?? TRAVEL_LEGS_REFRESH_HORIZON_DAYS;
  const now = deps.now ? deps.now() : new Date();
  const cutoff = new Date(now.getTime() - ttlMs);
  const today = todayUtc(now);
  const horizon = addDaysIso(today, horizonDays);

  // ---- step 1: the bounded eligible-trip set (see the QUERY SHAPE doc).
  // SQL mirror of the JS predicate below — a candidate pre-filter that keeps
  // the scan sargable; the seam-backed JS filter remains authoritative.
  const candidateTrips = await deps.db
    .select({
      id: schema.trips.id,
      statusOverride: schema.trips.statusOverride,
      startDate: schema.trips.startDate,
      endDate: schema.trips.endDate,
    })
    .from(schema.trips)
    .where(
      or(
        eq(schema.trips.statusOverride, "active"),
        and(
          isNull(schema.trips.statusOverride),
          lte(schema.trips.startDate, today),
          gte(schema.trips.endDate, today),
        ),
        and(gte(schema.trips.startDate, today), lte(schema.trips.startDate, horizon)),
      ),
    );

  const eligibleTripIds: string[] = [];
  for (const trip of candidateTrips) {
    // R-ib-23 eligibility: `active` now, or starting inside the horizon —
    // decided through the effective-status seam (override wins).
    const status = effectiveTripStatus(trip, today);
    const startsSoon = trip.startDate >= today && trip.startDate <= horizon;
    if (status === "active" || startsSoon) eligibleTripIds.push(trip.id);
  }
  if (eligibleTripIds.length === 0) return { staleLegs: 0, markedDays: 0 };

  // ---- step 2: only the eligible trips' stale legs (trip-id index + cutoff).
  const fromItem = alias(schema.itineraryItems, "stale_from_item");
  const toItem = alias(schema.itineraryItems, "stale_to_item");
  const rows = await deps.db
    .select({
      tripId: schema.travelLegs.tripId,
      fromDay: fromItem.day,
      fromEndDay: fromItem.endDay,
      toDay: toItem.day,
      toEndDay: toItem.endDay,
    })
    .from(schema.travelLegs)
    .innerJoin(fromItem, eq(fromItem.id, schema.travelLegs.fromItemId))
    .innerJoin(toItem, eq(toItem.id, schema.travelLegs.toItemId))
    .where(
      and(
        inArray(schema.travelLegs.tripId, eligibleTripIds),
        lt(schema.travelLegs.computedAt, cutoff),
      ),
    );

  const marks = new Map<string, DirtyDayMark>();
  let staleLegs = 0;
  for (const row of rows) {
    staleLegs += 1;
    // Mark BOTH endpoints' chain days (superset of the leg's co-chain day —
    // duplicates are the seam's tolerated currency; this also re-marks any
    // cross-day orphan so the recompute's prune can retire it).
    const dayUnion = [
      ...itemChainDays({ day: row.fromDay, endDay: row.fromEndDay }),
      ...itemChainDays({ day: row.toDay, endDay: row.toEndDay }),
    ];
    for (const day of dayUnion) {
      marks.set(`${row.tripId}|${day}`, { tripId: row.tripId, day });
    }
  }

  // The seam's swallow helper — a sweep can never throw into its driver.
  markDaysDirty(deps.marker, [...marks.values()]);
  return { staleLegs, markedDays: marks.size };
}
