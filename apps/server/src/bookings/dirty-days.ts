/**
 * Travel-leg dirty-day marker seam (T-7.1 / IB-1; itinerary-bookings spec
 * §3.5 step 1, R-ib-19, invariant I-5). The FROZEN contract between every
 * booking/itinerary mutation and the leg-computation job — T-7.3 [IB-3]
 * fills the internals (dirty-day queue + debounced worker + Mapbox/
 * Transitous adapters); this module is the T-6.3 dormant-emitter precedent:
 * the seam ships first so W2 tasks build against a fixed signature with zero
 * cross-wave file contention.
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
 *    so even a broken implementation can't take a 2xx down.
 *  - **Marks are `{tripId, day}`** — `day` is the trip-local wall-date
 *    (`YYYY-MM-DD`). Callers mark every day whose LOCATED ORDERED SEQUENCE
 *    may have changed: created/deleted/moved items' old AND new days, and
 *    both `day` and `end_day` of spanning items (§3.6: a spanning item
 *    participates in both days' chains). Duplicate marks are fine — the
 *    implementation coalesces (§3.5 step 1's debounce window); callers do
 *    not pre-dedupe.
 *  - **Zero queries while dormant.** The no-op implementation below touches
 *    nothing — no DB, no timers, no allocation beyond the call frame. T-7.3
 *    replaces `createDirtyDayMarker`'s internals (its deps will grow: db,
 *    debounce config, provider adapters); the `DirtyDayMarker` interface and
 *    the `markDaysDirty` helper signature are FROZEN.
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
 * The dormant no-op marker (prod wiring until T-7.3): accepts and drops
 * every mark. Documented no-op — NOT a stub to "fix": while dormant the
 * seam MUST cost zero queries per mutation (task contract), exactly like
 * the transport-less push emitter.
 */
export function createDirtyDayMarker(): DirtyDayMarker {
  return {
    markDaysDirty() {
      // Dormant until T-7.3 wires the dirty-day queue + debounced worker.
    },
  };
}
