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
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
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
import { generateInviteToken } from "../trips/invite-token.js";
import { deleteAccount, OwnerTransferRequiredError } from "./account-deletion.js";
import type { CashtagChecker } from "./cashtag.js";
import type { UsersRouterDeps } from "./routes.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place now: src/test/global-setup.ts (T-S3.3 shared container; the
// `--no-file-parallelism` workaround is retired — QUEUE P1).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
/** AES-256-GCM key the suite encrypts + decrypts stored Apple tokens with. */
const APPLE_CREDENTIALS_KEY = Buffer.alloc(32, 7);

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

describe.skipIf(!dockerAvailable)("T-5.6 account deletion (integration)", () => {
  let suiteDb: SuiteDb;
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
    suiteDb = await createSuiteDb("users_account_deletion");
    db = suiteDb.db;

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
    // Trips deps mount the invites router too (T-6.2) — the deletion-vs-
    // acceptance race tests below exercise BOTH real routes on one app.
    app = createApp({ auth: authDeps, users: usersDeps, trips: { db } });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
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
  const membersOf = (userId: string) =>
    db.select().from(schema.tripMembers).where(eq(schema.tripMembers.userId, userId));

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

  it("owner of a SOLO trip (only member) is NOT blocked — deletes 204 and the trip goes too (no orphans)", async () => {
    const u = await seedUser();
    const tripId = await seedTrip(u.user.id); // owner, no other members
    expect((await deleteMe(u.accessToken)).status).toBe(204);
    expect((await userRow(u.user.id)).deletedAt).not.toBeNull();
    // T-6.1 reconcile: no live member remains, so keeping the trip would
    // orphan it behind the membership gate — it is deleted with cascade.
    expect(await db.select().from(schema.trips).where(eq(schema.trips.id, tripId))).toEqual([]);
    expect(await membersOf(u.user.id)).toEqual([]);
  });

  it("a non-owner member of a shared trip is NOT blocked — deletes 204; owner untouched; trip survives; their expenses survive (R-trips-12)", async () => {
    const owner = await seedUser();
    const viewer = await seedUser();
    const tripId = await seedTrip(owner.user.id);
    await addMember(tripId, viewer.user.id, "viewer");
    // The departing member logged an expense — the ledger must outlive them.
    await db.insert(schema.expenses).values({
      tripId,
      description: "museum tickets",
      category: "activities",
      paidBy: viewer.user.id,
      amountCents: 3_000,
      currency: "USD",
      createdBy: viewer.user.id,
    });

    expect((await deleteMe(viewer.accessToken)).status).toBe(204);
    expect((await userRow(viewer.user.id)).deletedAt).not.toBeNull();
    expect((await userRow(owner.user.id)).deletedAt).toBeNull();

    // T-6.1 reconcile: deletion is the member's final "leave" (§3.2) — the
    // membership row goes, the trip and the financial history stay.
    expect(await membersOf(viewer.user.id)).toEqual([]);
    expect(await db.select().from(schema.trips).where(eq(schema.trips.id, tripId))).toHaveLength(
      1,
    );
    const survivingExpenses = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.tripId, tripId));
    expect(survivingExpenses).toHaveLength(1);
    expect(survivingExpenses[0]?.paidBy).toBe(viewer.user.id); // never reassigned
  });

  // ---------------------------------------------------------------------------
  // Sole-owner-ghost deadlock (P-6/T-6.1 carry-forward, deferred at T-5.6):
  // a soft-deleted co-member's row must never block the owner's own deletion.
  // ---------------------------------------------------------------------------
  it("ghost co-members do NOT block the sole owner's deletion — the T-5.6 deadlock is gone", async () => {
    const owner = await seedUser();
    const ghost = await seedUser();
    const tripId = await seedTrip(owner.user.id);
    await addMember(tripId, ghost.user.id, "editor");

    // Pre-T-6.1, the ghost's membership row survived their account deletion
    // and permanently 409'd the owner (no valid transfer target). Now the
    // ghost's deletion removes their membership...
    expect((await deleteMe(ghost.accessToken)).status).toBe(204);
    expect(await membersOf(ghost.user.id)).toEqual([]);

    // ...so the owner is the only member left and deletes cleanly.
    const res = await deleteMe(owner.accessToken);
    expect(res.status).toBe(204);
    expect((await userRow(owner.user.id)).deletedAt).not.toBeNull();
    expect(await db.select().from(schema.trips).where(eq(schema.trips.id, tripId))).toEqual([]);
  });

  it("belt-and-braces: a PRE-EXISTING ghost membership row (legacy T-5.6 data) does not block either", async () => {
    const owner = await seedUser();
    const ghost = await seedUser();
    const tripId = await seedTrip(owner.user.id);
    await addMember(tripId, ghost.user.id, "viewer");
    // Simulate the legacy state: the co-member is scrubbed but their
    // membership row was never reconciled away (pre-T-6.1 deletions).
    await db
      .update(schema.users)
      .set({ deletedAt: new Date(), googleSub: null, email: `deleted:${ghost.user.id}` })
      .where(eq(schema.users.id, ghost.user.id));

    // The guard counts LIVE members only — the owner deletes, trip cascades.
    expect((await deleteMe(owner.accessToken)).status).toBe(204);
    expect(await db.select().from(schema.trips).where(eq(schema.trips.id, tripId))).toEqual([]);
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
  // T-6.2: `SELECT … FOR UPDATE` on the sole-owner guard (T-6.1 round-1
  // security defer). The guard + reconcile must see ONE membership state —
  // an acceptance committing between guard SELECT and cascade delete must
  // never be destroyed with the trip.
  // ---------------------------------------------------------------------------

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function seedInvite(tripId: string, createdBy: string) {
    const [invite] = await db
      .insert(schema.invites)
      .values({
        tripId,
        token: generateInviteToken(),
        role: "editor",
        createdBy,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning();
    return invite!;
  }

  it("an IN-FLIGHT acceptance blocks the deletion, which then SEES the new member → 409, nothing scrubbed", async () => {
    const owner = await seedUser();
    const tripId = await seedTrip(owner.user.id); // solo owner — guard would pass
    const joiner = await seedUser();

    // Hold open a transaction that mirrors the accept route's critical
    // section (trips/invites-routes.ts): FOR SHARE on the trip's owner
    // membership row, then the membership INSERT — uncommitted. (The fully-
    // real both-routes race is the next test; this one pins the lock
    // semantics deterministically.)
    let releaseTxn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTxn = resolve;
    });
    let locksTaken!: () => void;
    const locksReady = new Promise<void>((resolve) => {
      locksTaken = resolve;
    });
    const txnPromise = db.transaction(async (tx) => {
      await tx
        .select({ userId: schema.tripMembers.userId })
        .from(schema.tripMembers)
        .where(
          and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.role, "owner")),
        )
        .for("share");
      await tx
        .insert(schema.tripMembers)
        .values({ tripId, userId: joiner.user.id, role: "editor" });
      locksTaken();
      await gate;
    });
    await locksReady;

    // Fire the REAL deletion. Its first membership touch is `FOR UPDATE` on
    // the caller's rows → it parks on our FOR SHARE. The wait below is a
    // LOCK wait, not a timing guess: while we hold the transaction open the
    // deletion cannot resolve.
    const outcome = deleteAccount(
      { db, appleCredentialsKey: APPLE_CREDENTIALS_KEY },
      owner.user.id,
      new Date(),
    ).then(
      () => "deleted" as const,
      (error: unknown) => {
        if (error instanceof OwnerTransferRequiredError) return "conflict" as const;
        throw error;
      },
    );

    const during = await Promise.race([outcome, delay(250).then(() => "blocked" as const)]);
    expect(during).toBe("blocked");

    releaseTxn();
    await txnPromise;

    // The deletion resumed AFTER the acceptance committed — the guard read
    // the post-accept state, saw a live co-member, and refused. Without the
    // FOR UPDATE it would have read the pre-accept state, returned
    // "deleted", and cascaded the joiner's trip away.
    expect(await outcome).toBe("conflict");
    expect((await userRow(owner.user.id)).deletedAt).toBeNull();
    expect(await db.select().from(schema.trips).where(eq(schema.trips.id, tripId))).toHaveLength(
      1,
    );
    expect(await membersOf(joiner.user.id)).toHaveLength(1);
  });

  it("an acceptance arriving while the deletion holds its locks lands AFTER the cascade → 404, no member row into a doomed trip", async () => {
    const owner = await seedUser();
    const tripId = await seedTrip(owner.user.id);
    const joiner = await seedUser();
    const invite = await seedInvite(tripId, owner.user.id);

    // Hold a transaction that mirrors account-deletion steps 1 + 1b: lock
    // the owner's membership rows FOR UPDATE, then (on release) delete the
    // owned trip and the memberships — exactly what the reconcile commits.
    let releaseTxn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTxn = resolve;
    });
    let locksTaken!: () => void;
    const locksReady = new Promise<void>((resolve) => {
      locksTaken = resolve;
    });
    const txnPromise = db.transaction(async (tx) => {
      await tx
        .select({ tripId: schema.tripMembers.tripId })
        .from(schema.tripMembers)
        .where(eq(schema.tripMembers.userId, owner.user.id))
        .for("update");
      locksTaken();
      await gate;
      await tx.delete(schema.trips).where(eq(schema.trips.id, tripId));
      await tx.delete(schema.tripMembers).where(eq(schema.tripMembers.userId, owner.user.id));
    });
    await locksReady;

    // The REAL accept route: it must park on its owner-row FOR SHARE (which
    // our FOR UPDATE blocks) instead of inserting into the doomed trip.
    const acceptPromise = Promise.resolve(
      app.request(`/api/invites/${invite.token}/accept`, {
        method: "POST",
        headers: authHeaders(joiner.accessToken),
      }),
    );
    const during = await Promise.race([
      acceptPromise.then(() => "resolved" as const),
      delay(250).then(() => "blocked" as const),
    ]);
    expect(during).toBe("blocked");

    releaseTxn();
    await txnPromise;

    // The accept resumed against the post-delete world: the invite died in
    // the cascade → the indistinguishable 404; the joiner never became a
    // member of a trip that no longer exists.
    const res = await acceptPromise;
    expect(res.status).toBe(404);
    expect(await membersOf(joiner.user.id)).toEqual([]);
  });

  it("a caller mid-scrub cannot mint a ghost membership — accept serializes on the users row and dies 401", async () => {
    const owner = await seedUser();
    const tripId = await seedTrip(owner.user.id);
    const joiner = await seedUser();
    const invite = await seedInvite(tripId, owner.user.id);

    // Hold deletion's step-0 shape open against the JOINER's account: users
    // row FOR UPDATE, then (on release) the scrub — mirroring deleteAccount
    // steps 0 → 4. The joiner's own membership sweep (1b) has nothing to
    // sweep, which is exactly the gap the accept-side liveness lock closes.
    let releaseTxn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTxn = resolve;
    });
    let locksTaken!: () => void;
    const locksReady = new Promise<void>((resolve) => {
      locksTaken = resolve;
    });
    const txnPromise = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, joiner.user.id))
        .for("update");
      locksTaken();
      await gate;
      await tx
        .update(schema.users)
        .set({ deletedAt: new Date(), googleSub: null, email: `deleted:${joiner.user.id}` })
        .where(eq(schema.users.id, joiner.user.id));
    });
    await locksReady;

    // The REAL accept by the being-deleted joiner (their ≤15-min access token
    // is still valid): it must park at its caller-liveness FOR SHARE — which
    // our FOR UPDATE blocks — instead of racing a membership in.
    const acceptPromise = Promise.resolve(
      app.request(`/api/invites/${invite.token}/accept`, {
        method: "POST",
        headers: authHeaders(joiner.accessToken),
      }),
    );
    const during = await Promise.race([
      acceptPromise.then(() => "resolved" as const),
      delay(250).then(() => "blocked" as const),
    ]);
    expect(during).toBe("blocked");

    releaseTxn();
    await txnPromise;

    // The accept resumed against the scrubbed row: deleted_at is set, the
    // liveness re-check missed → 401, and NO membership row exists for the
    // ghost account.
    const res = await acceptPromise;
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
    expect(await membersOf(joiner.user.id)).toEqual([]);
    const [inviteAfter] = await db
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.id, invite.id));
    expect(inviteAfter?.useCount).toBe(0);
  });

  it("a caller mid-scrub cannot mint a ghost-owned trip — POST /trips parks on the users row and dies 401", async () => {
    const victim = await seedUser();

    // Hold deletion's step-0 shape open: users row FOR UPDATE, then the
    // scrub on release — the exact window where a still-valid token used to
    // slip a create through (T-6.2 round-2 advisory #2, the un-closed
    // sibling of the accept door).
    let releaseTxn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTxn = resolve;
    });
    let locksTaken!: () => void;
    const locksReady = new Promise<void>((resolve) => {
      locksTaken = resolve;
    });
    const txnPromise = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, victim.user.id))
        .for("update");
      locksTaken();
      await gate;
      await tx
        .update(schema.users)
        .set({ deletedAt: new Date(), googleSub: null, email: `deleted:${victim.user.id}` })
        .where(eq(schema.users.id, victim.user.id));
    });
    await locksReady;

    // The REAL create route: its first in-txn lock is the caller-liveness
    // FOR SHARE, which our FOR UPDATE blocks — it cannot resolve while the
    // deletion-shaped transaction is open.
    const createPromise = Promise.resolve(
      app.request("/api/trips", {
        method: "POST",
        headers: { ...authHeaders(victim.accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          name: "Ghost trip",
          destination_name: "Nowhere, Atlantis",
          destination_lat: 38.7,
          destination_lng: -9.1,
          start_date: "2026-08-01",
          end_date: "2026-08-05",
        }),
      }),
    );
    const during = await Promise.race([
      createPromise.then(() => "resolved" as const),
      delay(250).then(() => "blocked" as const),
    ]);
    expect(during).toBe("blocked");

    releaseTxn();
    await txnPromise;

    // The create resumed against the scrubbed row: 401, and NO trip or
    // membership row was minted for the ghost account.
    const res = await createPromise;
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
    expect(
      await db.select().from(schema.trips).where(eq(schema.trips.createdBy, victim.user.id)),
    ).toEqual([]);
    expect(await membersOf(victim.user.id)).toEqual([]);
  });

  it("TRUE RACE — real deletion route vs real accept route: a 200 acceptance is NEVER destroyed by the cascade", async () => {
    for (let round = 0; round < 5; round++) {
      const owner = await seedUser();
      const tripId = await seedTrip(owner.user.id);
      const joiner = await seedUser();
      const invite = await seedInvite(tripId, owner.user.id);

      const [delRes, acceptRes] = await Promise.all([
        deleteMe(owner.accessToken),
        app.request(`/api/invites/${invite.token}/accept`, {
          method: "POST",
          headers: authHeaders(joiner.accessToken),
        }),
      ]);

      const tripExists =
        (await db.select().from(schema.trips).where(eq(schema.trips.id, tripId))).length === 1;
      const joinerMemberships = await membersOf(joiner.user.id);

      if (acceptRes.status === 200) {
        // Acceptance won the lock — deletion MUST have seen the member and
        // refused; the joiner's trip is intact. (The forbidden outcome —
        // accept 200 with the trip gone — fails all three asserts.)
        expect(delRes.status).toBe(409);
        expect(tripExists).toBe(true);
        expect(joinerMemberships).toHaveLength(1);
      } else {
        // Deletion won — the invite died with the trip; nobody joined a
        // ghost. The accept converges on the unknown-token 404.
        expect(acceptRes.status).toBe(404);
        expect(delRes.status).toBe(204);
        expect(tripExists).toBe(false);
        expect(joinerMemberships).toEqual([]);
      }
    }
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
