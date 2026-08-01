/**
 * Dirty-day queue + debounced drain (T-7.3 / IB-3; itinerary-bookings spec
 * §3.5 step 1, R-ib-19, invariant I-5). THE live internals behind the frozen
 * `bookings/dirty-days.ts` seam: mutations mark `{tripId, day}` post-commit;
 * this worker coalesces marks per trip over a debounce window and drains
 * trip batches SERIALLY through the injected `recompute` (recompute.ts — the
 * ONLY writer of `travel_legs`, R-ib-22).
 *
 * CONTRACT (the seam's frozen doc, honored here):
 *  - `markDaysDirty` NEVER throws and NEVER blocks (R-ib-19): the entire
 *    body is guarded; work happens on timers, not the caller's stack.
 *  - Duplicate marks coalesce (per-trip day Set); callers do not pre-dedupe.
 *  - BOUNDED SETTLEMENT (the T-6.3 transport lesson — never wedge on a
 *    serial chain): the debounce window is FIXED from a trip's FIRST mark —
 *    later marks join the bucket but never extend the deadline, so a long
 *    drag session costs one recompute per window, and a mark storm cannot
 *    starve the flush. Per-batch recompute failures are caught + logged
 *    (redacted) and the drain continues; the staleness-refresh job is the
 *    safety net for anything dropped.
 *  - Marks arriving for a trip while its batch is DRAINING open a fresh
 *    bucket + window — nothing is lost to the in-flight run.
 *
 * Single-instance, in-memory — the same acceptable-until-≥2-instances
 * posture as `places/ingest-queue.ts` and `http/rate-limit.ts`.
 *
 * DETERMINISM SEAMS: `scheduler` (timers) is injectable — tests drive the
 * debounce with a manual fake; no real sleeps anywhere (task contract).
 */
import { TRAVEL_LEGS_DEBOUNCE_MS } from "../config.js";
import type { DirtyDayMark, DirtyDayMarker } from "../bookings/dirty-days.js";

/** One drained unit of work: a trip and the days marked during its window. */
export interface LegBatch {
  tripId: string;
  days: readonly string[];
}

/** Timer seam — prod = setTimeout/clearTimeout; tests inject a manual fake. */
export interface TravelLegScheduler {
  schedule(fn: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const realScheduler: TravelLegScheduler = {
  schedule: (fn, delayMs) => setTimeout(fn, delayMs),
  cancel: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/**
 * Redaction-safe log line for an arbitrary thrown value: our own
 * `ProviderRequestError` messages are sanitized by construction; anything
 * else logs its NAME only — an unknown error's message could embed a
 * provider URL (undici does), which carries the Mapbox token (Law #1).
 */
export function safeErrorLabel(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "ProviderRequestError" ? err.message : err.name;
  }
  return "unknown error";
}

export interface TravelLegWorkerDeps {
  /** The per-trip recompute (steps 2–5). Rejections are caught + logged here. */
  recompute(batch: LegBatch): Promise<void>;
  /** Debounce window (config; single-digit seconds — §3.5 step 1). */
  debounceMs?: number;
  scheduler?: TravelLegScheduler;
  logger?: { warn(message: string): void };
}

export interface TravelLegWorker extends DirtyDayMarker {
  /** Resolves when every currently FLUSHED batch has drained (tests/shutdown). */
  idle(): Promise<void>;
  /**
   * Cancel pending windows and drop un-flushed marks (shutdown). Dropped
   * marks are healed by the staleness sweep / an explicit refresh.
   */
  stop(): void;
}

export function createTravelLegWorker(deps: TravelLegWorkerDeps): TravelLegWorker {
  const debounceMs = deps.debounceMs ?? TRAVEL_LEGS_DEBOUNCE_MS;
  const scheduler = deps.scheduler ?? realScheduler;
  const logger = deps.logger ?? console;

  /** Un-flushed buckets: tripId → days marked during the open window. */
  const pending = new Map<string, Set<string>>();
  /** Open windows: tripId → scheduler handle (fixed deadline — never reset). */
  const timers = new Map<string, unknown>();
  /** Flushed batches awaiting the serial drain, FIFO. */
  const queue: LegBatch[] = [];
  let draining = false;
  let drainPromise: Promise<void> = Promise.resolve();
  let stopped = false;

  function flush(tripId: string): void {
    timers.delete(tripId);
    const days = pending.get(tripId);
    pending.delete(tripId);
    if (!days || days.size === 0) return;
    queue.push({ tripId, days: [...days] });
    if (!draining) {
      draining = true;
      drainPromise = drain();
    }
  }

  async function drain(): Promise<void> {
    try {
      for (;;) {
        const batch = queue.shift();
        if (!batch) break;
        try {
          await deps.recompute(batch);
        } catch (err) {
          // Never wedge, never leak (module doc): log the safe label, move on.
          logger.warn(`travel-legs: recompute failed for trip batch: ${safeErrorLabel(err)}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    markDaysDirty(marks: readonly DirtyDayMark[]): void {
      // The WHOLE body is guarded — a marker must never fail a mutation
      // (R-ib-19), even against a throwing injected scheduler.
      try {
        if (stopped || marks.length === 0) return;
        for (const mark of marks) {
          let bucket = pending.get(mark.tripId);
          if (!bucket) {
            bucket = new Set();
            pending.set(mark.tripId, bucket);
          }
          bucket.add(mark.day);
          if (!timers.has(mark.tripId)) {
            // Fixed window from the FIRST mark (bounded settlement).
            timers.set(
              mark.tripId,
              scheduler.schedule(() => flush(mark.tripId), debounceMs),
            );
          }
        }
      } catch (err) {
        try {
          logger.warn(`travel-legs: dirty-day mark dropped: ${safeErrorLabel(err)}`);
        } catch {
          // Even the logger is untrusted here — marking stays unfailable.
        }
      }
    },

    async idle(): Promise<void> {
      while (draining) await drainPromise;
    },

    stop(): void {
      stopped = true;
      for (const handle of timers.values()) {
        try {
          scheduler.cancel(handle);
        } catch {
          // Cancellation is best-effort at shutdown.
        }
      }
      timers.clear();
      pending.clear();
      queue.length = 0;
    },
  };
}
