/**
 * In-process ingest queue + the two spec'd triggers (places spec §3.1.3):
 *
 * - PRIMARY (R-places-1): trip create / destination change →
 *   `enqueueDestination` — the cell containing the destination + its 8
 *   neighbors. Called POST-COMMIT by the trips router; by contract it NEVER
 *   throws and never blocks (fire-and-forget) — a failed enqueue must never
 *   fail the user request.
 * - SECONDARY (R-places-7, enqueue half): geo-scoped search over
 *   non-`ready`/stale cells → `enqueueSearchMiss` — throttled to one enqueue
 *   per cell per hour so scan-the-globe panning can't stampede jobs. The
 *   /places/search endpoint (T-6.5) is the caller; the seam ships here.
 *
 * Single-instance, in-memory — the same acceptable-until-≥2-instances
 * posture as http/rate-limit.ts (§3.6.3). Cells run ONE at a time (a serial
 * drain) so a burst of trips can't stampede the DB; duplicate keys collapse
 * while queued, and the job's own freshness gate (R-places-5) no-ops
 * anything that raced to fresh in the meantime.
 */
import { regionCellsForDestination, type RegionCell } from "@gogo/shared/region-grid";
import { PLACES_SEARCH_MISS_THROTTLE_MS } from "../config.js";

/** What routers depend on — the enqueue half only (jobs run behind it). */
export interface PlacesIngestTrigger {
  /** R-places-1: primary trigger. Never throws; never blocks. */
  enqueueDestination(lat: number, lng: number): void;
  /** R-places-7: secondary trigger, per-cell-per-hour throttle. Never throws. */
  enqueueSearchMiss(cells: readonly RegionCell[]): void;
}

export interface PlacesIngestQueueDeps {
  /** The job (region-ingest.ts, wired) — errors are caught + logged here. */
  ingestCell: (cell: RegionCell) => Promise<unknown>;
  now?: () => Date;
  logger?: { warn: (message: string) => void };
  /** Override seam for tests; default PLACES_SEARCH_MISS_THROTTLE_MS. */
  searchMissThrottleMs?: number;
}

export interface PlacesIngestQueue extends PlacesIngestTrigger {
  /** Resolves when every currently queued cell has run (tests/shutdown). */
  idle(): Promise<void>;
}

/** Throttle-map hygiene bound — prune expired entries past this size. */
const THROTTLE_MAP_MAX_ENTRIES = 10_000;

export function createPlacesIngestQueue(deps: PlacesIngestQueueDeps): PlacesIngestQueue {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const throttleMs = deps.searchMissThrottleMs ?? PLACES_SEARCH_MISS_THROTTLE_MS;

  // Two-tier scheduling: destination cells (a user just created/moved a
  // trip — they're about to look at this map) drain BEFORE search-miss
  // backfill cells (opportunistic coverage). Within a tier, FIFO.
  const queues = {
    destination: new Map<string, RegionCell>(),
    searchMiss: new Map<string, RegionCell>(),
  } as const;
  type Tier = keyof typeof queues;
  const lastSearchMissEnqueue = new Map<string, number>();
  let draining = false;
  let drainPromise: Promise<void> = Promise.resolve();

  function nextEntry(): { key: string; cell: RegionCell; tier: Tier } | undefined {
    for (const tier of ["destination", "searchMiss"] as const) {
      const next = queues[tier].entries().next();
      if (!next.done) return { key: next.value[0], cell: next.value[1], tier };
    }
    return undefined;
  }

  async function drain(): Promise<void> {
    try {
      for (;;) {
        const entry = nextEntry();
        if (!entry) break;
        // Remove BEFORE running so a re-enqueue mid-run is not lost.
        queues[entry.tier].delete(entry.key);
        try {
          await deps.ingestCell(entry.cell);
        } catch (err) {
          // The job records failures on the region row itself (R-places-4);
          // this catches wiring-level errors so the drain loop never dies.
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`places-ingest: cell ${entry.key} job error: ${message}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  function schedule(cells: readonly RegionCell[], tier: Tier): void {
    for (const cell of cells) {
      if (tier === "destination") {
        // A destination trigger outranks a pending backfill for the same cell.
        queues.searchMiss.delete(cell.key);
        if (!queues.destination.has(cell.key)) queues.destination.set(cell.key, cell);
      } else if (!queues.destination.has(cell.key) && !queues.searchMiss.has(cell.key)) {
        queues.searchMiss.set(cell.key, cell);
      }
    }
    if (!draining && nextEntry() !== undefined) {
      draining = true;
      drainPromise = drain();
    }
  }

  return {
    enqueueDestination(lat, lng) {
      try {
        // Coordinate guard stays as robustness (R-places-1 resolved note):
        // invalid coords log-and-drop rather than throw into the request.
        schedule(regionCellsForDestination(lat, lng), "destination");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`places-ingest: destination enqueue dropped: ${message}`);
      }
    },

    enqueueSearchMiss(cells) {
      try {
        const nowMs = now().getTime();
        if (lastSearchMissEnqueue.size > THROTTLE_MAP_MAX_ENTRIES) {
          for (const [key, at] of lastSearchMissEnqueue) {
            if (nowMs - at >= throttleMs) lastSearchMissEnqueue.delete(key);
          }
        }
        const due = cells.filter((cell) => {
          const last = lastSearchMissEnqueue.get(cell.key);
          return last === undefined || nowMs - last >= throttleMs;
        });
        for (const cell of due) lastSearchMissEnqueue.set(cell.key, nowMs);
        schedule(due, "searchMiss");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`places-ingest: search-miss enqueue dropped: ${message}`);
      }
    },

    async idle() {
      while (draining) await drainPromise;
    },
  };
}
