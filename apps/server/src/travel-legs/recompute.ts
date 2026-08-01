/**
 * Travel-leg recompute (T-7.3 / IB-3) — steps 2–5 of the §3.5 computation
 * contract, run per drained `LegBatch` (one trip + its dirty days):
 *
 *  2. PAIR DERIVATION (R-ib-20): per dirty day — chain by `(sort_order, id)`,
 *     resolve locations (booking place → item place → unlocated), filter to
 *     located, take consecutive pairs (adjacency.ts, pure). Same-place pairs
 *     get zero-duration/zero-distance rows per mode with NO provider call —
 *     stored `provider: 'same_place'` (the schema's provider is deliberately
 *     text-not-enum; attributing a synthetic row to a real provider would be
 *     dishonest — documented spec interpretation, flagged in the PR).
 *  3. PROVIDER CALLS (R-ib-21): the mode's port (Mapbox profiles / MOTIS
 *     transit), each call bounded by a deterministic timeout race — a
 *     hanging provider can NEVER wedge the serial drain (T-6.3 bounded-
 *     settlement lesson; the adapters carry their own AbortSignal too).
 *  4. DIFFING: a pair-mode is recomputed only when it is NEW, its endpoints
 *     changed (`computed_at < max(endpoint changed_at)` — conservative row
 *     stamps, see adjacency.ts), or the row aged past the TTL (R-ib-23 —
 *     one rule serves the dirty path AND the staleness sweep). Upsert on
 *     `(from_item_id, to_item_id, mode)`; rows whose pair is no longer
 *     adjacent-located are deleted (R-ib-22).
 *  5. DEGRADATION (R-ib-19/21): a port that answers "no route" (null) makes
 *     the row ABSENT (delete if present); a port that FAILS (throw/timeout)
 *     changes nothing — existing rows are kept (offline ETAs come from the
 *     last precomputed rows), missing rows stay absent and retry next cycle.
 *     No Mapbox port configured ⇒ driving/walking/cycling degrade the same
 *     way. Never an error on any user path.
 *
 * ONLY WRITER (R-ib-22 / schema §3.3.11): this module is the single writer
 * of `travel_legs` — it alone guarantees both items belong to `trip_id`
 * (every item row here comes from a trip-scoped query). Pinned by
 * `only-writer.test.ts`.
 *
 * PRUNE RULE (why it is safe): a candidate row (either endpoint in the
 * batch's chain items) is deleted only when its pair is not desired AND its
 * endpoints' co-chain days are ALL inside this batch — a leg that is (or may
 * be) valid on an untouched day is left for that day's own recompute. Every
 * mutation marks BOTH the old and new days of moved items (dirty-days
 * contract), so an invalidated leg's days are always in the batch.
 *
 * LOCK ORDER (global, EXTENDED here — never reorder): users → trip_members
 * → invites → bookings → itinerary_items → **travel_legs**. This module's
 * write transaction touches ONLY `travel_legs` (reads run before it, plain,
 * un-locked) — it can never deadlock against the booking/itinerary service
 * chains, and races are tolerated instead of locked out: an item deleted
 * between read and write fires the legs FK (23503). The batch's days are
 * then RE-ENQUEUED once through the `requeue` marker (they ride the normal
 * debounce and coalesce with the deleting mutation's own post-commit marks
 * — the T-7.1 handoff contract), so unrelated days coalesced into the same
 * window are never lost. A batch that races AGAIN on its retry is dropped
 * with a warn (per-trip one-retry guard, reset on success — no re-enqueue
 * loop is possible); the staleness sweep remains the safety net.
 *
 * DRIVER: the write transaction runs on the transaction-capable client (WS
 * Pool prod / postgres-js tests) — never Neon-HTTP (landmine #1).
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { TravelMode } from "@gogo/shared/enums";
import { COMPUTED_TRAVEL_MODES } from "@gogo/shared/config/travel-legs";
import { TRAVEL_LEGS_PROVIDER_TIMEOUT_MS, TRAVEL_LEGS_TTL_MS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { markDaysDirty, type DirtyDayMarker } from "../bookings/dirty-days.js";
import { ProviderRequestError, type RouteResult, type RoutingPort } from "./providers.js";
import {
  chainForDay,
  coChainDays,
  locatedPairs,
  type ChainItem,
  type LegPair,
} from "./adjacency.js";
import { realScheduler, safeErrorLabel, type LegBatch, type TravelLegScheduler } from "./worker.js";

/** Zero-leg provenance (§3.5 step 2 — no provider was consulted). */
export const SAME_PLACE_PROVIDER = "same_place";

/**
 * Is this a `travel_legs` FK violation (23503)? The item-deletion race's
 * signature — from/to item (or the trip) vanished between read and write.
 * Constraint-scoped to travel_legs so unrelated FKs stay loud. 🔴 Driver
 * trap (the T-7.1 `isPlaceFkViolation` precedent): postgres-js (tests)
 * exposes `constraint_name`; pg-protocol's `DatabaseError` (prod Neon
 * driver) exposes `constraint`. Accept both, walk `cause`.
 */
export function isTravelLegFkViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
    };
    if (candidate.code === "23503") {
      const constraint =
        typeof candidate.constraint_name === "string"
          ? candidate.constraint_name
          : typeof candidate.constraint === "string"
            ? candidate.constraint
            : null;
      return constraint !== null && constraint.startsWith("travel_legs_");
    }
    current = current.cause;
  }
  return false;
}

/**
 * Deterministic per-call bound: race the port against a scheduled rejection
 * so a poisoned port cannot wedge the drain. The loser's eventual rejection
 * is swallowed (no unhandled-rejection noise from a late-failing hang).
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  scheduler: TravelLegScheduler,
  provider: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = scheduler.schedule(() => {
      promise.catch(() => {});
      reject(new ProviderRequestError(provider, `timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        scheduler.cancel(handle);
        resolve(value);
      },
      (err: unknown) => {
        scheduler.cancel(handle);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface LegRecomputerDeps {
  db: DbClient;
  /** Configured provider ports; a mode with no port simply degrades (R-ib-19). */
  ports: readonly RoutingPort[];
  /** Mode set (R-ib-21: shared config, not code). Default COMPUTED_TRAVEL_MODES. */
  modes?: readonly TravelMode[];
  /** Staleness TTL (R-ib-23; default 24 h via config). */
  ttlMs?: number;
  providerTimeoutMs?: number;
  scheduler?: TravelLegScheduler;
  now?: () => Date;
  logger?: { warn(message: string): void };
  /**
   * FK-race recovery seam (module LOCK ORDER doc): on the insert-side 23503
   * race the batch's days are re-marked here ONCE so no coalesced day is
   * lost. Prod wiring hands in the live dirty-day marker; absent (tests /
   * dormant wiring) the batch is dropped with a warn as before.
   */
  requeue?: DirtyDayMarker;
}

interface LegRowValues {
  tripId: string;
  fromItemId: string;
  toItemId: string;
  mode: TravelMode;
  durationSeconds: number;
  distanceMeters: number;
  provider: string;
  computedAt: Date;
}

/** Build the per-batch recompute the worker drains through. */
export function createLegRecomputer(deps: LegRecomputerDeps): (batch: LegBatch) => Promise<void> {
  const modes = deps.modes ?? COMPUTED_TRAVEL_MODES;
  const ttlMs = deps.ttlMs ?? TRAVEL_LEGS_TTL_MS;
  const timeoutMs = deps.providerTimeoutMs ?? TRAVEL_LEGS_PROVIDER_TIMEOUT_MS;
  const scheduler = deps.scheduler ?? realScheduler;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;

  const portByMode = new Map<TravelMode, RoutingPort>();
  for (const port of deps.ports) {
    for (const mode of port.modes) {
      if (!portByMode.has(mode)) portByMode.set(mode, port);
    }
  }

  /**
   * Per-trip one-retry guard for the FK race: a trip in this set already
   * spent its retry — the next race drops the batch. Reset on any batch
   * that completes without racing (single-instance in-memory, the same
   * posture as the worker's queue).
   */
  const fkRaceRetried = new Set<string>();

  return async function recompute(batch: LegBatch): Promise<void> {
    const days = [...new Set(batch.days)];
    if (days.length === 0) return;
    const daySet = new Set(days);

    // ---- read phase (plain reads, no locks — see the module lock-order doc)
    const itemRows = await deps.db
      .select({
        id: schema.itineraryItems.id,
        kind: schema.itineraryItems.kind,
        bookingId: schema.itineraryItems.bookingId,
        placeId: schema.itineraryItems.placeId,
        day: schema.itineraryItems.day,
        endDay: schema.itineraryItems.endDay,
        sortOrder: schema.itineraryItems.sortOrder,
        updatedAt: schema.itineraryItems.updatedAt,
      })
      .from(schema.itineraryItems)
      .where(
        and(
          eq(schema.itineraryItems.tripId, batch.tripId),
          or(inArray(schema.itineraryItems.day, days), inArray(schema.itineraryItems.endDay, days)),
        ),
      );

    const bookingIds = [
      ...new Set(itemRows.flatMap((row) => (row.bookingId !== null ? [row.bookingId] : []))),
    ];
    const bookingRows =
      bookingIds.length > 0
        ? await deps.db
            .select({
              id: schema.bookings.id,
              placeId: schema.bookings.placeId,
              updatedAt: schema.bookings.updatedAt,
            })
            .from(schema.bookings)
            .where(inArray(schema.bookings.id, bookingIds))
        : [];
    const bookingById = new Map(bookingRows.map((row) => [row.id, row]));

    // R-ib-20 location precedence: booking-kind → parent booking's place;
    // otherwise the item's own place. (A booking-kind item's own place_id is
    // NULL by the schema's booking_only check — precedence is still spelled
    // out here so the rule survives any future schema loosening.)
    const chainItems: ChainItem[] = [];
    const resolvedPlaceIds = new Set<string>();
    for (const row of itemRows) {
      const booking = row.bookingId !== null ? bookingById.get(row.bookingId) : undefined;
      const placeId = row.kind === "booking" ? (booking?.placeId ?? null) : row.placeId;
      if (placeId !== null) resolvedPlaceIds.add(placeId);
      const changedAt =
        booking && booking.updatedAt.getTime() > row.updatedAt.getTime()
          ? booking.updatedAt
          : row.updatedAt;
      chainItems.push({
        id: row.id,
        day: row.day,
        endDay: row.endDay,
        sortOrder: row.sortOrder,
        placeId,
        lat: null, // coordinates attached below once places are loaded
        lng: null,
        changedAt,
      });
    }

    const placeRows =
      resolvedPlaceIds.size > 0
        ? await deps.db
            .select({ id: schema.places.id, lat: schema.places.lat, lng: schema.places.lng })
            .from(schema.places)
            .where(inArray(schema.places.id, [...resolvedPlaceIds]))
        : [];
    const placeById = new Map(placeRows.map((row) => [row.id, row]));
    for (const item of chainItems) {
      if (item.placeId === null) continue;
      const place = placeById.get(item.placeId);
      if (!place) {
        // Place vanished between queries — unlocated for this cycle.
        item.placeId = null;
        continue;
      }
      // numeric() columns are STRING-mode (db/schema/_shared.ts) — convert.
      item.lat = Number(place.lat);
      item.lng = Number(place.lng);
    }

    // ---- desired pairs (§3.5 step 2; dedup across days — a spanning pair
    // can co-chain on two days but owns ONE row per mode, R-ib-22)
    const desiredPairs = new Map<string, LegPair>();
    for (const day of days) {
      for (const pair of locatedPairs(chainForDay(chainItems, day))) {
        desiredPairs.set(`${pair.from.id}|${pair.to.id}`, pair);
      }
    }

    // ---- existing candidate legs: either endpoint among this batch's items
    const itemIds = chainItems.map((item) => item.id);
    const existingLegs =
      itemIds.length > 0
        ? await deps.db
            .select({
              id: schema.travelLegs.id,
              fromItemId: schema.travelLegs.fromItemId,
              toItemId: schema.travelLegs.toItemId,
              mode: schema.travelLegs.mode,
              provider: schema.travelLegs.provider,
              durationSeconds: schema.travelLegs.durationSeconds,
              distanceMeters: schema.travelLegs.distanceMeters,
              computedAt: schema.travelLegs.computedAt,
            })
            .from(schema.travelLegs)
            .where(
              and(
                eq(schema.travelLegs.tripId, batch.tripId),
                or(
                  inArray(schema.travelLegs.fromItemId, itemIds),
                  inArray(schema.travelLegs.toItemId, itemIds),
                ),
              ),
            )
        : [];
    const existingByKey = new Map(
      existingLegs.map((leg) => [`${leg.fromItemId}|${leg.toItemId}|${leg.mode}`, leg]),
    );

    // Chain-day info for prune co-chain checks: batch items first, then any
    // out-of-batch endpoints of candidate legs (fetched by id).
    const chainDaysById = new Map<string, { day: string; endDay: string | null }>(
      chainItems.map((item) => [item.id, { day: item.day, endDay: item.endDay }]),
    );
    const missingEndpointIds = [
      ...new Set(
        existingLegs
          .flatMap((leg) => [leg.fromItemId, leg.toItemId])
          .filter((id) => !chainDaysById.has(id)),
      ),
    ];
    if (missingEndpointIds.length > 0) {
      const extraRows = await deps.db
        .select({
          id: schema.itineraryItems.id,
          day: schema.itineraryItems.day,
          endDay: schema.itineraryItems.endDay,
        })
        .from(schema.itineraryItems)
        .where(inArray(schema.itineraryItems.id, missingEndpointIds));
      for (const row of extraRows) {
        chainDaysById.set(row.id, { day: row.day, endDay: row.endDay });
      }
    }

    // ---- diff + provider phase (network OUTSIDE the write transaction)
    const nowDate = now();
    const nowMs = nowDate.getTime();
    const upserts: LegRowValues[] = [];
    const deleteIds: string[] = [];

    const isReusable = (key: string, pair: LegPair): boolean => {
      const existing = existingByKey.get(key);
      if (!existing) return false;
      const computedMs = existing.computedAt.getTime();
      const changedMs = Math.max(pair.from.changedAt.getTime(), pair.to.changedAt.getTime());
      // One freshness rule for both triggers (§3.5 step 4 + R-ib-23): the
      // row survives only while endpoints are unchanged AND it is inside TTL.
      return computedMs >= changedMs && nowMs - computedMs < ttlMs;
    };

    for (const [pairKey, pair] of desiredPairs) {
      for (const mode of modes) {
        const key = `${pairKey}|${mode}`;

        if (pair.samePlace) {
          if (!isReusable(key, pair)) {
            upserts.push({
              tripId: batch.tripId,
              fromItemId: pair.from.id,
              toItemId: pair.to.id,
              mode,
              durationSeconds: 0,
              distanceMeters: 0,
              provider: SAME_PLACE_PROVIDER,
              computedAt: nowDate,
            });
          }
          continue;
        }

        const port = portByMode.get(mode);
        if (!port) continue; // unconfigured mode degrades: absent / kept as-is
        if (isReusable(key, pair)) continue;

        // pair.from/to are located here by construction (locatedPairs filter).
        if (pair.from.lat === null || pair.from.lng === null) continue;
        if (pair.to.lat === null || pair.to.lng === null) continue;

        let result: RouteResult | null;
        try {
          result = await withTimeout(
            port.route(
              {
                from: { lat: pair.from.lat, lng: pair.from.lng },
                to: { lat: pair.to.lat, lng: pair.to.lng },
              },
              mode,
            ),
            timeoutMs,
            scheduler,
            port.provider,
          );
        } catch (err) {
          // Step 5: failure ⇒ change NOTHING (existing kept, absent stays
          // absent; retried next cycle). Redacted log only.
          logger.warn(`travel-legs: ${port.provider}/${mode} failed: ${safeErrorLabel(err)}`);
          continue;
        }

        if (result === null) {
          // Definitive no-route ⇒ the mode row is ABSENT (R-ib-21).
          const existing = existingByKey.get(key);
          if (existing) deleteIds.push(existing.id);
          continue;
        }

        upserts.push({
          tripId: batch.tripId,
          fromItemId: pair.from.id,
          toItemId: pair.to.id,
          mode,
          durationSeconds: result.durationSeconds,
          distanceMeters: result.distanceMeters,
          provider: port.provider,
          computedAt: nowDate,
        });
      }
    }

    // ---- prune (R-ib-22 + module PRUNE RULE)
    for (const leg of existingLegs) {
      if (desiredPairs.has(`${leg.fromItemId}|${leg.toItemId}`)) {
        // Pair still adjacent-located; a mode outside the configured set is
        // pruned (mode-set shrink cleanup — shared config doc).
        if (modes.includes(leg.mode)) continue;
      }
      const from = chainDaysById.get(leg.fromItemId);
      const to = chainDaysById.get(leg.toItemId);
      // A missing endpoint row (deleted between queries) has no chain days —
      // co-chain ∅ ⊆ batch, prune (the cascade will race us harmlessly).
      const coChain = from && to ? coChainDays(from, to) : [];
      if (coChain.every((day) => daySet.has(day))) deleteIds.push(leg.id);
    }

    if (upserts.length === 0 && deleteIds.length === 0) {
      fkRaceRetried.delete(batch.tripId);
      return;
    }

    // ---- write phase: ONE transaction, travel_legs only (lock-order doc)
    const uniqueDeleteIds = [...new Set(deleteIds)];
    try {
      await deps.db.transaction(async (tx) => {
        if (upserts.length > 0) {
          await tx
            .insert(schema.travelLegs)
            .values(upserts)
            .onConflictDoUpdate({
              target: [
                schema.travelLegs.fromItemId,
                schema.travelLegs.toItemId,
                schema.travelLegs.mode,
              ],
              set: {
                durationSeconds: sql`excluded.duration_seconds`,
                distanceMeters: sql`excluded.distance_meters`,
                provider: sql`excluded.provider`,
                computedAt: sql`excluded.computed_at`,
              },
            });
        }
        if (uniqueDeleteIds.length > 0) {
          await tx.delete(schema.travelLegs).where(inArray(schema.travelLegs.id, uniqueDeleteIds));
        }
      });
    } catch (err) {
      if (isTravelLegFkViolation(err)) {
        // Item-deletion race (T-7.1 handoff): the deleting mutation marked
        // ITS days post-commit, but this batch may carry unrelated coalesced
        // days too — re-enqueue the WHOLE batch once (rides the debounce; a
        // retry's reads run after the deleter committed, so they are
        // consistent). Second race for the same trip ⇒ drop with a warn
        // (never-throws holds either way; the sweep is the safety net).
        if (deps.requeue && !fkRaceRetried.has(batch.tripId)) {
          fkRaceRetried.add(batch.tripId);
          logger.warn(
            "travel-legs: item deleted during recompute (FK race) — re-enqueueing batch days",
          );
          markDaysDirty(
            deps.requeue,
            days.map((day) => ({ tripId: batch.tripId, day })),
          );
          return;
        }
        fkRaceRetried.delete(batch.tripId);
        logger.warn("travel-legs: batch dropped — item deleted during recompute (FK race)");
        return;
      }
      throw err;
    }
    fkRaceRetried.delete(batch.tripId);
  };
}
