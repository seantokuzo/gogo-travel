/**
 * Production wiring for the settlements router (T-9.3). The surface's
 * dependency is the app database — the Neon WebSocket `Pool` (`getDb()`),
 * TRANSACTION-CAPABLE: the settlement + request-link flip (R-money-18) and
 * the delete + request-reopen (R-money-15) are real transactions in prod
 * exactly as on the `postgres-js` test harness. Never rewire this to the
 * Neon-HTTP driver (landmine #1 — its `.transaction()` throws).
 *
 * CONSUMED BY T-9.4 (the W3 wiring closer): this task deliberately does not
 * touch app.ts/index.ts (P-9 W2 file-ownership split). Mount iff auth is
 * mounted — every route is Auth: Required behind the app-wide `requireAuth`
 * + the trip-membership gate (the bookings pairing rule).
 */
import { getDb } from "../db/index.js";
import type { SettlementsRouterDeps } from "./routes.js";

export function buildSettlementsDeps(): SettlementsRouterDeps {
  return { db: getDb() };
}
