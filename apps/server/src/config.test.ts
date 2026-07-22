/**
 * T-5.2 config pins (auth-users spec §3.2). The route-level TTL assertions in
 * `signin-routes.db.test.ts` are tautological — they compare the route's
 * output against the SAME constant the route consumed, so a fat-fingered
 * change (15 min → 15 h) auto-passes. The spec pins 15 min / 30 days
 * precisely "so tests assert them"; this file is that independent assertion,
 * against the literal spec values.
 */
import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS } from "./config.js";

describe("auth token TTL config (spec §3.2)", () => {
  it("access-token TTL is exactly 15 minutes", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it("refresh-token TTL is exactly 30 days", () => {
    expect(REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });
});
