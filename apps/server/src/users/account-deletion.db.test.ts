/**
 * T-5.6 account deletion integration suite (AU-8: R-user-9, schema R-db-16 /
 * §3.3.1 / §3.3.5) — the full `DELETE /users/me` surface end-to-end over a real
 * Postgres, behind the real app-wide `requireAuth`. Headline adversarial
 * assertions: the sole-owner-trip 409 scrubs NOTHING, PII is actually gone from
 * the row, sessions are dead and the profile unreadable after deletion, an
 * Apple-revocation FAILURE still deletes, another user's account is untouched,
 * a repeat deletion is idempotent, and the `users_identity_or_scrubbed_ck`
 * CHECK holds on the scrubbed row.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — same harness
 * contract as `routes.db.test.ts`: a Docker-less CI run is a HARD FAILURE; a
 * local Docker-less run skips with a loud banner. The only network is the local
 * container (Law #5) — the Apple revoker is a fake that records its calls.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TripMemberRole } from "@gogo/shared/enums";
import { createApp } from "../app.js";
import { RATE_LIMITS } from "../config.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { encryptSecret } from "../auth/crypto.js";
import type { AppleTokenRevoker } from "../auth/apple-revoke.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import type { ObjectStorage } from "../storage/object-storage.js";
import type { CashtagChecker } from "./cashtag.js";
import type { UsersRouterDeps } from "./routes.js";

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
    "\n" +
      "╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  DOCKER UNAVAILABLE — T-5.6 ACCOUNT DELETION SUITE SKIPPED         ║\n" +
      "║  DELETE /users/me: soft-delete + PII scrub, sole-owner 409,       ║\n" +
      "║  session/push revoke, Apple token revocation (auth-users spec     ║\n" +
      "║  §3.4.2, R-user-9) were NOT verified. Start Docker and re-run     ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-5.6 account deletion suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-5.6 account deletion suite " +
        "could not verify auth-users spec §3.4.2 (R-user-9). A skip here is NOT " +
        "a pass. Provision Docker or a Postgres service container.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
/** AES-256-GCM key the suite encrypts + decrypts stored Apple tokens with. */
const APPLE_CREDENTIALS_KEY = Buffer.alloc(32, 7);

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

describe.skipIf(!dockerAvailable)("T-5.6 account deletion (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let authDeps: AuthRouterDeps;
  let signer: AccessTokenSigner;

  /** Fake Apple revoker — records the DECRYPTED token; optionally throws. */
  const revokeCalls: string[] = [];
  let revokeThrows = false;
  const appleRevoker: AppleTokenRevoker = {
    revoke(token: string) {
      revokeCalls.push(token);
      return revokeThrows ? Promise.reject(new Error("apple unreachable")) : Promise.resolve();
    },
  };

  /** Inert seams — deletion touches neither storage nor cash.app. */
  const storage: ObjectStorage = {
    createPresignedUpload: () => Promise.resolve({ url: "https://storage.test/x", headers: {} }),
    objectExists: () => Promise.resolve(false),
  };
  const cashtagChecker: CashtagChecker = { check: () => Promise.resolve("ok") };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(60_000)
      .start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(db, { migrationsFolder });

    const signerPair = await generateKeyPair("ES256");
    signer = { privateKey: signerPair.privateKey, kid: SIGNER_KID };
    authDeps = {
      db,
      verifier: {
        appleJwks: createLocalJWKSet({ keys: [] }),
        googleJwks: createLocalJWKSet({ keys: [] }),
        appleAudience: "com.gogo.travel",
        googleAudiences: ["gid.apps.example"],
      },
      signer,
      accessVerify: { publicKey: signerPair.publicKey },
      appleExchange: { exchange: () => Promise.reject(new Error("unused in this suite")) },
      appleCredentialsKey: APPLE_CREDENTIALS_KEY,
      logger: { warn: () => undefined },
    };
    const usersDeps: UsersRouterDeps = {
      db,
      storage,
      cashtagChecker,
      appleRevoker,
      appleCredentialsKey: APPLE_CREDENTIALS_KEY,
      logger: { warn: () => undefined },
    };
    app = createApp({ auth: authDeps, users: usersDeps });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  afterEach(() => {
    revokeCalls.length = 0;
    revokeThrows = false;
  });

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  interface SeededUser {
    user: typeof schema.users.$inferSelect;
    accessToken: string;
    refreshToken: string;
    sessionId: string;
    appleRefreshPlaintext: string | null;
  }

  /** Seed a user (+ entitlements), a live session, and (optionally) an
   *  `apple_credentials` row holding a known, encrypted Apple refresh token. */
  async function seedUser(opts?: { apple?: boolean }): Promise<SeededUser> {
    const { user } = await createUserWithEntitlements(db, {
      email: `del-${uniq()}@example.com`,
      displayName: "Delete Me",
      ...(opts?.apple ? { appleSub: `apple-${uniq()}` } : { googleSub: `google-${uniq()}` }),
    });
    let appleRefreshPlaintext: string | null = null;
    if (opts?.apple) {
      appleRefreshPlaintext = `apple-rt-${uniq()}`;
      await db.insert(schema.appleCredentials).values({
        userId: user.id,
        refreshTokenCiphertext: encryptSecret(APPLE_CREDENTIALS_KEY, appleRefreshPlaintext),
      });
    }
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return {
      user,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      sessionId: issued.sessionId,
      appleRefreshPlaintext,
    };
  }

  async function seedTrip(ownerId: string): Promise<string> {
    const [trip] = await db
      .insert(schema.trips)
      .values({
        name: `Trip ${uniq()}`,
        destinationName: "Lisbon",
        destinationLat: "38.722252",
        destinationLng: "-9.139337",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        createdBy: ownerId,
      })
      .returning({ id: schema.trips.id });
    await addMember(trip!.id, ownerId, "owner");
    return trip!.id;
  }

  async function addMember(tripId: string, userId: string, role: TripMemberRole) {
    await db.insert(schema.tripMembers).values({ tripId, userId, role });
  }

  async function seedPushToken(userId: string): Promise<void> {
    await db
      .insert(schema.pushTokens)
      .values({ userId, token: `ExponentPushToken[${uniq()}]`, platform: "ios" });
  }

  const authHeaders = (token: string | null): Record<string, string> =>
    token ? { authorization: `Bearer ${token}` } : {};

  const deleteMe = (token: string | null) =>
    app.request("/api/users/me", { method: "DELETE", headers: authHeaders(token) });

  const getMe = (token: string) => app.request("/api/users/me", { headers: authHeaders(token) });

  const refresh = (refreshToken: string) =>
    app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

  const userRow = async (id: string) =>
    (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0]!;
  const sessionsOf = (userId: string) =>
    db.select().from(schema.authSessions).where(eq(schema.authSessions.userId, userId));
  const pushOf = (userId: string) =>
    db.select().from(schema.pushTokens).where(eq(schema.pushTokens.userId, userId));
  const credsOf = (userId: string) =>
    db.select().from(schema.appleCredentials).where(eq(schema.appleCredentials.userId, userId));

  // ---------------------------------------------------------------------------
  // Happy path — all fixed effects fire; PII actually gone (R-user-9).
  // ---------------------------------------------------------------------------
  it("apple user: soft-deletes + scrubs PII, revokes sessions/push, revokes the Apple token", async () => {
    const u = await seedUser({ apple: true });
    await seedPushToken(u.user.id);
    // Give the row a full PII load so the scrub has something to erase.
    await db
      .update(schema.users)
      .set({
        avatarKey: "avatars/x/y.png",
        venmoUsername: "sean-t",
        cashtag: "seant",
        paypalmeUsername: "seanpay",
        zelleHandle: "sean@example.com",
        zelleDisplayName: "Sean T",
        forwardEmailSlug: `slug-${uniq()}`,
        prefs: { units: "metric", home_currency: "USD" },
      })
      .where(eq(schema.users.id, u.user.id));

    const res = await deleteMe(u.accessToken);
    expect(res.status).toBe(204);

    // Apple revocation was called with the DECRYPTED stored refresh token.
    expect(revokeCalls).toEqual([u.appleRefreshPlaintext]);

    // Soft-delete + full PII scrub (schema §3.3.1 scrub list).
    const row = await userRow(u.user.id);
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toBe(`deleted:${u.user.id}`);
    expect(row.displayName).toBe("Deleted user");
    expect(row.appleSub).toBeNull();
    expect(row.googleSub).toBeNull();
    expect(row.avatarKey).toBeNull();
    expect(row.venmoUsername).toBeNull();
    expect(row.cashtag).toBeNull();
    expect(row.paypalmeUsername).toBeNull();
    expect(row.zelleHandle).toBeNull();
    expect(row.zelleDisplayName).toBeNull();
    expect(row.forwardEmailSlug).toBeNull();
    expect(row.prefs).toEqual({});

    // Sessions revoked, push tokens deleted, apple_credentials consumed.
    expect((await sessionsOf(u.user.id)).every((s) => s.revokedAt !== null)).toBe(true);
    expect(await pushOf(u.user.id)).toHaveLength(0);
    expect(await credsOf(u.user.id)).toHaveLength(0);

    // Entitlements row survives (soft delete, not a cascade).
    const ent = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, u.user.id));
    expect(ent).toHaveLength(1);
  });

  it("after deletion the refresh token is dead and the scrubbed profile is unreadable", async () => {
    const u = await seedUser();
    expect((await deleteMe(u.accessToken)).status).toBe(204);
    // Session revoked → refresh 401s (no token survives, R-user-9).
    expect((await refresh(u.refreshToken)).status).toBe(401);
    // The still-valid (≤15 min, R-auth-12) access token can't read a scrubbed
    // row → 404 (ownUserRow filters deleted_at). Bounded latency, accepted.
    expect((await getMe(u.accessToken)).status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Multi-device: revoke ALL sessions + delete ALL push tokens (R-user-9). The
  // impl scopes by userId, not the caller's sid — a regression narrowing it to
  // the current session (leaving another device logged in) must fail here. Also
  // proves device_name is erased on the revoked rows (deletion-time PII scrub).
  // ---------------------------------------------------------------------------
  it("revokes BOTH sessions + deletes BOTH push tokens across two devices, erasing device_name", async () => {
    const u = await seedUser();
    // Give device #1 (seeded session) a client-supplied name so the erasure is
    // observable; add a SECOND device with its own session + refresh token.
    await db
      .update(schema.authSessions)
      .set({ deviceName: "iPhone 17" })
      .where(eq(schema.authSessions.id, u.sessionId));
    const second = await createSessionWithTokens(db, {
      userId: u.user.id,
      device: { deviceName: "iPad Pro", platform: "ios" },
      signer,
    });
    await seedPushToken(u.user.id);
    await seedPushToken(u.user.id);

    // Precondition: genuinely two sessions + two push tokens before deletion.
    expect(await sessionsOf(u.user.id)).toHaveLength(2);
    expect(await pushOf(u.user.id)).toHaveLength(2);

    expect((await deleteMe(u.accessToken)).status).toBe(204);

    // BOTH sessions revoked (not just the caller's) AND device_name nulled.
    const sessions = await sessionsOf(u.user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(sessions.every((s) => s.deviceName === null)).toBe(true);

    // BOTH refresh tokens are dead — neither device can rotate a new token.
    expect((await refresh(u.refreshToken)).status).toBe(401);
    expect((await refresh(second.refreshToken)).status).toBe(401);

    // ALL push tokens gone, not just one device's.
    expect(await pushOf(u.user.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Sole-owner-trip guard (R-user-9 / schema §3.3.5) — the 409 scrubs NOTHING.
  // ---------------------------------------------------------------------------
  it("sole owner of a trip with other members → 409, and nothing is revoked or scrubbed", async () => {
    const owner = await seedUser({ apple: true });
    const member = await seedUser();
    const tripId = await seedTrip(owner.user.id);
    await addMember(tripId, member.user.id, "editor");
    await seedPushToken(owner.user.id);

    const res = await deleteMe(owner.accessToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details).toEqual({ reason: "owner_transfer_required" });

    // The whole transaction rolled back — account fully intact.
    const row = await userRow(owner.user.id);
    expect(row.deletedAt).toBeNull();
    expect(row.email).toBe(owner.user.email);
    expect(row.appleSub).toBe(owner.user.appleSub);
    expect((await sessionsOf(owner.user.id)).every((s) => s.revokedAt === null)).toBe(true);
    expect(await pushOf(owner.user.id)).toHaveLength(1);
    expect(await credsOf(owner.user.id)).toHaveLength(1);
    expect(revokeCalls).toEqual([]); // Apple never touched on a blocked delete
  });

  it("owner of a SOLO trip (only member) is NOT blocked — deletes 204", async () => {
    const u = await seedUser();
    await seedTrip(u.user.id); // owner, no other members
    expect((await deleteMe(u.accessToken)).status).toBe(204);
    expect((await userRow(u.user.id)).deletedAt).not.toBeNull();
  });

  it("a non-owner member of a shared trip is NOT blocked — deletes 204; owner untouched", async () => {
    const owner = await seedUser();
    const viewer = await seedUser();
    const tripId = await seedTrip(owner.user.id);
    await addMember(tripId, viewer.user.id, "viewer");

    expect((await deleteMe(viewer.accessToken)).status).toBe(204);
    expect((await userRow(viewer.user.id)).deletedAt).not.toBeNull();
    expect((await userRow(owner.user.id)).deletedAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Apple revocation failure must NOT roll back the deletion (R-user-9).
  // ---------------------------------------------------------------------------
  it("Apple revocation failure is swallowed — the deletion still commits", async () => {
    const u = await seedUser({ apple: true });
    revokeThrows = true;

    const res = await deleteMe(u.accessToken);
    expect(res.status).toBe(204);
    expect(revokeCalls).toEqual([u.appleRefreshPlaintext]); // it WAS attempted

    const row = await userRow(u.user.id);
    expect(row.deletedAt).not.toBeNull();
    expect(row.appleSub).toBeNull();
    // The credential is consumed even when the network revoke failed.
    expect(await credsOf(u.user.id)).toHaveLength(0);
  });

  it("google-only account: no apple_credentials → revoker never called, still deletes", async () => {
    const u = await seedUser();
    expect((await deleteMe(u.accessToken)).status).toBe(204);
    expect(revokeCalls).toEqual([]);
    expect((await userRow(u.user.id)).deletedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Self-scoped: deletes exactly the token's `sub`, never another principal.
  // ---------------------------------------------------------------------------
  it("deletes exactly the caller — a second user's account is untouched", async () => {
    const a = await seedUser();
    const b = await seedUser();
    expect((await deleteMe(a.accessToken)).status).toBe(204);

    const rowB = await userRow(b.user.id);
    expect(rowB.deletedAt).toBeNull();
    expect((await sessionsOf(b.user.id)).every((s) => s.revokedAt === null)).toBe(true);
  });

  it("re-deleting an already-scrubbed account is an idempotent 204 (no 409, no re-scrub)", async () => {
    const u = await seedUser({ apple: true });
    expect((await deleteMe(u.accessToken)).status).toBe(204);
    const firstDeletedAt = (await userRow(u.user.id)).deletedAt;
    revokeCalls.length = 0;

    // Second delete rides the still-valid access token → live row absent → no-op.
    expect((await deleteMe(u.accessToken)).status).toBe(204);
    expect(revokeCalls).toEqual([]); // no credential left to revoke
    expect((await userRow(u.user.id)).deletedAt!.getTime()).toBe(firstDeletedAt!.getTime());
  });

  it("unauthenticated → 401 (app-wide requireAuth, no handler execution)", async () => {
    const res = await deleteMe(null);
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
  });

  // ---------------------------------------------------------------------------
  // The scrubbed row still satisfies users_identity_or_scrubbed_ck.
  // ---------------------------------------------------------------------------
  it("scrubbed row satisfies users_identity_or_scrubbed_ck (subs null ⇒ deleted_at set)", async () => {
    const u = await seedUser();
    expect((await deleteMe(u.accessToken)).status).toBe(204);
    const row = await userRow(u.user.id);
    expect(row.appleSub).toBeNull();
    expect(row.googleSub).toBeNull();
    expect(row.deletedAt).not.toBeNull();

    // Clearing deleted_at on a sub-less row MUST violate the CHECK — proof the
    // scrub's deleted_at is what keeps the invariant intact (schema §3.3.1).
    await expect(
      db.update(schema.users).set({ deletedAt: null }).where(eq(schema.users.id, u.user.id)),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Rate limit (§3.6.3): DELETE /users/me caps at 3/day per user.
  // ---------------------------------------------------------------------------
  it("caps at 3/day per user with Retry-After (the limiter runs on every request)", async () => {
    let nowMs = 1_800_000_000_000;
    const limited = createApp({
      auth: authDeps,
      users: {
        db,
        storage,
        cashtagChecker,
        appleRevoker,
        appleCredentialsKey: APPLE_CREDENTIALS_KEY,
        rateLimit: { store: new InMemoryRateLimitStore(), now: () => nowMs },
      },
    });
    const u = await seedUser();
    const del = (token: string) =>
      limited.request("/api/users/me", { method: "DELETE", headers: authHeaders(token) });

    // First is a real delete; the next two are idempotent 204s — all three are
    // charged, then the 4th trips the window.
    for (let i = 0; i < RATE_LIMITS.deleteAccount.limit; i++) {
      expect((await del(u.accessToken)).status).toBe(204);
    }
    const blocked = await del(u.accessToken);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as Envelope).error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Window rollover clears the block (day window on the same clock).
    nowMs += RATE_LIMITS.deleteAccount.windowMs + 1;
    expect((await del(u.accessToken)).status).toBe(204);
  });
});
