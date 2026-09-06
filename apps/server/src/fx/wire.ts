/**
 * Production wiring for the FX proxy (T-9.4; P-9 ruling ③): the live
 * Frankfurter v2 adapter (keyless — no env, no secret; Law #5-compatible
 * free endpoint) + the per-user rate limiter (`RATE_LIMITS.fxRate` — the
 * places-search store pattern: one in-memory store instance per process).
 *
 * Mounted iff auth is mounted (the shared descriptor's requireAuth pin) —
 * `index.ts` enforces the pairing, `createApp` rejects the unguarded
 * combination loudly.
 */
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createFrankfurterPort } from "./provider.js";
import type { FxRouterDeps } from "./routes.js";

const fxRateLimitStore = new InMemoryRateLimitStore();

export function buildFxDeps(): FxRouterDeps {
  return {
    provider: createFrankfurterPort(),
    rateLimit: { store: fxRateLimitStore },
  };
}
