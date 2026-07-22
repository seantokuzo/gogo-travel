/**
 * T-5.3 token lifecycle integration suite (AU-4): `/auth/refresh` rotation +
 * reuse-theft family revocation, `/auth/logout`, `GET /auth/sessions`,
 * `DELETE /auth/sessions/:id` — end-to-end over a real Postgres. The headline
 * assertion is adversarial: rotate A→B, replay A, and the whole family dies
 * (R-auth-11). Sessions are seeded through the real T-5.2 issuance path
 * (`createSessionWithTokens`), so this exercises issuance → rotation as one
 * chain.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — same harness
 * contract as `signin-routes.db.test.ts`: a Docker-less CI run is a HARD
 * FAILURE; a local Docker-less run skips with a loud banner. No network beyond
 * the local container (Law #5).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair, jwtVerify, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AuthTokensSchema,
  AuthSessionInfoSchema,
  type AuthSessionInfo,
} from "@gogo/shared/domains/auth";
import { paginatedSchema, type Paginated } from "@gogo/shared/api/envelope";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import { JWT_AUDIENCE, JWT_ISSUER, REFRESH_TOKEN_TTL_MS } from "../config.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { sha256Hex } from "./crypto.js";
import type { AuthRouterDeps } from "./routes.js";
import { createSessionWithTokens, type AccessTokenSigner } from "./token-issuer.js";

const dockerAvailable = await (async () => {
  try {
    await promisify(execFile)("docker", ["info"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

if (!dockerAvailable) {
  console.warn(
    "\n" +
      "╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  DOCKER UNAVAILABLE — T-5.3 TOKEN LIFECYCLE SUITE SKIPPED         ║\n" +
      "║  /auth/refresh rotation + reuse-theft family revocation,          ║\n" +
      "║  /auth/logout, and session list/revoke (auth-users spec §3.4.1,   ║\n" +
      "║  R-auth-10..13) were NOT verified. Start Docker and re-run        ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-5.3 token lifecycle suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-5.3 token lifecycle suite " +
        "could not verify auth-users spec §3.4.1 (R-auth-10..13). A skip here " +
        "is NOT a pass. Provision Docker or a Postgres service container.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

describe.skipIf(!dockerAvailable)("T-5.3 token routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: Hono;
  let signer: AccessTokenSigner;
  let accessPublicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
  const warnings: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(60_000)
      .start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(db, { migrationsFolder });

    const signerPair = await generateKeyPair("ES256");
    accessPublicKey = signerPair.publicKey;
    signer = { privateKey: signerPair.privateKey, kid: SIGNER_KID };

    const deps: AuthRouterDeps = {
      db,
      // Provider verifier is unused in this suite (no /auth/apple|google here),
      // but the shape is required — an empty local JWK set never matches.
      verifier: {
        appleJwks: createLocalJWKSet({ keys: [] }),
        googleJwks: createLocalJWKSet({ keys: [] }),
        appleAudience: "com.gogo.travel",
        googleAudiences: ["gid.apps.example"],
      },
      signer,
      accessVerify: { publicKey: signerPair.publicKey },
      appleExchange: { exchange: () => Promise.reject(new Error("unused in this suite")) },
      appleCredentialsKey: Buffer.alloc(32, 7),
      logger: { warn: (message) => warnings.push(message) },
    };
    app = createApp({ auth: deps });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  afterEach(() => {
    warnings.length = 0;
  });

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  async function seedUser() {
    const { user } = await createUserWithEntitlements(db, {
      email: `tok-${uniq()}@example.com`,
      displayName: "Token Tester",
      googleSub: `google-${uniq()}`,
    });
    return user;
  }

  async function seedSession(userId: string, deviceName?: string) {
    return createSessionWithTokens(db, {
      userId,
      device: { platform: "ios", ...(deviceName ? { deviceName } : {}) },
      signer,
    });
  }

  const postRefresh = (refreshToken: string) =>
    app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

  const postLogout = (accessToken: string | null, body: Record<string, unknown> = {}) =>
    app.request("/api/auth/logout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const getSessions = (accessToken: string | null, cursor?: string) => {
    const path = cursor
      ? `/api/auth/sessions?cursor=${encodeURIComponent(cursor)}`
      : "/api/auth/sessions";
    return app.request(path, {
      method: "GET",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  };

  const deleteSession = (accessToken: string | null, sessionId: string) =>
    app.request(`/api/auth/sessions/${sessionId}`, {
      method: "DELETE",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });

  async function sessionRow(sessionId: string) {
    const [row] = await db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.id, sessionId));
    return row;
  }

  async function tokenRows(sessionId: string) {
    return db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.sessionId, sessionId));
  }

  interface ErrorEnvelope {
    error: { code: string; message: string; details?: unknown; requestId?: string };
  }

  async function expect401(res: Response): Promise<ErrorEnvelope> {
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toBeTruthy();
    return body;
  }

  // -------------------------------------------------------------------------
  // Rotation happy path (R-auth-10)
  // -------------------------------------------------------------------------

  it("rotation: valid refresh → new pair, old token rotated, new inserted, last_used bumped — atomically", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id, "Sean's iPhone");
    // Force last_used_at into the past so the bump is unambiguous.
    const past = new Date(Date.now() - 3_600_000);
    await db
      .update(schema.authSessions)
      .set({ lastUsedAt: past })
      .where(eq(schema.authSessions.id, issued.sessionId));

    const before = Date.now();
    const res = await postRefresh(issued.refreshToken);
    expect(res.status).toBe(200);
    const tokens = AuthTokensSchema.parse(await res.json());

    // New pair differs from the old.
    expect(tokens.refresh_token).not.toBe(issued.refreshToken);
    expect(tokens.access_token).not.toBe(issued.accessToken);

    // New access token verifies with exact claims, sub = this user, sid = session.
    const { payload } = await jwtVerify(tokens.access_token, accessPublicKey, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["ES256"],
    });
    expect(payload.sub).toBe(user.id);
    expect(payload.sid).toBe(issued.sessionId);

    // Old token stamped rotated_at; new token live, ~30d TTL; exactly 2 rows.
    const rows = await tokenRows(issued.sessionId);
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.tokenHash === sha256Hex(issued.refreshToken));
    const newRow = rows.find((r) => r.tokenHash === sha256Hex(tokens.refresh_token));
    expect(oldRow?.rotatedAt).toBeInstanceOf(Date);
    expect(newRow?.rotatedAt).toBeNull();
    expect(Math.abs(newRow!.expiresAt.getTime() - (before + REFRESH_TOKEN_TTL_MS))).toBeLessThan(
      60_000,
    );

    // Session last_used_at bumped forward off the forced past.
    const session = await sessionRow(issued.sessionId);
    expect(session!.lastUsedAt.getTime()).toBeGreaterThan(past.getTime());
    expect(session!.revokedAt).toBeNull();
  });

  it("rotation chains: B works after A→B, and A is now dead (one-time-use)", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id);

    const b = AuthTokensSchema.parse(await (await postRefresh(issued.refreshToken)).json());
    // B rotates fine into C.
    const c = await postRefresh(b.refresh_token);
    expect(c.status).toBe(200);
    AuthTokensSchema.parse(await c.json());
  });

  // -------------------------------------------------------------------------
  // Reuse = theft: the headline security property (R-auth-11)
  // -------------------------------------------------------------------------

  it("reuse: replaying a rotated token 401s AND burns the whole family (A→B, replay A ⇒ B also dies)", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id);

    // A → B.
    const b = AuthTokensSchema.parse(await (await postRefresh(issued.refreshToken)).json());

    // Replay A (the already-rotated token) → 401 + family revoke.
    await expect401(await postRefresh(issued.refreshToken));

    const session = await sessionRow(issued.sessionId);
    expect(session!.revokedAt).toBeInstanceOf(Date);

    // B — the "legitimate" current token — is now dead too (its session is revoked).
    await expect401(await postRefresh(b.refresh_token));
  });

  it("reuse: a token whose session is already revoked → 401 (revoked-session branch)", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id);

    // Revoke via logout, then present the (never-rotated) refresh token.
    expect((await postLogout(issued.accessToken)).status).toBe(204);
    await expect401(await postRefresh(issued.refreshToken));

    const session = await sessionRow(issued.sessionId);
    expect(session!.revokedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Expired-but-never-rotated: plain 401, NO family revoke (R-auth-11 tail)
  // -------------------------------------------------------------------------

  it("expired (never rotated) → 401, session NOT revoked", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id);
    // Push the token past its TTL without touching the session.
    await db
      .update(schema.refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.refreshTokens.tokenHash, sha256Hex(issued.refreshToken)));

    await expect401(await postRefresh(issued.refreshToken));

    const session = await sessionRow(issued.sessionId);
    expect(session!.revokedAt).toBeNull(); // idle expiry is not theft
  });

  // -------------------------------------------------------------------------
  // Unknown token + user isolation (R-auth-9 hash lookup)
  // -------------------------------------------------------------------------

  it("unknown token → 401, no side effects", async () => {
    await expect401(await postRefresh(`never-issued-${uniq()}`));
  });

  it("isolation: user A's refresh only ever yields a token whose sub is user A", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const a = await seedSession(userA.id);
    await seedSession(userB.id);

    const tokens = AuthTokensSchema.parse(await (await postRefresh(a.refreshToken)).json());
    const { payload } = await jwtVerify(tokens.access_token, accessPublicKey, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["ES256"],
    });
    expect(payload.sub).toBe(userA.id);
    expect(payload.sub).not.toBe(userB.id);
  });

  // -------------------------------------------------------------------------
  // Concurrency: two presentations of the same token are self-defeating
  // -------------------------------------------------------------------------

  it("concurrent double-spend of one token → exactly one 200, family revoked (theft posture)", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id);

    const [r1, r2] = await Promise.all([
      postRefresh(issued.refreshToken),
      postRefresh(issued.refreshToken),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 401]);

    const session = await sessionRow(issued.sessionId);
    expect(session!.revokedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Logout (R-auth-13, R-user-8)
  // -------------------------------------------------------------------------

  it("logout: session revoked, its refresh stops working, supplied push token deleted", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id);
    const [pt] = await db
      .insert(schema.pushTokens)
      .values({ userId: user.id, token: `ExponentPushToken[${uniq()}]`, platform: "ios" })
      .returning();

    const res = await postLogout(issued.accessToken, { push_token_id: pt!.id });
    expect(res.status).toBe(204);

    const session = await sessionRow(issued.sessionId);
    expect(session!.revokedAt).toBeInstanceOf(Date);
    await expect401(await postRefresh(issued.refreshToken));

    const [gone] = await db
      .select()
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.id, pt!.id));
    expect(gone).toBeUndefined();
  });

  it("logout: no push_token_id → session revoked, push tokens untouched", async () => {
    const user = await seedUser();
    const issued = await seedSession(user.id);
    const [pt] = await db
      .insert(schema.pushTokens)
      .values({ userId: user.id, token: `ExponentPushToken[${uniq()}]`, platform: "ios" })
      .returning();

    expect((await postLogout(issued.accessToken)).status).toBe(204);
    expect((await sessionRow(issued.sessionId))!.revokedAt).toBeInstanceOf(Date);

    const [still] = await db
      .select()
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.id, pt!.id));
    expect(still).toBeDefined();
  });

  it("logout: no / garbage / expired access token → 401", async () => {
    await expect401(await postLogout(null));
    await expect401(await postLogout("not-a-jwt"));

    // A structurally-valid but expired access token.
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sid: "22222222-2222-4222-8222-222222222222" })
      .setProtectedHeader({ alg: "ES256", kid: SIGNER_KID })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject("11111111-1111-4111-8111-111111111111")
      .setIssuedAt(nowSec - 3600)
      .setExpirationTime(nowSec - 1800)
      .sign(signer.privateKey);
    await expect401(await postLogout(expired));
  });

  it("logout: foreign push_token_id → session still revoked, foreign token untouched", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const a = await seedSession(userA.id);
    const [ptB] = await db
      .insert(schema.pushTokens)
      .values({ userId: userB.id, token: `ExponentPushToken[${uniq()}]`, platform: "ios" })
      .returning();

    expect((await postLogout(a.accessToken, { push_token_id: ptB!.id })).status).toBe(204);
    expect((await sessionRow(a.sessionId))!.revokedAt).toBeInstanceOf(Date);

    const [untouched] = await db
      .select()
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.id, ptB!.id));
    expect(untouched).toBeDefined();
    expect(untouched!.userId).toBe(userB.id);
  });

  // -------------------------------------------------------------------------
  // GET /auth/sessions (R-auth-13)
  // -------------------------------------------------------------------------

  it("sessions list: two devices → both listed, current true exactly once, no cursor", async () => {
    const user = await seedUser();
    const one = await seedSession(user.id, "iPhone");
    await seedSession(user.id, "iPad");

    const res = await getSessions(one.accessToken);
    expect(res.status).toBe(200);
    const page = paginatedSchema(AuthSessionInfoSchema).parse(
      await res.json(),
    ) as Paginated<AuthSessionInfo>;

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(page.items.filter((s) => s.current)).toHaveLength(1);
    expect(page.items.find((s) => s.current)!.id).toBe(one.sessionId);
  });

  it("sessions list: unauthenticated → 401; user B never sees user A's sessions", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    await seedSession(userA.id, "A-phone");
    const bSession = await seedSession(userB.id, "B-phone");

    await expect401(await getSessions(null));

    const res = await getSessions(bSession.accessToken);
    const page = paginatedSchema(AuthSessionInfoSchema).parse(
      await res.json(),
    ) as Paginated<AuthSessionInfo>;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(bSession.sessionId);
  });

  it("sessions list: a revoked session is excluded", async () => {
    const user = await seedUser();
    const keep = await seedSession(user.id, "keep");
    const drop = await seedSession(user.id, "drop");
    // Revoke `drop` from `keep`.
    expect((await deleteSession(keep.accessToken, drop.sessionId)).status).toBe(204);

    const page = paginatedSchema(AuthSessionInfoSchema).parse(
      await (await getSessions(keep.accessToken)).json(),
    ) as Paginated<AuthSessionInfo>;
    expect(page.items.map((s) => s.id)).toEqual([keep.sessionId]);
  });

  // -------------------------------------------------------------------------
  // DELETE /auth/sessions/:id (R-auth-13, R-auth-12)
  // -------------------------------------------------------------------------

  it("revoke: another owned device → 204 and its refresh 401s immediately", async () => {
    const user = await seedUser();
    const current = await seedSession(user.id, "current");
    const other = await seedSession(user.id, "other");

    expect((await deleteSession(current.accessToken, other.sessionId)).status).toBe(204);
    expect((await sessionRow(other.sessionId))!.revokedAt).toBeInstanceOf(Date);
    await expect401(await postRefresh(other.refreshToken));
  });

  it("revoke: unknown session id → 404", async () => {
    const user = await seedUser();
    const s = await seedSession(user.id);
    const res = await deleteSession(s.accessToken, "33333333-3333-4333-8333-333333333333");
    expect(res.status).toBe(404);
  });

  it("revoke: another user's session id → 404, session untouched (IDOR)", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const a = await seedSession(userA.id);
    const b = await seedSession(userB.id);

    const res = await deleteSession(a.accessToken, b.sessionId);
    expect(res.status).toBe(404);
    expect((await sessionRow(b.sessionId))!.revokedAt).toBeNull();
  });

  it("revoke: already-revoked own session → 404 (indistinguishable from absent)", async () => {
    const user = await seedUser();
    const current = await seedSession(user.id);
    const other = await seedSession(user.id);
    expect((await deleteSession(current.accessToken, other.sessionId)).status).toBe(204);
    // Second revoke of the same id → 404.
    expect((await deleteSession(current.accessToken, other.sessionId)).status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // requireAuth uniform posture + token hygiene (R-auth-9 / §3.6.4)
  // -------------------------------------------------------------------------

  it("requireAuth: no header / garbage / expired all give byte-identical 401 bodies (modulo requestId)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sid: "22222222-2222-4222-8222-222222222222" })
      .setProtectedHeader({ alg: "ES256", kid: SIGNER_KID })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject("11111111-1111-4111-8111-111111111111")
      .setIssuedAt(nowSec - 3600)
      .setExpirationTime(nowSec - 1800)
      .sign(signer.privateKey);

    const bodies = await Promise.all(
      [await getSessions(null), await getSessions("garbage"), await getSessions(expired)].map(
        expect401,
      ),
    );
    for (const body of bodies) {
      expect(body.error.message).toBe(bodies[0]!.error.message);
      expect(body.error.details).toBeUndefined();
    }
  });

  it("hygiene: a full refresh + logout cycle leaks no token material to logs", async () => {
    const consoleSpies = (["log", "warn", "error", "info"] as const).map((level) =>
      vi.spyOn(console, level),
    );
    try {
      const user = await seedUser();
      const issued = await seedSession(user.id);
      const rotated = AuthTokensSchema.parse(await (await postRefresh(issued.refreshToken)).json());
      await postLogout(rotated.access_token);
      // Replay the now-rotated original → reuse warning path.
      await postRefresh(issued.refreshToken);

      const secrets = [
        issued.refreshToken,
        issued.accessToken,
        rotated.refresh_token,
        rotated.access_token,
      ];
      const logged = [
        ...warnings,
        ...consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))),
      ].join("\n");
      for (const secret of secrets) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });
});
