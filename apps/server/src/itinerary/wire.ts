/**
 * Production wiring for the itinerary router (T-7.2). Dependencies are the
 * app database — the Neon WebSocket `Pool` (`getDb()`), TRANSACTION-CAPABLE:
 * every item mutation (reorder, unschedule-with-status-revert) is a real
 * transaction in prod exactly as on the `postgres-js` test harness. Never
 * rewire this to the Neon-HTTP driver (landmine #1 — its `.transaction()`
 * throws) — and the dormant dirty-day marker seam (T-7.3 fills the
 * internals; until then marks are accepted and dropped at zero cost).
 *
 * Mounted iff auth is mounted (every route is Auth: Required behind the
 * app-wide `requireAuth` + the trip-membership gate) — `createApp` rejects
 * the unguarded combination loudly.
 */
import { getDb } from "../db/index.js";
import { createDirtyDayMarker } from "../bookings/dirty-days.js";
import type { ItineraryRouterDeps } from "./routes.js";

export function buildItineraryDeps(): ItineraryRouterDeps {
  return {
    db: getDb(),
    dirtyDays: createDirtyDayMarker(),
  };
}
