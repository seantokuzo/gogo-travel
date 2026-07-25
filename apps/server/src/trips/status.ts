/**
 * Trip status reconciliation seam (trips spec §3.4, R-trips-7; schema spec
 * R-db-19). One rule, two layers:
 *
 *  - DERIVED: `deriveTripStatus` — the single `@gogo/shared` definition both
 *    server and client evaluate, with an EXPLICIT `today` input so the
 *    boundary day can never drift between surfaces (§3.4 timezone note).
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
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";

/** The fields the status rule reads — any trips row (or projection) qualifies. */
export interface StatusFields {
  statusOverride: TripStatus | null;
  startDate: string;
  endDate: string;
}

/**
 * The server's `today` for §3.4 derivation: the UTC calendar date of the
 * injected clock. The client evaluates the same shared helper in the user's
 * tz (nav §2.5); the server pins UTC so its answer is deterministic and
 * documented rather than host-tz-dependent.
 */
export function todayUtc(now: Date): ISODate {
  return now.toISOString().slice(0, 10);
}

/** Effective status: owner override wins until cleared, then derivation (R-trips-7). */
export function effectiveTripStatus(trip: StatusFields, today: ISODate): TripStatus {
  return trip.statusOverride ?? deriveTripStatus(today, trip.startDate, trip.endDate);
}

/**
 * Converge stored `status` to the effective value for any drifted rows, and
 * return each row's effective status keyed by id. Drift is rare (at most two
 * boundary-day flips per trip lifetime), so the common case writes nothing.
 *
 * `updated_at` is preserved via an explicit self-assignment — Drizzle's
 * `$onUpdate` only fires when the column is NOT explicitly set (see module
 * doc for why a read must never move `updated_at`).
 */
export async function reconcileStoredStatuses(
  db: DbClient,
  rows: ReadonlyArray<StatusFields & { id: string; status: TripStatus }>,
  today: ISODate,
): Promise<Map<string, TripStatus>> {
  const effective = new Map<string, TripStatus>();
  const drifted = new Map<TripStatus, string[]>();

  for (const row of rows) {
    const status = effectiveTripStatus(row, today);
    effective.set(row.id, status);
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
