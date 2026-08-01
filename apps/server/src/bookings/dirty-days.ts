/**
 * Travel-leg dirty-day marker seam (T-7.1 / IB-1; itinerary-bookings spec
 * §3.5 step 1, R-ib-19, invariant I-5). The FROZEN contract between every
 * booking/itinerary mutation and the leg-computation job. T-7.3 [IB-3]
 * FILLED the internals: the live implementation is the debounced dirty-day
 * queue + serial drain in `travel-legs/worker.ts` (recompute + Mapbox/
 * Transitous adapters behind it); `createDirtyDayMarker` below wraps the
 * process-wide worker instance that `travel-legs/wire.ts` constructs —
 * passing NO worker keeps the T-7.1 dormant posture (unit tests, and any
 * wiring not yet integrated with the worker).
 *
 * CONTRACT (mirrors `trips/push-invalidation.ts` / the T-6.4 hook discipline):
 *
 *  - **Post-commit only.** Callers invoke `markDaysDirty` strictly AFTER
 *    `await db.transaction(...)` returns (or a single-statement auto-commit
 *    write succeeds). An aborted mutation must NEVER mark — recompute has no
 *    way to un-mark, and R-ib-19 keys marking to mutations that HAPPENED.
 *  - **Never throws, never blocks.** Marking is fire-and-forget: itinerary
 *    and booking mutations SHALL never fail or block on leg computation
 *    (R-ib-19). Call sites use the `markDaysDirty` helper (`?.` + swallow)
 *    so even a broken implementation can't take a 2xx down; the factory
 *    wrapper below adds the same guard around the live worker (triple
 *    protection — the worker itself also never throws).
 *  - **Marks are `{tripId, day}`** — `day` is the trip-local wall-date
 *    (`YYYY-MM-DD`). Callers mark every day whose LOCATED ORDERED SEQUENCE
 *    may have changed: created/deleted/moved items' old AND new days, and
 *    both `day` and `end_day` of spanning items (§3.6: a spanning item
 *    participates in both days' chains). Duplicate marks are fine — the
 *    worker coalesces per trip over the §3.5 step 1 debounce window;
 *    callers do not pre-dedupe.
 *  - **Zero queries while dormant.** The no-worker arm below touches
 *    nothing — no DB, no timers, no allocation beyond the call frame. The
 *    `DirtyDayMarker` interface and the `markDaysDirty` helper signature
 *    remain FROZEN.
 */

/** One dirty-day marker: §3.5 step 1's `{trip_id, day}` unit. */
export interface DirtyDayMark {
  tripId: string;
  /** Trip-local wall-date, `YYYY-MM-DD`. */
  day: string;
}

/** What mutation call sites depend on — mark only. */
export interface DirtyDayMarker {
  /** Post-commit, fire-and-forget. Never throws; never blocks. */
  markDaysDirty(marks: readonly DirtyDayMark[]): void;
}

/**
 * Double-guard helper for call sites — the T-6.3 `emitTripEvent` shape
 * (`?.` + swallow) as one call, so a broken seam can never fail the user
 * request even if a future implementation forgets its never-throws contract.
 * An empty `marks` array is a no-op by definition (nothing changed placement).
 */
export function markDaysDirty(
  marker: DirtyDayMarker | undefined,
  marks: readonly DirtyDayMark[],
): void {
  if (marks.length === 0) return;
  try {
    marker?.markDaysDirty(marks);
  } catch {
    // Deliberately swallowed: marking is best-effort (R-ib-19 — legs are
    // derived data; the staleness-refresh job is the safety net).
  }
}

/**
 * The seam factory (internals filled at T-7.3):
 *
 *  - `createDirtyDayMarker(worker)` — the LIVE arm. `worker` is the ONE
 *    process-wide `createTravelLegWorker` instance (`travel-legs/wire.ts`
 *    builds it; two workers would double-recompute). The wrapper enforces
 *    the never-throws contract AT THE SEAM regardless of the worker's own
 *    guarantees.
 *  - `createDirtyDayMarker()` — the dormant arm, unchanged from T-7.1:
 *    accepts and drops every mark at zero cost. For unit tests and any
 *    mutation wiring not yet handed the worker (post-W2-merge integration:
 *    every `buildXxxDeps` must receive `TravelLegsBuild.marker` from
 *    index.ts, or its surface's marks silently drop — the staleness sweep
 *    and the refresh-legs endpoint are the documented safety nets).
 */
export function createDirtyDayMarker(worker?: DirtyDayMarker): DirtyDayMarker {
  if (worker) {
    return {
      markDaysDirty(marks) {
        try {
          worker.markDaysDirty(marks);
        } catch {
          // Never-throws at the seam (R-ib-19) — same posture as the helper.
        }
      },
    };
  }
  return {
    markDaysDirty() {
      // Dormant: drop every mark (unit tests / not-yet-integrated wiring).
    },
  };
}
