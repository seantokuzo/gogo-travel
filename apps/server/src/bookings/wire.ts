/**
 * Production wiring for the bookings router (T-7.1). The surface's
 * dependencies are the app database — the Neon WebSocket `Pool` (`getDb()`),
 * TRANSACTION-CAPABLE: every booking write (booking + derived items, §3.1)
 * is a real transaction in prod exactly as on the `postgres-js` test
 * harness. Never rewire this to the Neon-HTTP driver (landmine #1 — its
 * `.transaction()` throws).
 *
 * DIRTY-DAY MARKER (T-7.3): index.ts passes the LIVE marker from
 * `buildTravelLegs` so booking mutations feed the leg worker; calling with
 * no marker keeps the documented dormant posture (marks dropped at zero
 * cost — tests / travel-legs-less boots).
 *
 * Mounted iff auth is mounted (every route is Auth: Required behind the
 * app-wide `requireAuth` + the trip-membership gate) — `index.ts` enforces
 * the pairing, `createApp` rejects the unguarded combination loudly.
 */
import { getDb } from "../db/index.js";
import { createDirtyDayMarker, type DirtyDayMarker } from "./dirty-days.js";
import type { BookingsRouterDeps } from "./routes.js";

export function buildBookingsDeps(dirtyDays?: DirtyDayMarker): BookingsRouterDeps {
  return {
    db: getDb(),
    dirtyDays: dirtyDays ?? createDirtyDayMarker(),
  };
}
