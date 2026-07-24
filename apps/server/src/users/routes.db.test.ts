/**
 * T-5.5 users & entitlements integration suite (AU-6 + AU-7): the full
 * profile / avatar / payment-handles / push-token / member-profile /
 * entitlements surface end-to-end over a real Postgres, behind the real
 * app-wide `requireAuth`. Headline adversarial assertions: cross-user
 * avatar-key commits rejected without probing storage, the merged-row zelle
 * invariant, foreign push tokens MOVING on re-registration, the
 * shared-trip-gated profile 404 that is byte-identical for "no such user"
 * and "no shared trip" (R-user-4 IDOR posture), and zero Venmo traffic.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — same harness
 * contract as `tokens-routes.db.test.ts`: a Docker-less CI run is a HARD
 * FAILURE; a local Docker-less run skips with a loud banner. The only
 * network is the local container (Law #5) — storage and cash.app are fakes.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AvatarUploadTicketSchema,
  PaymentHandlesSchema,
  PushTokenSchema,
  UserProfileSchema,
  UserSchema,
  AVATAR_MAX_BYTES,
} from "@gogo/shared/domains/user";
import { EffectiveEntitlementsSchema } from "@gogo/shared/domains/entitlement";
import type { TripMemberRole } from "@gogo/shared/enums";
import { createApp } from "../app.js";
import { AVATAR_TICKET_TTL_SECONDS, RATE_LIMITS } from "../config.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import type { ObjectStorage } from "../storage/object-storage.js";
import type { CashtagChecker, CashtagCheckResult } from "./cashtag.js";
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
      "║  DOCKER UNAVAILABLE — T-5.5 USERS/ENTITLEMENTS SUITE SKIPPED      ║\n" +
      "║  Profile, avatar commit, payment handles, push tokens, member     ║\n" +
      "║  profiles, and entitlements (auth-users spec §3.4.2/§3.4.3,       ║\n" +
      "║  R-user-1..8, R-ent-1/3) were NOT verified. Start Docker and      ║\n" +
      "║  re-run `pnpm --filter @gogo/server test` before treating this    ║\n" +
      "║  green.                                                           ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-5.5 users suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-5.5 users/entitlements " +
        "suite could not verify auth-users spec §3.4.2/§3.4.3 (R-user-1..8, " +
        "R-ent-1/3). A skip here is NOT a pass. Provision Docker or a " +
        "Postgres service container.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

/** Fake §3.7 port: records presigns/probes; "uploads" are set-membership. */
class FakeObjectStorage implements ObjectStorage {
  readonly presignCalls: Array<{
    key: string;
    contentType: string;
    byteSize: number;
    ttlSeconds: number;
  }> = [];
  readonly existsCalls: string[] = [];
  readonly objects = new Set<string>();

  createPresignedUpload(key: string, contentType: string, byteSize: number, ttlSeconds: number) {
    this.presignCalls.push({ key, contentType, byteSize, ttlSeconds });
    return Promise.resolve({
      url: `https://storage.test/upload/${encodeURIComponent(key)}`,
      headers: { "content-type": contentType },
    });
  }

  objectExists(key: string): Promise<boolean> {
    this.existsCalls.push(key);
    return Promise.resolve(this.objects.has(key));
  }
}

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/** Identical-404 comparisons ignore only the per-request correlation id. */
function withoutRequestId(body: Envelope): Omit<Envelope["error"], "requestId"> {
  const { requestId: _omit, ...rest } = body.error;
  return rest;
}

describe.skipIf(!dockerAvailable)("T-5.5 users & entitlements routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let authDeps: AuthRouterDeps;
  let signer: AccessTokenSigner;
  let storage: FakeObjectStorage;

  /** Mutable clock for the users router (push-token keep-alive bumps). */
  let frozenNow: Date | undefined;

  /** Scripted cashtag checker — every call recorded (R-user-7 evidence). */
  const cashtagCalls: string[] = [];
  let cashtagVerdict: CashtagCheckResult = "ok";
  let cashtagThrows = false;
  const cashtagChecker: CashtagChecker = {
    check(tag: string) {
      cashtagCalls.push(tag);
      if (cashtagThrows) return Promise.reject(new Error("cash.app unreachable"));
      return Promise.resolve(cashtagVerdict);
    },
  };

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
      appleCredentialsKey: Buffer.alloc(32, 7),
      logger: { warn: () => undefined },
    };
    storage = new FakeObjectStorage();
    const usersDeps: UsersRouterDeps = {
      db,
      storage,
      cashtagChecker,
      now: () => frozenNow ?? new Date(),
    };
    app = createApp({ auth: authDeps, users: usersDeps });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  afterEach(() => {
    frozenNow = undefined;
    cashtagVerdict = "ok";
    cashtagThrows = false;
    cashtagCalls.length = 0;
  });

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  async function seedUser() {
    const { user } = await createUserWithEntitlements(db, {
      email: `usr-${uniq()}@example.com`,
      displayName: "Profile Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { user, accessToken: issued.accessToken };
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

  const authHeaders = (token: string | null, json = false): Record<string, string> => ({
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(json ? { "content-type": "application/json" } : {}),
  });

  const getMe = (token: string | null) =>
    app.request("/api/users/me", { headers: authHeaders(token) });

  const patchMe = (token: string | null, body: unknown) =>
    app.request("/api/users/me", {
      method: "PATCH",
      headers: authHeaders(token, true),
      body: JSON.stringify(body),
    });

  const postAvatarUpload = (token: string | null, body: unknown) =>
    app.request("/api/users/me/avatar-upload", {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify(body),
    });

  const patchHandles = (token: string | null, body: unknown) =>
    app.request("/api/users/me/payment-handles", {
      method: "PATCH",
      headers: authHeaders(token, true),
      body: JSON.stringify(body),
    });

  const getEntitlements = (token: string | null) =>
    app.request("/api/users/me/entitlements", { headers: authHeaders(token) });

  const postPushToken = (token: string | null, body: unknown) =>
    app.request("/api/users/me/push-tokens", {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify(body),
    });

  const deletePushToken = (token: string | null, pushTokenId: string) =>
    app.request(`/api/users/me/push-tokens/${pushTokenId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

  const getProfile = (token: string | null, userId: string) =>
    app.request(`/api/users/${userId}`, { headers: authHeaders(token) });

  /** Issue a ticket AND simulate the client's PUT (object lands in storage). */
  async function issueUploadedAvatarKey(token: string): Promise<string> {
    const res = await postAvatarUpload(token, { content_type: "image/png", byte_size: 1024 });
    expect(res.status).toBe(200);
    const ticket = AvatarUploadTicketSchema.parse(await res.json());
    storage.objects.add(ticket.storage_key);
    return ticket.storage_key;
  }

  // -------------------------------------------------------------------------
  // requireAuth coverage (R-authz-1): the entire surface is Auth: Required.
  // -------------------------------------------------------------------------
  describe("authentication (R-authz-1)", () => {
    it("every users/entitlements route is 401 without a token", async () => {
      const anyUuid = randomUUID();
      const attempts = [
        getMe(null),
        patchMe(null, { display_name: "X" }),
        postAvatarUpload(null, { content_type: "image/png", byte_size: 1 }),
        patchHandles(null, { venmo_username: "x" }),
        getEntitlements(null),
        postPushToken(null, { token: "ExponentPushToken[x]", platform: "ios" }),
        deletePushToken(null, anyUuid),
        getProfile(null, anyUuid),
      ];
      for (const attempt of attempts) {
        const res = await attempt;
        expect(res.status).toBe(401);
        const body = (await res.json()) as Envelope;
        expect(body.error.code).toBe("UNAUTHENTICATED");
      }
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/me (R-user-1)
  // -------------------------------------------------------------------------
  describe("GET /users/me (R-user-1)", () => {
    it("returns the caller's full User shape incl. handles + prefs", async () => {
      const { user, accessToken } = await seedUser();
      await db
        .update(schema.users)
        .set({
          venmoUsername: "sean-t",
          cashtag: "seant",
          prefs: { units: "metric", home_currency: "USD" },
        })
        .where(eq(schema.users.id, user.id));

      const res = await getMe(accessToken);
      expect(res.status).toBe(200);
      const body = UserSchema.parse(await res.json());
      expect(body.id).toBe(user.id);
      expect(body.email).toBe(user.email);
      expect(body.venmo_username).toBe("sean-t");
      expect(body.cashtag).toBe("seant");
      expect(body.prefs).toEqual({ units: "metric", home_currency: "USD" });
      expect(body.forward_email_slug).toBeNull();
    });

    it("is always the token's sub — two users each see exactly themselves", async () => {
      const a = await seedUser();
      const b = await seedUser();
      const resA = await getMe(a.accessToken);
      const resB = await getMe(b.accessToken);
      expect(UserSchema.parse(await resA.json()).id).toBe(a.user.id);
      expect(UserSchema.parse(await resB.json()).id).toBe(b.user.id);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /users/me (R-user-2/3)
  // -------------------------------------------------------------------------
  describe("PATCH /users/me (R-user-2/3)", () => {
    it("round-trips display_name + whole-object prefs; unknown prefs keys stripped", async () => {
      const { user, accessToken } = await seedUser();
      const res = await patchMe(accessToken, {
        display_name: "  Sean  ",
        prefs: { units: "imperial", travel_style: ["foodie"], favorite_color: "teal" },
      });
      expect(res.status).toBe(200);
      const body = UserSchema.parse(await res.json());
      expect(body.display_name).toBe("Sean");
      expect(body.prefs).toEqual({ units: "imperial", travel_style: ["foodie"] });

      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(row!.prefs).toEqual({ units: "imperial", travel_style: ["foodie"] });
    });

    it("prefs is a whole-object REPLACE, not a merge", async () => {
      const { accessToken } = await seedUser();
      await patchMe(accessToken, { prefs: { units: "metric", home_currency: "JPY" } });
      const res = await patchMe(accessToken, { prefs: { units: "imperial" } });
      const body = UserSchema.parse(await res.json());
      expect(body.prefs).toEqual({ units: "imperial" }); // home_currency gone
    });

    it("commits a server-issued avatar_key; null clears it", async () => {
      const { user, accessToken } = await seedUser();
      const key = await issueUploadedAvatarKey(accessToken);

      const commit = await patchMe(accessToken, { avatar_key: key });
      expect(commit.status).toBe(200);
      expect(UserSchema.parse(await commit.json()).avatar_key).toBe(key);

      const clear = await patchMe(accessToken, { avatar_key: null });
      expect(clear.status).toBe(200);
      expect(UserSchema.parse(await clear.json()).avatar_key).toBeNull();

      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(row!.avatarKey).toBeNull();
    });

    it("rejects a never-issued key, a ticket with no uploaded object, and junk — uniform 400", async () => {
      const { accessToken } = await seedUser();
      // Ticket issued but object never uploaded:
      const ticketRes = await postAvatarUpload(accessToken, {
        content_type: "image/png",
        byte_size: 10,
      });
      const unUploaded = AvatarUploadTicketSchema.parse(await ticketRes.json()).storage_key;

      const rejected = [
        unUploaded,
        `avatars/${randomUUID()}/${randomUUID()}`, // fabricated namespace
        "avatars/../etc/passwd",
        "not-a-key",
      ];
      for (const avatar_key of rejected) {
        const res = await patchMe(accessToken, { avatar_key });
        expect(res.status).toBe(400);
        expect(((await res.json()) as Envelope).error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("rejects another user's uploaded key WITHOUT probing storage for it", async () => {
      const a = await seedUser();
      const b = await seedUser();
      const bKey = await issueUploadedAvatarKey(b.accessToken);

      storage.existsCalls.length = 0;
      const res = await patchMe(a.accessToken, { avatar_key: bKey });
      expect(res.status).toBe(400);
      expect(storage.existsCalls).not.toContain(bKey); // namespace check short-circuits

      // B's own commit still works — the key itself is valid.
      const own = await patchMe(b.accessToken, { avatar_key: bKey });
      expect(own.status).toBe(200);
    });

    it("strips non-writable fields — email/subs/slug are never persisted", async () => {
      const { user, accessToken } = await seedUser();
      const res = await patchMe(accessToken, {
        display_name: "Legit",
        email: "evil@example.com",
        apple_sub: "attacker-sub",
        forward_email_slug: "hijack",
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(row!.email).toBe(user.email);
      expect(row!.appleSub).toBeNull();
      expect(row!.forwardEmailSlug).toBeNull();
      expect(row!.displayName).toBe("Legit");
    });

    it("rejects control-character and oversized display names", async () => {
      const { accessToken } = await seedUser();
      for (const display_name of ["a\u0000b", "a\u0007b", "x".repeat(51), ""]) {
        const res = await patchMe(accessToken, { display_name });
        expect(res.status).toBe(400);
      }
    });

    it("an empty patch is a no-op returning the current profile", async () => {
      const { user, accessToken } = await seedUser();
      const res = await patchMe(accessToken, {});
      expect(res.status).toBe(200);
      expect(UserSchema.parse(await res.json()).id).toBe(user.id);
    });

    it("cannot mutate another user — no parameterization exists", async () => {
      const a = await seedUser();
      const b = await seedUser();
      await patchMe(a.accessToken, { display_name: "A Renamed" });
      const [rowB] = await db.select().from(schema.users).where(eq(schema.users.id, b.user.id));
      expect(rowB!.displayName).toBe("Profile Tester");
    });
  });

  // -------------------------------------------------------------------------
  // POST /users/me/avatar-upload (R-user-3)
  // -------------------------------------------------------------------------
  describe("POST /users/me/avatar-upload (R-user-3)", () => {
    it("issues a ticket: caller-namespaced key, PUT, TTL ≤ 10 min, port receives the request", async () => {
      const { user, accessToken } = await seedUser();
      const before = Date.now();
      const res = await postAvatarUpload(accessToken, {
        content_type: "image/webp",
        byte_size: 2048,
      });
      expect(res.status).toBe(200);
      const ticket = AvatarUploadTicketSchema.parse(await res.json());

      expect(ticket.method).toBe("PUT");
      expect(ticket.storage_key.startsWith(`avatars/${user.id}/`)).toBe(true);
      const ttlMs = new Date(ticket.expires_at).getTime() - before;
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(AVATAR_TICKET_TTL_SECONDS * 1000 + 5_000);

      const call = storage.presignCalls.at(-1)!;
      expect(call).toEqual({
        key: ticket.storage_key,
        contentType: "image/webp",
        byteSize: 2048,
        ttlSeconds: AVATAR_TICKET_TTL_SECONDS,
      });
    });

    it("image/gif → 400; oversize → 413 with max_bytes detail", async () => {
      const { accessToken } = await seedUser();
      const gif = await postAvatarUpload(accessToken, {
        content_type: "image/gif",
        byte_size: 10,
      });
      expect(gif.status).toBe(400);

      const big = await postAvatarUpload(accessToken, {
        content_type: "image/jpeg",
        byte_size: 6 * 1024 * 1024,
      });
      expect(big.status).toBe(413);
      const body = (await big.json()) as Envelope;
      expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
      expect(body.error.details).toEqual({ max_bytes: AVATAR_MAX_BYTES });
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /users/me/payment-handles (R-user-5/6/7)
  // -------------------------------------------------------------------------
  describe("PATCH /users/me/payment-handles (R-user-5/6/7)", () => {
    it("sets all four rails (+ zelle display name); @/$ prefixes stripped in stored + returned", async () => {
      const { user, accessToken } = await seedUser();
      const res = await patchHandles(accessToken, {
        venmo_username: "@sean-t",
        cashtag: "$seant",
        paypalme_username: "seantpay",
        zelle_handle: "sean@example.com",
        zelle_display_name: "Sean T",
      });
      expect(res.status).toBe(200);
      const body = PaymentHandlesSchema.parse(await res.json());
      expect(body).toEqual({
        venmo_username: "sean-t",
        cashtag: "seant",
        paypalme_username: "seantpay",
        zelle_handle: "sean@example.com",
        zelle_display_name: "Sean T",
      });
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(row!.venmoUsername).toBe("sean-t");
      expect(row!.cashtag).toBe("seant");
      // The checker saw the NORMALIZED tag ($ stripped before the HEAD).
      expect(cashtagCalls).toEqual(["seant"]);
    });

    it("null clears a handle; absent fields untouched", async () => {
      const { accessToken } = await seedUser();
      await patchHandles(accessToken, { venmo_username: "keepme", paypalme_username: "dropme" });
      const res = await patchHandles(accessToken, { paypalme_username: null });
      const body = PaymentHandlesSchema.parse(await res.json());
      expect(body.paypalme_username).toBeNull();
      expect(body.venmo_username).toBe("keepme");
    });

    it("cashtag HEAD 404 → 400 with details.cashtag = 'not_found'; nothing persisted", async () => {
      const { user, accessToken } = await seedUser();
      cashtagVerdict = "not_found";
      const res = await patchHandles(accessToken, { cashtag: "$ghost", venmo_username: "vx" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(body.error.details).toEqual({ cashtag: "not_found" });
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
      expect(row!.cashtag).toBeNull();
      expect(row!.venmoUsername).toBeNull(); // the whole save was rejected
    });

    it("checker failure → save succeeds (fail-open, R-user-6)", async () => {
      const { accessToken } = await seedUser();
      cashtagThrows = true;
      const res = await patchHandles(accessToken, { cashtag: "$resilient" });
      expect(res.status).toBe(200);
      expect(PaymentHandlesSchema.parse(await res.json()).cashtag).toBe("resilient");
    });

    it("clearing a cashtag (null) makes NO outbound check", async () => {
      const { accessToken } = await seedUser();
      await patchHandles(accessToken, { cashtag: "$real" });
      cashtagCalls.length = 0;
      const res = await patchHandles(accessToken, { cashtag: null });
      expect(res.status).toBe(200);
      expect(cashtagCalls).toEqual([]);
    });

    it("venmo-only saves trigger ZERO outbound validation (R-user-7)", async () => {
      const { accessToken } = await seedUser();
      const res = await patchHandles(accessToken, { venmo_username: "@no-scrape" });
      expect(res.status).toBe(200);
      expect(cashtagCalls).toEqual([]); // the checker port is the only outbound seam
    });

    it("zelle_handle without display name in the payload → 400", async () => {
      const { accessToken } = await seedUser();
      const res = await patchHandles(accessToken, { zelle_handle: "sean@example.com" });
      expect(res.status).toBe(400);
    });

    it("merged-row guard: clearing only the display name strands the stored handle → 400", async () => {
      const { accessToken } = await seedUser();
      await patchHandles(accessToken, {
        zelle_handle: "sean@example.com",
        zelle_display_name: "Sean T",
      });
      const res = await patchHandles(accessToken, { zelle_display_name: null });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.error.details).toEqual({ zelle_display_name: "required" });

      // Clearing BOTH is fine.
      const both = await patchHandles(accessToken, {
        zelle_handle: null,
        zelle_display_name: null,
      });
      expect(both.status).toBe(200);
      const cleared = PaymentHandlesSchema.parse(await both.json());
      expect(cleared.zelle_handle).toBeNull();
      expect(cleared.zelle_display_name).toBeNull();
    });

    it("zelle handles that are neither email nor E.164 → 400", async () => {
      const { accessToken } = await seedUser();
      const res = await patchHandles(accessToken, {
        zelle_handle: "415-555-0123",
        zelle_display_name: "Sean T",
      });
      expect(res.status).toBe(400);
    });

    it("writes only the caller's own row", async () => {
      const a = await seedUser();
      const b = await seedUser();
      await patchHandles(a.accessToken, { venmo_username: "a-only" });
      const [rowB] = await db.select().from(schema.users).where(eq(schema.users.id, b.user.id));
      expect(rowB!.venmoUsername).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/:userId (R-user-4)
  // -------------------------------------------------------------------------
  describe("GET /users/:userId (R-user-4)", () => {
    it("co-member of a trip sees the UserProfile (handles, never email/prefs)", async () => {
      const a = await seedUser();
      const b = await seedUser();
      await patchHandles(b.accessToken, { venmo_username: "b-pay" });
      const tripId = await seedTrip(a.user.id);
      await addMember(tripId, b.user.id, "viewer");

      const res = await getProfile(a.accessToken, b.user.id);
      expect(res.status).toBe(200);
      const raw = (await res.json()) as Record<string, unknown>;
      const profile = UserProfileSchema.parse(raw);
      expect(profile.id).toBe(b.user.id);
      expect(profile.venmo_username).toBe("b-pay");
      expect(raw).not.toHaveProperty("email");
      expect(raw).not.toHaveProperty("prefs");
      expect(raw).not.toHaveProperty("forward_email_slug");
    });

    it("nonexistent user and no-shared-trip user produce byte-identical 404s", async () => {
      const a = await seedUser();
      const stranger = await seedUser(); // real user, zero shared trips
      await seedTrip(a.user.id); // caller has a trip; stranger is not on it

      const unknown = await getProfile(a.accessToken, randomUUID());
      const noShared = await getProfile(a.accessToken, stranger.user.id);
      expect(unknown.status).toBe(404);
      expect(noShared.status).toBe(404);
      expect(withoutRequestId((await unknown.json()) as Envelope)).toEqual(
        withoutRequestId((await noShared.json()) as Envelope),
      );
    });

    it("a soft-deleted co-member is 404 (scrub posture)", async () => {
      const a = await seedUser();
      const b = await seedUser();
      const tripId = await seedTrip(a.user.id);
      await addMember(tripId, b.user.id, "editor");
      await db
        .update(schema.users)
        .set({ deletedAt: new Date() })
        .where(eq(schema.users.id, b.user.id));

      const res = await getProfile(a.accessToken, b.user.id);
      expect(res.status).toBe(404);
    });

    it("a non-uuid :userId fails validation with 400 (never reaches the query)", async () => {
      const { accessToken } = await seedUser();
      const res = await getProfile(accessToken, "not-a-uuid");
      expect(res.status).toBe(400);
    });

    it("/users/me always resolves to the caller's own route, never the :userId param", async () => {
      const { user, accessToken } = await seedUser(); // no trips at all
      const me = await getMe(accessToken);
      expect(me.status).toBe(200); // full User — not the profile route's 404
      expect(UserSchema.parse(await me.json()).id).toBe(user.id);
    });
  });

  // -------------------------------------------------------------------------
  // Push tokens (R-user-8)
  // -------------------------------------------------------------------------
  describe("push tokens (R-user-8)", () => {
    const expoToken = () => `ExponentPushToken[${uniq()}]`;

    it("registers a token under the caller; re-registration returns the same id with last_seen_at bumped", async () => {
      const { user, accessToken } = await seedUser();
      const token = expoToken();

      frozenNow = new Date("2026-07-24T10:00:00Z");
      const first = await postPushToken(accessToken, { token, platform: "ios" });
      expect(first.status).toBe(200);
      const created = PushTokenSchema.parse(await first.json());
      expect(created.token).toBe(token);

      const [row] = await db
        .select()
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.id, created.id));
      expect(row!.userId).toBe(user.id);

      frozenNow = new Date("2026-07-24T11:00:00Z");
      const again = await postPushToken(accessToken, { token, platform: "ios" });
      expect(again.status).toBe(200);
      const kept = PushTokenSchema.parse(await again.json());
      expect(kept.id).toBe(created.id); // same row — upsert, not duplicate
      expect(new Date(kept.last_seen_at).getTime()).toBeGreaterThan(
        new Date(created.last_seen_at).getTime(),
      );
    });

    it("a token registered by B MOVES to A on A's registration (no duplicate)", async () => {
      const a = await seedUser();
      const b = await seedUser();
      const token = expoToken();

      const bRes = await postPushToken(b.accessToken, { token, platform: "android" });
      const bRow = PushTokenSchema.parse(await bRes.json());

      const aRes = await postPushToken(a.accessToken, { token, platform: "android" });
      expect(aRes.status).toBe(200);
      const aRow = PushTokenSchema.parse(await aRes.json());
      expect(aRow.id).toBe(bRow.id); // moved, not re-minted

      const rows = await db
        .select()
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.token, token));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(a.user.id);
    });

    it("malformed tokens → 400 (Expo shape enforced at the boundary)", async () => {
      const { accessToken } = await seedUser();
      for (const token of ["raw-apns-hex", "ExponentPushToken[", "ExponentPushToken[a b]"]) {
        const res = await postPushToken(accessToken, { token, platform: "ios" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as Envelope).error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("deletes own token (204); repeat delete, unknown id, and non-uuid follow the contract", async () => {
      const { accessToken } = await seedUser();
      const res = await postPushToken(accessToken, { token: expoToken(), platform: "ios" });
      const created = PushTokenSchema.parse(await res.json());

      expect((await deletePushToken(accessToken, created.id)).status).toBe(204);
      expect((await deletePushToken(accessToken, created.id)).status).toBe(404); // idempotence boundary
      expect((await deletePushToken(accessToken, randomUUID())).status).toBe(404);
      expect((await deletePushToken(accessToken, "not-a-uuid")).status).toBe(400);
    });

    it("B's token id → 404 indistinguishable from absent; row untouched", async () => {
      const a = await seedUser();
      const b = await seedUser();
      const res = await postPushToken(b.accessToken, { token: expoToken(), platform: "ios" });
      const bTok = PushTokenSchema.parse(await res.json());

      const foreign = await deletePushToken(a.accessToken, bTok.id);
      const absent = await deletePushToken(a.accessToken, randomUUID());
      expect(foreign.status).toBe(404);
      expect(withoutRequestId((await foreign.json()) as Envelope)).toEqual(
        withoutRequestId((await absent.json()) as Envelope),
      );

      const rows = await db
        .select()
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.id, bTok.id));
      expect(rows).toHaveLength(1); // survived the foreign delete attempt
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/me/entitlements (AU-7: R-ent-1/3)
  // -------------------------------------------------------------------------
  describe("GET /users/me/entitlements (R-ent-1/3)", () => {
    it("free plan resolves to the shared defaults (ai_calls_per_day = 30)", async () => {
      const { accessToken } = await seedUser();
      const res = await getEntitlements(accessToken);
      expect(res.status).toBe(200);
      expect(EffectiveEntitlementsSchema.parse(await res.json())).toEqual({
        plan: "free",
        ai_calls_per_day: 30,
        alerts_enabled: true,
        premium_place_details: true,
      });
    });

    it("overrides win over plan defaults (resolver precedence, R-shared-12)", async () => {
      const { user, accessToken } = await seedUser();
      await db
        .update(schema.entitlements)
        .set({ overrides: { ai_calls_per_day: 100, alerts_enabled: false } })
        .where(eq(schema.entitlements.userId, user.id));

      const body = EffectiveEntitlementsSchema.parse(
        await (await getEntitlements(accessToken)).json(),
      );
      expect(body.ai_calls_per_day).toBe(100);
      expect(body.alerts_enabled).toBe(false);
      expect(body.premium_place_details).toBe(true); // untouched default
    });

    it("a missing entitlements row fails safe to the free defaults", async () => {
      const { user, accessToken } = await seedUser();
      await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, user.id));
      const body = EffectiveEntitlementsSchema.parse(
        await (await getEntitlements(accessToken)).json(),
      );
      expect(body).toEqual({
        plan: "free",
        ai_calls_per_day: 30,
        alerts_enabled: true,
        premium_place_details: true,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Rate limits (§3.6.3: avatar-upload 10/h, payment-handles 10/h, per user)
  // -------------------------------------------------------------------------
  describe("rate limits (§3.6.3, R-auth-14)", () => {
    it("avatar-upload and payment-handles cap at 10/hour per user with Retry-After, resetting after the window", async () => {
      let nowMs = 1_800_000_000_000;
      const limited = createApp({
        auth: authDeps,
        users: {
          db,
          storage,
          cashtagChecker,
          rateLimit: { store: new InMemoryRateLimitStore(), now: () => nowMs },
        },
      });
      const { accessToken } = await seedUser();
      const other = await seedUser(); // proves the key is per-user

      const avatarReq = (token: string) =>
        limited.request("/api/users/me/avatar-upload", {
          method: "POST",
          headers: authHeaders(token, true),
          body: JSON.stringify({ content_type: "image/png", byte_size: 1 }),
        });
      const handlesReq = (token: string) =>
        limited.request("/api/users/me/payment-handles", {
          method: "PATCH",
          headers: authHeaders(token, true),
          body: JSON.stringify({ venmo_username: "rl" }),
        });

      for (let i = 0; i < RATE_LIMITS.avatarUpload.limit; i++) {
        expect((await avatarReq(accessToken)).status).toBe(200);
      }
      const blocked = await avatarReq(accessToken);
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as Envelope).error.code).toBe("RATE_LIMITED");
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

      // Independent window: the handles surface and the other user still pass.
      expect((await handlesReq(accessToken)).status).toBe(200);
      expect((await avatarReq(other.accessToken)).status).toBe(200);

      // Window rollover clears the block (and resets the handles window too —
      // both are 1-hour windows on the same clock).
      nowMs += RATE_LIMITS.avatarUpload.windowMs + 1;
      expect((await avatarReq(accessToken)).status).toBe(200);

      // The handles window caps identically (fresh window post-rollover).
      for (let i = 0; i < RATE_LIMITS.paymentHandles.limit; i++) {
        expect((await handlesReq(accessToken)).status).toBe(200);
      }
      const handlesBlocked = await handlesReq(accessToken);
      expect(handlesBlocked.status).toBe(429);
      expect(handlesBlocked.headers.get("retry-after")).not.toBeNull();
    });
  });
});
