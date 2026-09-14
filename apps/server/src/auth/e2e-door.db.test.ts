/**
 * E2E session door integration suite (S-4/T3 —
 * `.specs/testing/session-door.spec.md` §2.1's T3 rows), against a real
 * Postgres and the real app composition (`createApp`).
 *
 * Test-design note (spec §2.1, "recorded not required"): every in-process
 * `app.request()` call shares the SAME unresolvable `"unknown"` socket peer,
 * so a suite that calls the door >20 times against one fake-clock minute
 * would start 401-ing on R-door-9's rate limit for reasons unrelated to what
 * a given test asserts. This suite gives EVERY test its OWN
 * `InMemoryRateLimitStore` (`buildApp` below) so no test can ever exhaust
 * another's budget, and drives the R-door-9 rate-limit test itself with an
 * injected `peerOf` distinct from every other test's default.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less CI
 * run is a HARD FAILURE; a local Docker-less run skips with a loud banner.
 */
import { and, eq, isNull, like } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import { timingSafeEqual } from "node:crypto";
import type * as NodeCrypto from "node:crypto";
import { describe, expect, afterAll, beforeAll, beforeEach, inject, it, vi } from "vitest";
import type { Mock } from "vitest";
import * as schema from "../db/schema/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";
import { rotateRefreshToken } from "./token-rotation.js";
import { createApp } from "../app.js";
import type { AuthRouterDeps } from "./routes.js";
import { E2E_DOOR_MAX_FIXTURE_USERS } from "../config.js";
import { type E2eDoorRouterDeps } from "./e2e-door.js";

// R-door-12/13's structural pins need to observe whether the door's compare
// actually reaches `crypto.timingSafeEqual` — a functional match/mismatch
// test alone can't distinguish that from a bare `===` (same observable
// 200/401 outcome, different timing shape). `node:crypto`'s ESM namespace
// isn't `vi.spyOn`-able directly ("Module namespace is not configurable in
// ESM") — the standard vitest workaround is `vi.mock` with
// `importOriginal`, wrapping the real implementation in a `vi.fn()` so it
// still DOES real work (every other test in this file that mints a session
// depends on a REAL constant-time compare) while becoming observable.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const timingSafeEqualSpy = timingSafeEqual as unknown as Mock;

const dockerAvailable = inject("dbAvailable");
const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
const SECRET = "s".repeat(40); // 40 chars, >= the 32-char G2 floor
const WRONG_SECRET = "w".repeat(40); // same length as SECRET, differs by value only
const DOOR_PATH = "/api/auth/e2e/session";

interface UnauthEnvelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/** The 401 envelope minus the per-request correlation id — the byte-identity unit (mirrors `idor-404.test-util.ts`'s 404 twin, but for the door's uniform 401). */
function withoutRequestId(body: UnauthEnvelope) {
  const { requestId: _omit, ...rest } = body.error;
  return rest;
}

/** R-door-3: every response in the list must be BYTE-IDENTICAL — same status, envelope (modulo requestId), content-type, and byte length. */
async function expectIndistinguishable401s(responses: readonly Response[]): Promise<void> {
  expect(responses.length).toBeGreaterThanOrEqual(2);
  let baseline: { body: unknown; contentType: string | null; byteLength: number } | null = null;

  for (const response of responses) {
    expect(response.status).toBe(401);
    const text = await response.clone().text();
    const raw = JSON.parse(text) as UnauthEnvelope;
    expect(raw.error.code).toBe("UNAUTHENTICATED");
    expect(raw.error.message).toBe("authentication failed");
    expect(raw.error.details).toBeUndefined();
    expect(raw.error.requestId).toBeTruthy();

    const body = withoutRequestId(raw);
    const contentType = response.headers.get("content-type");
    const byteLength = Buffer.byteLength(text, "utf8");

    if (baseline === null) {
      baseline = { body, contentType, byteLength };
    } else {
      expect(body).toEqual(baseline.body);
      expect(contentType).toBe(baseline.contentType);
      expect(byteLength).toBe(baseline.byteLength);
    }
  }
}

describe.skipIf(!dockerAvailable)("E2E session door (S-4/T3, integration)", () => {
  let suiteDb: SuiteDb;
  let db: PostgresJsDatabase<typeof schema>;
  let authDeps: AuthRouterDeps;
  let signer: AuthRouterDeps["signer"];

  let seq = 0;
  const uniq = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("e2e_door");
    db = suiteDb.db;
    const pair = await generateKeyPair("ES256");
    signer = { privateKey: pair.privateKey, kid: SIGNER_KID };
    authDeps = {
      db,
      verifier: {
        appleJwks: createLocalJWKSet({ keys: [] }),
        googleJwks: createLocalJWKSet({ keys: [] }),
        appleAudience: "com.gogo.travel",
        googleAudiences: ["gid.apps.example"],
      },
      signer,
      accessVerify: { publicKey: pair.publicKey },
      appleExchange: { exchange: () => Promise.reject(new Error("unused in this suite")) },
      appleCredentialsKey: Buffer.alloc(32, 7),
      logger: { warn: () => undefined },
    };
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  beforeEach(() => {
    timingSafeEqualSpy.mockClear();
  });

  const ALLOWED_PEER = "127.0.0.1";
  const PUBLIC_PEER = "8.8.8.8";

  /** A fresh door-mounted app — its OWN rate-limit store and log capture, so no test can exhaust another's budget (see the file header's test-design note). */
  function buildApp(overrides: Partial<E2eDoorRouterDeps> = {}) {
    const warnings: string[] = [];
    const deps: E2eDoorRouterDeps = {
      db,
      signer,
      secret: SECRET,
      rateLimit: { store: new InMemoryRateLimitStore() },
      maxFixtureUsers: E2E_DOOR_MAX_FIXTURE_USERS,
      logger: { warn: (m) => warnings.push(m) },
      peerOf: () => ALLOWED_PEER,
      ...overrides,
    };
    const app = createApp({ auth: authDeps, e2eDoor: deps });
    return { app, warnings, deps };
  }

  /** A door-ABSENT app (same auth deps) — the R-door-3 "route not mounted" baseline. */
  function buildDoorAbsentApp() {
    return createApp({ auth: authDeps });
  }

  /** Like `buildApp`, but with NO `peerOf` override at all — exercises the real `clientIp` default, which is always `"unknown"` under `app.request()` (no real socket). */
  function buildAppWithRealPeerResolver() {
    const warnings: string[] = [];
    const deps: E2eDoorRouterDeps = {
      db,
      signer,
      secret: SECRET,
      rateLimit: { store: new InMemoryRateLimitStore() },
      maxFixtureUsers: E2E_DOOR_MAX_FIXTURE_USERS,
      logger: { warn: (m) => warnings.push(m) },
    };
    return { app: createApp({ auth: authDeps, e2eDoor: deps }), warnings };
  }

  const validBody = (userKey: string, secret = SECRET) => ({
    secret,
    user_key: userKey,
    device: { platform: "ios" as const },
  });

  const postJson = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const mint = (app: ReturnType<typeof createApp>, body: unknown) => postJson(app, DOOR_PATH, body);
  const unknownPath = (app: ReturnType<typeof createApp>) =>
    postJson(app, "/api/does/not/exist", { anything: true });

  async function userRow(userId: string) {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return row;
  }

  /**
   * Count of LIVE `e2e:`-prefixed users right now. This suite shares one
   * `db` across every test (a fresh testcontainers database per test would
   * be prohibitively slow for ~25 tests) — so any cap-boundary test derives
   * its `maxFixtureUsers` RELATIVE to this baseline instead of a hardcoded
   * absolute like `1`, which prior tests' own minted fixtures would already
   * have exceeded.
   */
  async function liveFixtureCount(): Promise<number> {
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(like(schema.users.appleSub, "e2e:%"), isNull(schema.users.deletedAt)));
    return rows.length;
  }

  // ===========================================================================
  // R-door-3: byte-identical uniform 401 across every failure mode
  // ===========================================================================

  describe("R-door-3: no oracle — every failure mode is byte-identical to an unknown path", () => {
    it("route not mounted", async () => {
      const app = buildDoorAbsentApp();
      await expectIndistinguishable401s([
        await mint(app, validBody(uniq())),
        await unknownPath(app),
      ]);
    });

    it("wrong secret", async () => {
      const { app } = buildApp();
      await expectIndistinguishable401s([
        await mint(app, validBody(uniq(), WRONG_SECRET)),
        await unknownPath(app),
      ]);
    });

    it("secret prefix-correct-but-wrong (right length, one byte off)", async () => {
      const { app } = buildApp();
      const almostRight = "s".repeat(39) + "x"; // same length as SECRET, last byte differs
      await expectIndistinguishable401s([
        await mint(app, validBody(uniq(), almostRight)),
        await unknownPath(app),
      ]);
    });

    it("disallowed peer (public IP)", async () => {
      const { app } = buildApp({ peerOf: () => PUBLIC_PEER });
      await expectIndistinguishable401s([
        await mint(app, validBody(uniq())),
        await unknownPath(app),
      ]);
    });

    it('unresolvable peer (the "unknown" default under app.request())', async () => {
      // No peerOf override — falls through to the real `clientIp`, which is
      // always "unknown" under `app.request()` (no real socket).
      const { app } = buildAppWithRealPeerResolver();
      await expectIndistinguishable401s([
        await mint(app, validBody(uniq())),
        await unknownPath(app),
      ]);
    });

    it("a spoofed Host: 127.0.0.1 header from a non-loopback peer is ignored", async () => {
      const { app } = buildApp({ peerOf: () => PUBLIC_PEER });
      const res = await app.request(DOOR_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1" },
        body: JSON.stringify(validBody(uniq())),
      });
      await expectIndistinguishable401s([res, await unknownPath(app)]);
    });

    it("malformed body (invalid JSON)", async () => {
      const { app } = buildApp();
      const malformed = await app.request(DOOR_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      });
      await expectIndistinguishable401s([malformed, await unknownPath(app)]);
    });

    it("malformed body (valid JSON, wrong shape)", async () => {
      const { app } = buildApp();
      await expectIndistinguishable401s([
        await mint(app, { secret: SECRET }), // missing user_key/device
        await unknownPath(app),
      ]);
    });

    it("oversized body — never the app-wide 413 (§3.6 body-size-ordering)", async () => {
      const { app } = buildApp();
      const oversized = `{"secret":"${SECRET}","user_key":"a","device":{"platform":"ios"},"pad":"${"x".repeat(300 * 1024)}"}`;
      const res = await app.request(DOOR_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(oversized, "utf8")),
        },
        body: oversized,
      });
      await expectIndistinguishable401s([res, await unknownPath(app)]);
    });

    it("ineligible fixture row (google_sub already set on that apple_sub)", async () => {
      const { app } = buildApp();
      const key = uniq();
      await db.insert(schema.users).values({
        email: `e2e+${key}@gogotravel.invalid`,
        displayName: "conflict",
        appleSub: `e2e:${key}`,
        googleSub: "some-google-sub",
      });
      await expectIndistinguishable401s([await mint(app, validBody(key)), await unknownPath(app)]);
    });

    it("ineligible fixture row (deleted_at set)", async () => {
      const { app } = buildApp();
      const key = uniq();
      await db.insert(schema.users).values({
        email: `e2e+${key}@gogotravel.invalid`,
        displayName: "scrubbed",
        appleSub: `e2e:${key}`,
        deletedAt: new Date(),
      });
      await expectIndistinguishable401s([await mint(app, validBody(key)), await unknownPath(app)]);
    });

    it("rate limited", async () => {
      const store = new InMemoryRateLimitStore();
      const { app } = buildApp({ rateLimit: { store, now: () => 1_000_000 } });
      // Exhaust the per-minute window (20) with WRONG secrets — each still
      // charges the bucket before the compare (peer gate passes first).
      for (let i = 0; i < 20; i++) {
        await mint(app, validBody(uniq(), WRONG_SECRET));
      }
      const limited = await mint(app, validBody(uniq()));
      expect(limited.headers.get("retry-after")).toBeNull(); // never 429/Retry-After
      await expectIndistinguishable401s([limited, await unknownPath(app)]);
    });

    it("fixture cap reached", async () => {
      const cap = (await liveFixtureCount()) + 1; // room for exactly one more
      const { app } = buildApp({ maxFixtureUsers: cap });
      const first = await mint(app, validBody(uniq()));
      expect(first.status).toBe(200); // the one remaining slot still resolves
      const second = await mint(app, validBody(uniq()));
      await expectIndistinguishable401s([second, await unknownPath(app)]);
    });
  });

  // ===========================================================================
  // R-door-4: rides the exact issuance path — rotation + reuse-theft holds
  // ===========================================================================

  it("R-door-4: mint via the door, rotate once, replay the original refresh token — the whole family is revoked", async () => {
    const { app } = buildApp();
    const res = await mint(app, validBody(uniq()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: { refresh_token: string } };
    const original = body.tokens.refresh_token;

    const rotated = await rotateRefreshToken(db, { presentedToken: original, signer });
    expect(rotated.refreshToken).not.toBe(original);

    // Replay the ORIGINAL (already-rotated) token — reuse/theft, family dies.
    await expect(
      rotateRefreshToken(db, { presentedToken: original, signer }),
    ).rejects.toMatchObject({ reason: "reuse" });
    // The ROTATED replacement is now dead too (family revoked).
    await expect(
      rotateRefreshToken(db, { presentedToken: rotated.refreshToken, signer }),
    ).rejects.toMatchObject({ reason: "reuse" });
  });

  // ===========================================================================
  // R-door-5: fixture identity find-or-create
  // ===========================================================================

  it("R-door-5: same user_key twice resolves the SAME row (find, not create) with the pinned shape", async () => {
    const { app } = buildApp();
    const key = uniq();
    const first = await mint(app, validBody(key));
    const second = await mint(app, validBody(key));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { user: { id: string; email: string } };
    const secondBody = (await second.json()) as { user: { id: string; email: string } };
    expect(secondBody.user.id).toBe(firstBody.user.id);
    expect(firstBody.user.email).toBe(`e2e+${key}@gogotravel.invalid`);

    const row = await userRow(firstBody.user.id);
    expect(row?.appleSub).toBe(`e2e:${key}`);
    expect(row?.displayName).toBe(`E2E ${key}`);
    expect(row?.googleSub).toBeNull();
  });

  // ===========================================================================
  // R-door-6: log hygiene + boot warning
  // ===========================================================================

  it("R-door-6: a mint's log line carries only requestId/sessionId/user_key/created — never the secret, tokens, or email", async () => {
    const { app, warnings } = buildApp();
    const key = uniq();
    const res = await mint(app, validBody(key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: { access_token: string; refresh_token: string };
      user: { email: string };
    };

    const mintLine = warnings.find((w) => w.includes("e2e door mint"));
    expect(mintLine).toBeTruthy();
    expect(mintLine).toContain(`user_key=${key}`);
    expect(mintLine).toContain("created=true");
    for (const line of warnings) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(body.tokens.access_token);
      expect(line).not.toContain(body.tokens.refresh_token);
      expect(line).not.toContain(body.user.email);
    }
  });

  it("R-door-6: rejection log lines never contain the secret, and are distinguishable by reason", async () => {
    const { app, warnings } = buildApp();
    await mint(app, validBody(uniq(), WRONG_SECRET));
    const rejectLine = warnings.find((w) => w.includes("e2e door rejected"));
    expect(rejectLine).toContain("reason=secret_mismatch");
    expect(rejectLine).not.toContain(SECRET);
  });

  // ===========================================================================
  // R-door-9: own-bucket rate limit, no 429 (folded into the R-door-3 block
  // above); this arm separately proves the limit is per-peer.
  // ===========================================================================

  it("R-door-9: the limit is keyed per PEER — a different peer is unaffected by another's exhausted bucket", async () => {
    const store = new InMemoryRateLimitStore();
    const peers = { current: ALLOWED_PEER };
    const { app } = buildApp({
      rateLimit: { store, now: () => 2_000_000 },
      peerOf: () => peers.current,
    });
    for (let i = 0; i < 20; i++) {
      await mint(app, validBody(uniq(), WRONG_SECRET));
    }
    expect((await mint(app, validBody(uniq()))).status).toBe(401);
    peers.current = "10.0.0.99"; // a DIFFERENT allowed peer, own bucket
    expect((await mint(app, validBody(uniq()))).status).toBe(200);
  });

  // ===========================================================================
  // R-door-12: constant-time compare — structural pin (a functional
  // match/mismatch test cannot distinguish `===` from `timingSafeEqual`;
  // only a spy on the underlying primitive can).
  // ===========================================================================

  it("R-door-12: the secret compare calls node:crypto's timingSafeEqual (structural pin)", async () => {
    const { app } = buildApp();
    await mint(app, validBody(uniq()));
    // Falsification (documented, applied and reverted by hand for this PR):
    // swapping `safeEqual(body.secret, deps.secret)` in `auth/e2e-door.ts`
    // for a bare `body.secret === deps.secret` makes this assertion go RED —
    // the spy is never called, even though the functional 200/401 outcome
    // is IDENTICAL either way (exactly why a black-box test alone can't
    // catch this regression).
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });

  // ===========================================================================
  // R-door-13 (SHOULD): constant-work floor — structural pin on the rejection
  // paths that have no real secret to compare (malformed body; route absent).
  // ===========================================================================

  it("R-door-13 (SHOULD): a malformed body still triggers a timingSafeEqual call (fixed-cost dummy compare)", async () => {
    const { app } = buildApp();
    await app.request(DOOR_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });

  it("R-door-13 (SHOULD): the route-not-mounted path still triggers a timingSafeEqual call (fixed-cost dummy compare)", async () => {
    const app = buildDoorAbsentApp();
    await mint(app, validBody(uniq()));
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });

  // ===========================================================================
  // R-door-14: fixture cap — the wire response is byte-identical (folded
  // above); this pin distinguishes the SERVER LOG line by reason, and proves
  // existing keys keep resolving past the cap.
  // ===========================================================================

  it("R-door-14: with the cap at baseline+2, the 3rd NEW distinct key is rejected (reason=fixture_cap, distinguishable from reason=secret_mismatch) while the first 2 keep resolving", async () => {
    const baseline = await liveFixtureCount();
    const cap = baseline + 2;
    const { app, warnings } = buildApp({ maxFixtureUsers: cap });
    const k1 = uniq();
    const k2 = uniq();
    const k3 = uniq();
    expect((await mint(app, validBody(k1))).status).toBe(200);
    expect((await mint(app, validBody(k2))).status).toBe(200);
    const third = await mint(app, validBody(k3));
    expect(third.status).toBe(401);

    const capLine = warnings.find((w) => w.includes("reason=fixture_cap"));
    expect(capLine).toBeTruthy();
    expect(capLine).toContain(`count=${cap}`);
    expect(capLine).toContain(`max=${cap}`);
    expect(capLine).not.toBe(warnings.find((w) => w.includes("reason=secret_mismatch")));

    // Existing keys still resolve past the cap (lookups are unaffected).
    expect((await mint(app, validBody(k1))).status).toBe(200);
    expect((await mint(app, validBody(k2))).status).toBe(200);
  });
});
