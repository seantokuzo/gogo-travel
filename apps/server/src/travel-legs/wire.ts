/**
 * Production wiring for the travel-leg surface (T-7.3 / IB-3): provider
 * ports from env, ONE worker instance per process (the dirty-day queue is a
 * singleton by design — two instances would double-recompute), the
 * refresh-legs router deps, and the staleness-sweep interval driver.
 *
 * ENV SEAMS (env.ts — Law #1: values only ever live in env, never logged):
 *  - `MAPBOX_ACCESS_TOKEN` absent ⇒ NO Mapbox port ⇒ driving/walking/
 *    cycling legs degrade to absent per R-ib-19/21 — never an error on any
 *    mutation path. index.ts owns the boot warn (wire modules stay silent —
 *    the T-5.5 object-storage precedent).
 *  - `TRANSITOUS_BASE_URL` defaults to the public community instance
 *    (keyless) — the transit port is always constructed.
 *
 * DB: `getDb()` — the Neon WebSocket `Pool`, TRANSACTION-CAPABLE: the
 * recompute's multi-row leg write is a real transaction in prod exactly as
 * on the `postgres-js` test harness. Never rewire to Neon-HTTP (landmine #1).
 *
 * STALENESS JOB (R-ib-23): an in-process recursive timeout (self-reschedules
 * after each run — no overlap possible), first run one full interval after
 * start (no boot stampede). This is the spec'd `leg-ETA refresh` job
 * (PLANNING § Component map) — free-tier HTTP only, zero LLM, zero metered
 * spend (Law #5 untouched).
 */
import type { Env } from "../env.js";
import { TRAVEL_LEGS_SWEEP_INTERVAL_MS } from "../config.js";
import { getDb } from "../db/index.js";
import { createDirtyDayMarker, type DirtyDayMarker } from "../bookings/dirty-days.js";
import { createLegRecomputer } from "./recompute.js";
import { sweepStaleLegs } from "./staleness.js";
import { createMapboxDirectionsPort, createTransitousPort, type RoutingPort } from "./providers.js";
import { createTravelLegWorker, safeErrorLabel, type TravelLegWorker } from "./worker.js";
import type { TravelLegsRouterDeps } from "./routes.js";

export interface TravelLegsBuild {
  /**
   * The live dirty-day marker — index.ts hands this to EVERY mutation
   * surface's deps (bookings; itinerary when its wiring integrates) so all
   * marks funnel into the one worker.
   */
  marker: DirtyDayMarker;
  worker: TravelLegWorker;
  routerDeps: TravelLegsRouterDeps;
  /** For index.ts's boot warn — never the token itself. */
  mapboxConfigured: boolean;
  /** Start the staleness interval; returns a stop function (tests/shutdown). */
  startStalenessJob(): () => void;
}

/** The one logger seam for the whole surface — prod swaps happen HERE. */
export interface TravelLegsLogger {
  warn(message: string): void;
}

export function buildTravelLegs(env: Env, logger: TravelLegsLogger = console): TravelLegsBuild {
  const db = getDb();

  const ports: RoutingPort[] = [];
  const mapboxConfigured = env.MAPBOX_ACCESS_TOKEN !== undefined;
  if (env.MAPBOX_ACCESS_TOKEN !== undefined) {
    ports.push(createMapboxDirectionsPort({ accessToken: env.MAPBOX_ACCESS_TOKEN }));
  }
  ports.push(createTransitousPort({ baseUrl: env.TRANSITOUS_BASE_URL }));

  // FK-race requeue is LATE-BOUND: the recomputer needs the marker, the
  // marker wraps the worker, and the worker drains the recomputer — the ref
  // indirection closes that cycle (until `current` is assigned below, a
  // requeue is a no-op; nothing drains before wiring completes).
  const liveMarker: { current?: DirtyDayMarker } = {};
  const worker = createTravelLegWorker({
    recompute: createLegRecomputer({
      db,
      ports,
      logger,
      requeue: { markDaysDirty: (marks) => liveMarker.current?.markDaysDirty(marks) },
    }),
    logger,
  });
  // The frozen seam factory wraps the worker in its never-throws guard —
  // T-7.3's "fill the internals" (bookings/dirty-days.ts module doc).
  const marker = createDirtyDayMarker(worker);
  liveMarker.current = marker;

  return {
    marker,
    worker,
    routerDeps: { db, dirtyDays: marker },
    mapboxConfigured,

    startStalenessJob() {
      let stopped = false;
      let handle: NodeJS.Timeout;
      const scheduleNext = () => {
        handle = setTimeout(() => {
          void sweepStaleLegs({ db, marker })
            .catch((err: unknown) => {
              logger.warn(`[travel-legs] staleness sweep failed: ${safeErrorLabel(err)}`);
            })
            .finally(() => {
              if (!stopped) scheduleNext();
            });
        }, TRAVEL_LEGS_SWEEP_INTERVAL_MS);
      };
      scheduleNext();
      return () => {
        stopped = true;
        clearTimeout(handle);
      };
    },
  };
}
