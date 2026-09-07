/**
 * Production wiring for the transport reference surface (B-9). The DB is the
 * Neon WebSocket `Pool` (`getDb()`) — every route here is a single-statement
 * read, but the driver choice stays uniform with the rest of the app
 * (landmine #1). No ingest, no jobs: the tables are migration-seeded.
 */
import { getDb } from "../db/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import type { ReferenceRouterDeps } from "./routes.js";

/**
 * Process-wide store for the reference-surface per-user window
 * (RATE_LIMITS.referenceSearch). Bucket keys are rule-namespaced, so one
 * store per process is safe (places/wire.ts pattern).
 */
const referenceRateLimitStore = new InMemoryRateLimitStore();

export function buildReferenceRouterDeps(): ReferenceRouterDeps {
  return { db: getDb(), rateLimit: { store: referenceRateLimitStore } };
}
