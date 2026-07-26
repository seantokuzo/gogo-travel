import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { app, createApp, PUBLIC_ALLOWLIST } from "./app.js";
import type { PlacesRouterDeps } from "./places/routes.js";
import type { TripsRouterDeps } from "./trips/routes.js";
import type { UsersRouterDeps } from "./users/routes.js";

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

describe("createApp wiring guard", () => {
  it("throws when the users router is mounted without auth deps", () => {
    // Every /users/* route is Auth: Required; mounting the surface without
    // `auth` (no app-wide requireAuth guard) is a wiring bug, rejected loudly
    // at construction so it can never become a silently-unguarded surface. The
    // guard fires before the deps are read, so a stub value never runs.
    let error: unknown;
    try {
      createApp({ users: {} as UsersRouterDeps });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    // Names the missing dep so the wiring bug is diagnosable — no secret values.
    expect((error as Error).message).toContain("auth");
    expect((error as Error).message).toContain("requireAuth");
  });

  it("throws when the trips router is mounted without auth deps", () => {
    // Same pairing rule as users (T-6.1): every trip route is Auth: Required
    // and the /:tripId routes assume the authenticated identity exists.
    let error: unknown;
    try {
      createApp({ trips: {} as TripsRouterDeps });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("auth");
    expect((error as Error).message).toContain("requireAuth");
  });

  it("throws when the places router is mounted without auth deps", () => {
    // Same pairing rule (T-6.5): every places route is Auth: Required and
    // custom-place visibility (Law #3 posture) reads the authenticated
    // identity — never a silently-unguarded surface.
    let error: unknown;
    try {
      createApp({ places: {} as PlacesRouterDeps });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("auth");
    expect((error as Error).message).toContain("requireAuth");
  });
});
