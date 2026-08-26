/**
 * Production wiring for the budgets router (T-9.4). The surface's only
 * dependency is the app database — the Neon WebSocket `Pool` (`getDb()`),
 * TRANSACTION-CAPABLE: the G2 upsert holds the trips lock and writes in a
 * real transaction in prod exactly as on the `postgres-js` test harness.
 * Never rewire this to the Neon-HTTP driver (landmine #1 — its
 * `.transaction()` throws).
 *
 * Mounted iff auth is mounted (both routes are Auth: Required behind the
 * app-wide `requireAuth` + the trip-membership gate, R-money-25) —
 * `index.ts` enforces the pairing, `createApp` rejects the unguarded
 * combination loudly.
 */
import { getDb } from "../db/index.js";
import type { BudgetsRouterDeps } from "./routes.js";

export function buildBudgetsDeps(): BudgetsRouterDeps {
  return { db: getDb() };
}
