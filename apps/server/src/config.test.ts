/**
 * T-5.2 config pins (auth-users spec §3.2). The route-level TTL assertions in
 * `signin-routes.db.test.ts` are tautological — they compare the route's
 * output against the SAME constant the route consumed, so a fat-fingered
 * change (15 min → 15 h) auto-passes. The spec pins 15 min / 30 days
 * precisely "so tests assert them"; this file is that independent assertion,
 * against the literal spec values.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  PLACES_INGEST_BATCH_SIZE,
  PLACES_INGEST_ERROR_MAX_CHARS,
  PLACES_INGEST_MAX_ATTEMPTS,
  PLACES_INGEST_RETRY_BASE_MS,
  PLACES_REFRESH_WINDOW_DAYS,
  PLACES_REFRESH_WINDOW_MS,
  PLACES_SEARCH_MISS_THROTTLE_MS,
  REFRESH_TOKEN_TTL_DAYS,
} from "./config.js";

describe("auth token TTL config (spec §3.2)", () => {
  it("access-token TTL is exactly 15 minutes", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it("refresh-token TTL is exactly 30 days", () => {
    expect(REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });
});

// Independent assertions against the literal places-spec values (same
// rationale as above: route/job tests compare against the SAME constant the
// code consumed, so a fat-fingered change auto-passes there).
describe("places ingest config (places spec §3.1)", () => {
  it("refresh window is exactly the spec'd 90-day default (R-places-5)", () => {
    expect(PLACES_REFRESH_WINDOW_DAYS).toBe(90);
    expect(PLACES_REFRESH_WINDOW_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("batch size sits in the spec'd 500–1,000 band (§3.1.4 step 4)", () => {
    expect(PLACES_INGEST_BATCH_SIZE).toBeGreaterThanOrEqual(500);
    expect(PLACES_INGEST_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });

  it("retries max 3 with a sane backoff base (§3.1.4 step 6)", () => {
    expect(PLACES_INGEST_MAX_ATTEMPTS).toBe(3);
    expect(PLACES_INGEST_RETRY_BASE_MS).toBe(1_000);
  });

  it("search-miss throttle is exactly one enqueue per cell per hour (§3.1.3)", () => {
    expect(PLACES_SEARCH_MISS_THROTTLE_MS).toBe(60 * 60 * 1000);
  });

  it("region-row error text is bounded (ops queries, never a stack dump)", () => {
    expect(PLACES_INGEST_ERROR_MAX_CHARS).toBe(500);
  });
});
