/**
 * Production wiring for the itinerary router (T-7.2). Dependencies are the
 * app database — the Neon WebSocket `Pool` (`getDb()`), TRANSACTION-CAPABLE:
 * every item mutation (reorder, unschedule-with-status-revert) is a real
 * transaction in prod exactly as on the `postgres-js` test harness. Never
 * rewire this to the Neon-HTTP driver (landmine #1 — its `.transaction()`
 * throws).
 *
 * DIRTY-DAY MARKER (T-7.3): index.ts passes the LIVE marker from
 * `buildTravelLegs` so item mutations feed the leg worker; calling with
 * no marker keeps the documented dormant posture (marks dropped at zero
 * cost — tests / travel-legs-less boots). Same contract as
 * `buildBookingsDeps`; the composition pin lives in
 * `travel-legs/marker-wiring.test.ts`.
 *
 * Mounted iff auth is mounted (every route is Auth: Required behind the
 * app-wide `requireAuth` + the trip-membership gate) — `createApp` rejects
 * the unguarded combination loudly.
 */
import { getDb } from "../db/index.js";
import { createDirtyDayMarker, type DirtyDayMarker } from "../bookings/dirty-days.js";
import type { ItineraryRouterDeps } from "./routes.js";

export function buildItineraryDeps(dirtyDays?: DirtyDayMarker): ItineraryRouterDeps {
  return {
    db: getDb(),
    dirtyDays: dirtyDays ?? createDirtyDayMarker(),
  };
}
