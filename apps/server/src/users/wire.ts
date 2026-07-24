/**
 * Production wiring for the users router (T-5.5). Binds the DI seams to the
 * real world: the app database, the live cash.app HEAD checker (R-user-6),
 * and — until the object-storage provider escalation resolves (Autonomy
 * Contract #3; spec §3.7/§3.8) — the UNCONFIGURED storage stand-in, under
 * which avatar presign fails loud (500) and avatar commits fail closed
 * (400). Everything else on the users surface is fully live.
 *
 * Mounted iff auth is mounted (the routes are Auth: Required and depend on
 * the app-wide `requireAuth` guard) — `index.ts` enforces that pairing.
 */
import { getDb } from "../db/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { UNCONFIGURED_OBJECT_STORAGE } from "../storage/object-storage.js";
import { createHttpCashtagChecker } from "./cashtag.js";
import type { UsersRouterDeps } from "./routes.js";

/**
 * Process-wide store for the user-keyed windows (§3.6.3). Bucket keys are
 * rule-namespaced, so sharing one store per process is safe and keeps window
 * state coherent across surfaces.
 */
const usersRateLimitStore = new InMemoryRateLimitStore();

export function buildUsersDepsFromEnv(): UsersRouterDeps {
  return {
    db: getDb(),
    storage: UNCONFIGURED_OBJECT_STORAGE,
    cashtagChecker: createHttpCashtagChecker(),
    rateLimit: { store: usersRateLimitStore },
  };
}
