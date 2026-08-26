/**
 * Production wiring for the expenses router (T-9.2). The surface's only
 * dependency is the app database — the Neon WebSocket `Pool` (`getDb()`),
 * TRANSACTION-CAPABLE: every expense write (expense + shares, R-money-1)
 * is a real transaction in prod exactly as on the `postgres-js` test
 * harness. Never rewire this to the Neon-HTTP driver (landmine #1 — its
 * `.transaction()` throws).
 *
 * Mounted iff auth is mounted (every route is Auth: Required behind the
 * app-wide `requireAuth` + the trip-membership gate, R-money-25) —
 * `index.ts` enforces the pairing, `createApp` rejects the unguarded
 * combination loudly.
 */
import { getDb } from "../db/index.js";
import type { ExpensesRouterDeps } from "./routes.js";

export function buildExpensesDeps(): ExpensesRouterDeps {
  return { db: getDb() };
}
