/**
 * FX proxy route tests (T-9.4; ruling ③) — the router behind the REAL
 * app-wide middleware stack (`createApp({ auth })`: requestId → requireAuth
 * → bodyLimit → error serializer). No DB and no live network: the provider
 * is a recording stub behind the `FxProviderPort` seam, auth deps are the
 * app.test.ts construction-time stubs (requireAuth verifies statelessly),
 * and tokens are minted directly with jose.
 *
 * Pins: the requireAuth posture (the shared descriptor's JSDoc), the
 * per-day cache (one provider hit per pair per UTC day; direction-distinct
 * keys; day rollover refetches; error arms NEVER cached — the
 * provider-confirmed-only rule), the error mapping (unsupported → 400
 * VALIDATION_FAILED; unavailable → 503 AI_UPSTREAM manual-fallback arm),
 * boundary validation of the query, and the per-user rate limit.
 */
import { createLocalJWKSet, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { FxRateReadSchema, type FxRateRead } from "@gogo/shared/domains/money";
import { createApp } from "../app.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  RATE_LIMITS,
} from "../config.js";
import type { DbClient } from "../db/create-user.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createFxRouter } from "./routes.js";
import type { FxProviderPort, FxProviderResult } from "./provider.js";

interface StubProvider extends FxProviderPort {
  calls: Array<{ base: string; quote: string }>;
  respond: (base: string, quote: string) => FxProviderResult;
}

function stubProvider(
  respond: (base: string, quote: string) => FxProviderResult,
): StubProvider {
  const provider: StubProvider = {
    provider: "stub",
    calls: [],
    respond,
    rate(base, quote) {
      provider.calls.push({ base, quote });
      return Promise.resolve(provider.respond(base, quote));
    },
  };
  return provider;
}

const confirmed = (base: string, quote: string, rate = "1.1675"): FxProviderResult => ({
  kind: "rate",
  read: { base, quote, rate, as_of: "2026-08-26" },
});

describe("GET /fx/rate (proxy route)", () => {
  let signerKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let app: ReturnType<typeof createApp>;
  let provider: StubProvider;
  let now: Date;
  let rateLimitNow: number;

  const mintToken = () =>
    new SignJWT({ sid: "11111111-1111-4111-8111-111111111111" })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setSubject("22222222-2222-4222-8222-222222222222")
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(signerKey);

  beforeEach(async () => {
    const pair = await generateKeyPair("ES256");
    signerKey = pair.privateKey;
    const authDeps: AuthRouterDeps = {
      // Construction-time stub — no request in this suite reaches the DB
      // (requireAuth verifies statelessly; the FX route has no DB dep).
      db: {} as DbClient,
      verifier: {
        appleJwks: createLocalJWKSet({ keys: [] }),
        googleJwks: createLocalJWKSet({ keys: [] }),
        appleAudience: "com.gogo.travel",
        googleAudiences: ["gid.apps.example"],
      },
      signer: { privateKey: pair.privateKey, kid: "test-kid" },
      accessVerify: { publicKey: pair.publicKey },
      appleExchange: { exchange: () => Promise.reject(new Error("unused in this suite")) },
      appleCredentialsKey: Buffer.alloc(32, 7),
      logger: { warn: () => undefined },
    };

    provider = stubProvider((base, quote) => confirmed(base, quote));
    now = new Date("2026-08-26T10:00:00.000Z");
    rateLimitNow = now.getTime();
    app = createApp({ auth: authDeps });
    app.route(
      "/api",
      createFxRouter({
        provider,
        now: () => now,
        rateLimit: { store: new InMemoryRateLimitStore(), now: () => rateLimitNow },
      }),
    );
  });

  const get = async (query: string, token?: string) =>
    app.request(`/api/fx/rate${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("401 without a token — the descriptor's requireAuth pin (never an open proxy)", async () => {
    const res = await get("?base=EUR&quote=USD");
    expect(res.status).toBe(401);
    expect(provider.calls).toHaveLength(0); // the provider is never reached
  });

  it("200: proxies a provider-confirmed pair as the shared FxRateRead shape", async () => {
    const res = await get("?base=EUR&quote=USD", await mintToken());
    expect(res.status).toBe(200);
    const body: FxRateRead = FxRateReadSchema.parse(await res.json());
    expect(body).toEqual({ base: "EUR", quote: "USD", rate: "1.1675", as_of: "2026-08-26" });
  });

  it("400 on a bad query: missing/lowercase/non-ISO codes never reach the provider", async () => {
    const token = await mintToken();
    for (const query of ["", "?base=EUR", "?quote=USD", "?base=eur&quote=USD", "?base=EURO&quote=USD"]) {
      const res = await get(query, token);
      expect(res.status, query).toBe(400);
      const envelope = (await res.json()) as { error: { code: string } };
      expect(envelope.error.code).toBe("VALIDATION_FAILED");
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("day cache: one provider hit per pair per UTC day; direction and pair are distinct keys", async () => {
    const token = await mintToken();
    expect((await get("?base=EUR&quote=USD", token)).status).toBe(200);
    expect((await get("?base=EUR&quote=USD", token)).status).toBe(200);
    expect(provider.calls).toHaveLength(1); // second call served from cache

    expect((await get("?base=USD&quote=EUR", token)).status).toBe(200); // reverse direction
    expect((await get("?base=USD&quote=JPY", token)).status).toBe(200); // different pair
    expect(provider.calls).toHaveLength(3);
  });

  it("day cache: rolls over at the UTC day boundary — the pair refetches", async () => {
    const token = await mintToken();
    await get("?base=EUR&quote=USD", token);
    expect(provider.calls).toHaveLength(1);

    now = new Date("2026-08-27T00:00:01.000Z"); // next UTC day
    provider.respond = (base, quote) => confirmed(base, quote, "1.2");
    const res = await get("?base=EUR&quote=USD", token);
    expect(provider.calls).toHaveLength(2);
    expect(FxRateReadSchema.parse(await res.json()).rate).toBe("1.2");
  });

  it("unsupported pair → 400 VALIDATION_FAILED, and the failure is NEVER cached", async () => {
    const token = await mintToken();
    provider.respond = () => ({ kind: "unsupported", detail: "HTTP 422" });

    const first = await get("?base=EUR&quote=XXX", token);
    expect(first.status).toBe(400);
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_FAILED",
    );

    await get("?base=EUR&quote=XXX", token);
    expect(provider.calls).toHaveLength(2); // no negative-cache entry
  });

  it("provider outage → 503 AI_UPSTREAM (manual-fallback arm), never cached; recovery serves fresh", async () => {
    const token = await mintToken();
    provider.respond = () => ({ kind: "unavailable", detail: "HTTP 500" });

    const res = await get("?base=EUR&quote=USD", token);
    expect(res.status).toBe(503);
    const envelope = (await res.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("AI_UPSTREAM");
    expect(envelope.error.message).toContain("manual");
    // The provider's internal detail never reaches the client body.
    expect(JSON.stringify(envelope)).not.toContain("HTTP 500");

    // Recovery: the next request goes back to the provider (the outage was
    // not cached) and the confirmed answer IS — the follow-up is a cache hit.
    provider.respond = (base, quote) => confirmed(base, quote);
    expect((await get("?base=EUR&quote=USD", token)).status).toBe(200);
    await get("?base=EUR&quote=USD", token);
    expect(provider.calls).toHaveLength(2); // outage + recovery; hit adds none
  });

  it("per-user rate limit: RATE_LIMITS.fxRate requests pass, the next is 429 + Retry-After", async () => {
    const token = await mintToken();
    for (let i = 0; i < RATE_LIMITS.fxRate.limit; i += 1) {
      expect((await get("?base=EUR&quote=USD", token)).status).toBe(200);
    }
    const limited = await get("?base=EUR&quote=USD", token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
      "RATE_LIMITED",
    );

    // Window reset restores service.
    rateLimitNow += RATE_LIMITS.fxRate.windowMs + 1;
    expect((await get("?base=EUR&quote=USD", token)).status).toBe(200);
  });
});
