/**
 * Rate-limit WIRING suite (AU-5, §3.6.3 / R-auth-14) — proves the real auth
 * router mounts the limiter on the right surfaces with the right keys and the
 * spec's exact thresholds, end-to-end through `createApp`. The counter math
 * itself is proven in `rate-limit.test.ts`; here we prove:
 *   • `POST /auth/apple|google` — 10/min per IP → 11th is 429 + Retry-After;
 *     a different IP is unaffected; the window resets on the injected clock.
 *   • `POST /auth/refresh` — 60/hour per IP AND 30/hour per SESSION (sid via
 *     token row); the session limit keys by sid, not IP (a second session from
 *     the same IP still refreshes after the first is capped).
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — Docker-less CI is
 * a HARD FAILURE; a local Docker-less run skips with a loud banner (Law #5).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AuthTokensSchema } from "@gogo/shared/domains/auth";
import { RATE_LIMITS } from "../config.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import type * as schema from "../db/schema/index.js";
import { createApp } from "../app.js";
import { InMemoryRateLimitStore } from "./rate-limit.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place now: src/test/global-setup.ts (T-S3.3 shared container; the
// `--no-file-parallelism` workaround is retired — QUEUE P1).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;

describe.skipIf(!dockerAvailable)("auth rate-limit wiring (integration)", () => {
  let suiteDb: SuiteDb;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let signer: AccessTokenSigner;
  const clock = { ms: 1_000_000_000 };

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("http_rate_limit");
    db = suiteDb.db;

    const pair = await generateKeyPair("ES256");
    signer = { privateKey: pair.privateKey, kid: "gogo-es256-test" };

    const deps: AuthRouterDeps = {
      db,
      verifier: {
        appleJwks: createLocalJWKSet({ keys: [] }),
        googleJwks: createLocalJWKSet({ keys: [] }),
        appleAudience: "com.gogo.travel",
        googleAudiences: ["gid.apps.example"],
      },
      signer,
      accessVerify: { publicKey: pair.publicKey },
      appleExchange: { exchange: () => Promise.reject(new Error("unused")) },
      appleCredentialsKey: Buffer.alloc(32, 7),
      logger: { warn: () => undefined },
      // Injected store + clock + header-driven IP so tests can drive distinct
      // peers under `app.request()` (which has no socket).
      rateLimit: {
        store: new InMemoryRateLimitStore(),
        now: () => clock.ms,
        ipOf: (c) => c.req.header("x-test-ip") ?? "unknown",
      },
    };
    app = createApp({ auth: deps });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  const appleBody = () =>
    JSON.stringify({
      identity_token: "not-a-real-jwt",
      authorization_code: "code",
      raw_nonce: "nonce",
      device: { platform: "ios" },
    });
  const postApple = (ip: string) =>
    app.request("/api/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-ip": ip },
      body: appleBody(),
    });
  const googleBody = () =>
    JSON.stringify({
      id_token: "not-a-real-jwt",
      raw_nonce: "nonce",
      device: { platform: "android" },
    });
  const postGoogle = (ip: string) =>
    app.request("/api/auth/google", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-ip": ip },
      body: googleBody(),
    });
  const postRefresh = (ip: string, refreshToken: string) =>
    app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-ip": ip },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

  async function seedSession() {
    const { user } = await createUserWithEntitlements(db, {
      email: `rl-${uniq()}@example.com`,
      displayName: "RL Tester",
      googleSub: `google-${uniq()}`,
    });
    return createSessionWithTokens(db, { userId: user.id, device: { platform: "ios" }, signer });
  }

  // -------------------------------------------------------------------------
  // §3.6.3 sign-in: 10/min per IP (the 50/day window has headroom here)
  // -------------------------------------------------------------------------

  it("apple sign-in: 10/min per IP → the 11th is 429 + Retry-After; a different IP is unaffected", async () => {
    const ip = "10.0.0.1";
    const perMinute = RATE_LIMITS.signIn[0].limit; // 10
    for (let i = 0; i < perMinute; i++) {
      // Under the limit: reaches verification and fails → 401 (never 429).
      expect((await postApple(ip)).status).toBe(401);
    }
    const limited = await postApple(ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // A different peer has its own budget.
    expect((await postApple("10.0.0.2")).status).toBe(401);
  });

  it("sign-in window resets after a minute (injected clock advance)", async () => {
    const ip = "10.0.0.9";
    for (let i = 0; i < RATE_LIMITS.signIn[0].limit; i++) await postApple(ip);
    expect((await postApple(ip)).status).toBe(429);

    clock.ms += 60_000; // one minute later
    expect((await postApple(ip)).status).toBe(401); // fresh window
  });

  it("sign-in limiter is ONE shared budget across apple AND google (§3.6.3: same row, same IP)", async () => {
    // §3.6.3 lists apple + google on a SINGLE row (10/min, 50/day, per IP) and
    // the router mounts ONE `signInLimiter` instance on both routes → the budget
    // is COMBINED across the two endpoints, not one bucket each (stricter/safer).
    // This locks that intent so a future split can't happen silently.
    const ip = "10.0.0.50";
    const perMinute = RATE_LIMITS.signIn[0].limit; // 10
    // Spend the whole per-minute budget as a MIX of both endpoints on one IP,
    // alternating so NEITHER endpoint individually reaches `perMinute`
    // (5 apple + 5 google). Each is under the cap → reaches verification → 401.
    for (let i = 0; i < perMinute; i++) {
      const res = i % 2 === 0 ? await postApple(ip) : await postGoogle(ip);
      expect(res.status).toBe(401);
    }
    // Budget now exhausted by the COMBINED count, though each endpoint alone made
    // only 5 (< 10). Separate buckets → both would still be 401; the OTHER
    // endpoint being 429 proves the two share one per-IP bucket.
    const nextGoogle = await postGoogle(ip);
    expect(nextGoogle.status).toBe(429);
    expect(Number(nextGoogle.headers.get("retry-after"))).toBeGreaterThan(0);
    // And back to apple: also 429 on the same shared, exhausted bucket.
    expect((await postApple(ip)).status).toBe(429);

    // A different peer still has the full shared budget → this was the IP key,
    // not global cross-talk.
    expect((await postGoogle("10.0.0.51")).status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // §3.6.3 refresh: per-IP 60/hour, per-SESSION 30/hour (keyed by sid)
  // -------------------------------------------------------------------------

  it("refresh: per-IP 60/hour → the 61st unknown-token attempt is 429", async () => {
    const ip = "20.0.0.1";
    const perIp = RATE_LIMITS.refreshPerIp.limit; // 60
    for (let i = 0; i < perIp; i++) {
      // Unknown token → 401 (session window skipped), but the IP window charges.
      expect((await postRefresh(ip, `unknown-${uniq()}`)).status).toBe(401);
    }
    const limited = await postRefresh(ip, `unknown-${uniq()}`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refresh: per-SESSION 30/hour keys by sid — session A caps at 30 while session B (same IP) still refreshes", async () => {
    const ip = "20.0.0.2";
    const perSession = RATE_LIMITS.refreshPerSession.limit; // 30
    const a = await seedSession();
    const b = await seedSession();

    // Chain `perSession` successful rotations on session A (each charges the
    // session counter, then rotates). All succeed (< the 60/hour IP window too).
    let token = a.refreshToken;
    for (let i = 0; i < perSession; i++) {
      const res = await postRefresh(ip, token);
      expect(res.status).toBe(200);
      token = AuthTokensSchema.parse(await res.json()).refresh_token;
    }
    // The 31st charge on session A trips the session window → 429 BEFORE rotation
    // (so the token is still valid — this is a rate limit, not reuse/theft).
    const capped = await postRefresh(ip, token);
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);

    // Session B, SAME IP, has its own session budget → still refreshes. Proves
    // the 429 above was the per-SESSION key, not the per-IP key (IP has ~31/60).
    expect((await postRefresh(ip, b.refreshToken)).status).toBe(200);
  });
});
