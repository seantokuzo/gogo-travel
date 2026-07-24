import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { app, PUBLIC_ALLOWLIST } from "./app.js";

// Same createRequire pattern app.ts uses — the test asserts against the real manifest.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("GET /api/health", () => {
  it("returns ok:true and the package version", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(pkg.version);
  });
});

describe("public allowlist (R-authz-1)", () => {
  // Hono auto-serves HEAD for the GET health route; the guard keys on
  // "METHOD /path", so HEAD must be allowlisted alongside GET or LB/uptime
  // probes using HEAD get 401'd into "unhealthy". requireAuth's consumption
  // of this set (allowlisted → runs without a token) is covered in
  // require-auth.test.ts; here we pin the exact membership.
  it("permits GET and HEAD on the health check", () => {
    expect(PUBLIC_ALLOWLIST.has("GET /api/health")).toBe(true);
    expect(PUBLIC_ALLOWLIST.has("HEAD /api/health")).toBe(true);
  });

  it("permits exactly the three public auth routes (POST apple/google/refresh) and nothing more", () => {
    expect(PUBLIC_ALLOWLIST.has("POST /api/auth/apple")).toBe(true);
    expect(PUBLIC_ALLOWLIST.has("POST /api/auth/google")).toBe(true);
    expect(PUBLIC_ALLOWLIST.has("POST /api/auth/refresh")).toBe(true);
    // A protected route must never be public — guard against allowlist drift.
    expect(PUBLIC_ALLOWLIST.has("POST /api/auth/logout")).toBe(false);
    expect(PUBLIC_ALLOWLIST.has("GET /api/auth/sessions")).toBe(false);
    expect(PUBLIC_ALLOWLIST.size).toBe(5);
  });
});
