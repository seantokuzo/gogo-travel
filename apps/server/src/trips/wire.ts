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
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createTripEventEmitter } from "./push-invalidation.js";
import type { TripsRouterDeps } from "./routes.js";

/**
 * Process-wide store for the `/invites/:token*` token-guessing windows
 * (trips spec §3.3). Bucket keys are rule-namespaced, so one store per
 * process is safe (same pattern as users/wire.ts).
 */
const tripsRateLimitStore = new InMemoryRateLimitStore();

export function buildTripsDeps(): TripsRouterDeps {
  const db = getDb();
  return {
    db,
    rateLimit: { store: tripsRateLimitStore },
    // Push-invalidation emitter seam (T-6.3, R-trips-18): wired end-to-end so
    // every §3.5 mutation emits post-commit; DORMANT until P-13 supplies the
    // Expo push transport (no transport ⇒ no reads, no delivery — Law #5:
    // nothing here may talk to an external push service yet).
    tripEvents: createTripEventEmitter({ db }),
  };
}
