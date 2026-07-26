/**
 * Production wiring for the trips router (T-6.1). The surface's only
 * dependency is the app database — and that database is the Neon WebSocket
 * `Pool` (`getDb()`), which is TRANSACTION-CAPABLE: trip create (trip row +
 * owner membership, R-trips-3) and the pre-expense base-currency change
 * (trip + budget rows, R-trips-22) are real transactions in prod exactly as
 * they are on the `postgres-js` test harness. Never rewire this to the
 * Neon-HTTP driver (landmine #1 — its `.transaction()` throws).
 *
 * Mounted iff auth is mounted (every route is Auth: Required behind the
 * app-wide `requireAuth`) — `index.ts` enforces the pairing, `createApp`
 * rejects the unguarded combination loudly.
 */
import { getDb } from "../db/index.js";
import type { TripsRouterDeps } from "./routes.js";

export function buildTripsDeps(): TripsRouterDeps {
  return { db: getDb() };
}
