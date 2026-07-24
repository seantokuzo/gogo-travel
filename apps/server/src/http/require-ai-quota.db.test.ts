/**
 * `requireAiQuota` integration suite (AU-5, R-ent-2 / auth-users §3.5) — the
 * AI cap GATE seam (AU-5 owns the gate; the AI platform, P-10, owns the model
 * call + `ai_usage` increment). End-to-end over a real Postgres, with a fake
 * kill switch and a model-call counter proving the gate runs BEFORE the model.
 *
 * Verified: kill switch → 503 `AI_DISABLED` (no model); at/over the effective
 * cap → 429 `AI_CAP_EXCEEDED` (no model, with `{ feature, cap, resets_at }`);
 * the cap sums only cap-COUNTING features (capture/tour-guide/recap excluded);
 * `resolveEntitlements` overrides are honored; under cap → 200 + model runs.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — Docker-less CI is
 * a HARD FAILURE; a local Docker-less run skips with a loud banner (Law #5).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { generateKeyPair } from "jose";
import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AiFeature } from "@gogo/shared/enums";
import type { EntitlementOverrides } from "@gogo/shared/domains/entitlement";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import { requestIdMiddleware, createErrorHandler } from "./app-middleware.js";
import type { RequestVars } from "./errors.js";
import { createRequireAuth } from "./require-auth.js";
import { aiQuotaContextOf, createRequireAiQuota } from "./require-ai-quota.js";

const dockerAvailable = await (async () => {
  try {
    await promisify(execFile)("docker", ["info"], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
})();

if (!dockerAvailable) {
  console.warn(
    "\n╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  DOCKER UNAVAILABLE — requireAiQuota GATE SUITE SKIPPED           ║\n" +
      "║  The AI cap seam (auth-users §3.5, R-ent-2) was NOT verified.     ║\n" +
      "║  Start Docker and re-run before treating this green.             ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("requireAiQuota suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the requireAiQuota gate suite could " +
        "not verify auth-users §3.5 / R-ent-2. A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const FIXED_NOW = new Date("2026-07-15T12:00:00.000Z");
const TODAY = "2026-07-15";
const RESETS_AT = "2026-07-16T00:00:00.000Z";
const FREE_CAP = 30;

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

describe.skipIf(!dockerAvailable)("requireAiQuota (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: Hono<RequestVars>;
  let signer: AccessTokenSigner;
  let killed = false;
  let modelCalls = 0;

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(60_000)
      .start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });

    const pair = await generateKeyPair("ES256");
    signer = { privateKey: pair.privateKey, kid: "gogo-es256-test" };

    const requireAiQuota = createRequireAiQuota({
      db,
      killSwitch: { isTripped: () => killed },
      now: () => FIXED_NOW,
    });
    app = new Hono<RequestVars>();
    app.use("*", requestIdMiddleware);
    app.use(
      "*",
      createRequireAuth({
        verifier: { publicKey: pair.publicKey },
        allowlist: new Set(),
        logger: { warn: () => undefined },
      }),
    );
    app.onError(createErrorHandler({ warn: () => undefined }));
    // A metered AI route: the gate runs, THEN (only if allowed) the "model".
    app.post("/api/ai/recs", requireAiQuota("recommendations"), (c) => {
      modelCalls += 1;
      return c.json({ quota: aiQuotaContextOf(c), result: "generated" });
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  afterEach(() => {
    killed = false;
    modelCalls = 0;
  });

  async function seedUser() {
    const { user } = await createUserWithEntitlements(db, {
      email: `aiq-${uniq()}@example.com`,
      displayName: "AI Quota Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  async function seedUsage(userId: string, feature: AiFeature, calls: number) {
    await db.insert(schema.aiUsage).values({ userId, feature, day: TODAY, calls });
  }

  async function setOverrides(userId: string, overrides: EntitlementOverrides) {
    await db
      .update(schema.entitlements)
      .set({ overrides, updatedAt: sql`now()` })
      .where(eq(schema.entitlements.userId, userId));
  }

  const callRecs = (token: string) =>
    app.request("/api/ai/recs", { method: "POST", headers: { authorization: `Bearer ${token}` } });

  // -------------------------------------------------------------------------
  it("under cap → 200, the model runs, and the quota context is attached", async () => {
    const user = await seedUser();
    await seedUsage(user.userId, "recommendations", 5); // 5 of 30 used

    const res = await callRecs(user.accessToken);
    expect(res.status).toBe(200);
    expect(modelCalls).toBe(1);
    const body = (await res.json()) as { quota: { feature: string; cap: number; used: number } };
    expect(body.quota).toEqual({ feature: "recommendations", cap: FREE_CAP, used: 5 });
  });

  it("at the effective cap → 429 AI_CAP_EXCEEDED, model NOT called, details carry feature/cap/resets_at", async () => {
    const user = await seedUser();
    await seedUsage(user.userId, "recommendations", FREE_CAP); // exactly at cap

    const res = await callRecs(user.accessToken);
    expect(res.status).toBe(429);
    expect(modelCalls).toBe(0); // gate ran BEFORE any model call (R-ent-2)
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("AI_CAP_EXCEEDED");
    expect(body.error.details).toEqual({
      feature: "recommendations",
      cap: FREE_CAP,
      resets_at: RESETS_AT,
    });
  });

  it("the global cap SUMS cap-counting features (recs + expense_estimate + packing_list)", async () => {
    const user = await seedUser();
    // 10 + 10 + 10 = 30 = cap, spread across three counting features.
    await seedUsage(user.userId, "recommendations", 10);
    await seedUsage(user.userId, "expense_estimate", 10);
    await seedUsage(user.userId, "packing_list", 10);

    const res = await callRecs(user.accessToken);
    expect(res.status).toBe(429);
    expect(modelCalls).toBe(0);
  });

  it("cap-EXEMPT features never count (100 capture_parse calls, still under cap)", async () => {
    const user = await seedUser();
    await seedUsage(user.userId, "capture_parse", 100); // cap-exempt — excluded

    const res = await callRecs(user.accessToken);
    expect(res.status).toBe(200);
    expect(modelCalls).toBe(1);
    expect(((await res.json()) as { quota: { used: number } }).quota.used).toBe(0);
  });

  it("kill switch tripped → 503 AI_DISABLED, model NOT called, no per-user read even matters", async () => {
    const user = await seedUser();
    await seedUsage(user.userId, "recommendations", 0);
    killed = true;

    const res = await callRecs(user.accessToken);
    expect(res.status).toBe(503);
    expect(modelCalls).toBe(0);
    expect(((await res.json()) as Envelope).error.code).toBe("AI_DISABLED");
  });

  it("respects a lowered override cap (overrides.ai_calls_per_day = 3)", async () => {
    const user = await seedUser();
    await setOverrides(user.userId, { ai_calls_per_day: 3 });
    await seedUsage(user.userId, "recommendations", 3); // at the OVERRIDE cap

    const res = await callRecs(user.accessToken);
    expect(res.status).toBe(429);
    expect(modelCalls).toBe(0);
    expect(((await res.json()) as Envelope).error.details).toMatchObject({ cap: 3 });
  });

  it("respects a raised override cap (100) — 30 used is now under cap → 200", async () => {
    const user = await seedUser();
    await setOverrides(user.userId, { ai_calls_per_day: 100 });
    await seedUsage(user.userId, "recommendations", 30);

    const res = await callRecs(user.accessToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { quota: { cap: number } }).quota.cap).toBe(100);
  });

  it("unauthenticated → 401 (requireAuth precedes the quota gate)", async () => {
    const res = await app.request("/api/ai/recs", { method: "POST" });
    expect(res.status).toBe(401);
    expect(modelCalls).toBe(0);
  });
});
