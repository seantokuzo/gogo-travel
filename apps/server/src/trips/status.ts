/**
 * Trip status reconciliation seam (trips spec §3.4, R-trips-7; schema spec
 * R-db-19). One rule, two layers:
 *
 *  - DERIVED: `deriveTripStatus` — the single `@gogo/shared` definition both
 *    server and client evaluate, with an EXPLICIT `today` input so the
 *    boundary day can never drift between surfaces (§3.4 timezone note).
 *    B-30: that `today` is PER TRIP — the calendar day at the trip's
 *    EFFECTIVE destination zone (`todayInZone`; `trips/destination-tz.ts`
 *    resolves the zone), never the server's UTC day and never a device's
 *    local day. The client evaluates the same helper with the same wire zone.
 *  - OVERRIDE: `trips.status_override` — owner-set, wins until cleared;
 *    "archive" is exactly the override to `'past'` (§3.4, resolved Gate 2).
 *
 * The stored `trips.status` column converges to the EFFECTIVE value lazily:
 * whenever a route loads trip rows and finds drift (a boundary day passed),
 * it writes the derived value back (`reconcileStoredStatuses`). No cron, no
 * scheduled job (Law #5) — reads self-heal.
 *
 * Reconciliation deliberately does NOT bump `updated_at`: it is server-side
 * convergence of DERIVED data, not a client write (R-trips-5's "bump
 * updated_at" governs PATCH mutations). If a mere read could move
 * `updated_at`, every boundary day would false-conflict all in-flight
 * `expect_updated_at` preconditions (R-trips-6).
 */
import { inArray, sql } from "drizzle-orm";
import type { TripStatus } from "@gogo/shared/enums";
import { deriveTripStatus } from "@gogo/shared/domains/trip";
import type { ISODate } from "@gogo/shared/scalars";
import { todayInZone } from "@gogo/shared/time";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import {
  DEFAULT_EFFECTIVE_ZONE,
  resolveEffectiveZones,
  type EffectiveZone,
  type ZoneSourceRow,
} from "./destination-tz.js";

/** The fields the status rule reads — any trips row (or projection) qualifies. */
export interface StatusFields {
  statusOverride: TripStatus | null;
  startDate: string;
  endDate: string;
}

/**
 * A trip's `today` for §3.4 derivation (B-30): the calendar day at instant
 * `now` in the trip's EFFECTIVE destination zone (`resolveEffectiveZones` /
 * `resolveDestinationTz` — never the raw stored column, which is NULL for
 * legacy and coordinate-less trips). An unknown zone degrades to the UTC
 * date inside `todayInZone`; it never throws. Replaces the old server-wide
 * `todayUtc(now)`, which flipped every US trip a day early each evening.
 */
export function tripToday(now: Date, zone: string | null | undefined): ISODate {
  return todayInZone(now, zone);
}

/** Effective status: owner override wins until cleared, then derivation (R-trips-7). */
export function effectiveTripStatus(trip: StatusFields, today: ISODate): TripStatus {
  return trip.statusOverride ?? deriveTripStatus(today, trip.startDate, trip.endDate);
}

/** What a reconcile pass answers for one trip: its effective status + effective zone. */
export interface ReconciledTrip {
  status: TripStatus;
  /** The EFFECTIVE zone (+ source) the status was evaluated in — what the wire's `destination_tz{,_source}` carry. */
  zone: EffectiveZone;
}

/**
 * Converge stored `status` to the effective value for any drifted rows, and
 * return each row's effective status AND effective zone keyed by id (the
 * zone is resolved here because status needs it and the wire must carry the
 * SAME one — see `trips/destination-tz.ts`). Each row is evaluated at ITS OWN
 * `today` (`tripToday(now, zone)`), so one page can hold trips on different
 * calendar days. Drift is rare (at most two boundary-day flips per trip
 * lifetime), so the common case writes nothing.
 *
 * `updated_at` is preserved via an explicit self-assignment — Drizzle's
 * `$onUpdate` only fires when the column is NOT explicitly set (see module
 * doc for why a read must never move `updated_at`).
 */
export async function reconcileStoredStatuses(
  db: DbClient,
  rows: ReadonlyArray<StatusFields & ZoneSourceRow & { status: TripStatus }>,
  now: Date,
): Promise<Map<string, ReconciledTrip>> {
  const zones = await resolveEffectiveZones(db, rows);
  const effective = new Map<string, ReconciledTrip>();
  const drifted = new Map<TripStatus, string[]>();

  for (const row of rows) {
    const zone = zones.get(row.id) ?? DEFAULT_EFFECTIVE_ZONE;
    const status = effectiveTripStatus(row, tripToday(now, zone.zone));
    effective.set(row.id, { status, zone });
    if (status !== row.status) {
      const ids = drifted.get(status) ?? [];
      ids.push(row.id);
      drifted.set(status, ids);
    }
  }

  for (const [status, ids] of drifted) {
    await db
      .update(schema.trips)
      .set({ status, updatedAt: sql`${schema.trips.updatedAt}` })
      .where(inArray(schema.trips.id, ids));
  }

  return effective;
}
