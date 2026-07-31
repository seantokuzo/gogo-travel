/**
 * T-6.2 invites integration suite (API-TRIPS-3): create/list/revoke +
 * token preview/accept end-to-end over a real Postgres, behind the real
 * app-wide `requireAuth` + `requireTripMember` gates. Covers every §3.3
 * "Tests required" bullet for the invite endpoints INCLUDING the push-event
 * bullets (T-6.3): invite.created / invite.revoked with the invite id (never
 * the token) on the wire, member.added on real acceptance only — idempotent
 * already-member answers, dead-invite 409s, the max_uses race loser, and
 * forced-rollback accepts (statement-time AND commit-time aborts — the
 * latter pins the hook as strictly post-COMMIT) all emit NOTHING.
 *
 * Headline adversarial assertions: the MANDATORY max_uses race (§4 — two
 * REAL concurrent accepts on a max_uses:1 invite; exactly one member,
 * use_count exactly 1, loser 409); accept transactionality via a forced
 * membership-insert failure leaving use_count untouched; the preview
 * payload's trip_id/content exclusion asserted against the RAW JSON; and
 * F-038 byte-identical 404s on the trip-scoped routes AND across the
 * unknown-vs-malformed token door.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. No network beyond the local container (Law #5).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import { LINK_DOMAIN } from "@gogo/shared/config/links";
import {
  InviteAcceptSchema,
  InviteListItemSchema,
  InvitePreviewSchema,
  InviteWithUrlSchema,
} from "@gogo/shared/domains/member";
import type { TripMemberRole } from "@gogo/shared/enums";
import { createApp } from "../app.js";
import { INVITE_DEFAULT_TTL_MS, RATE_LIMITS } from "../config.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import {
  createRecordingTripEvents,
  type RecordingTripEvents,
} from "./push-invalidation.test-util.js";
import {
  expectIndistinguishable404s,
  NONEXISTENT_UUID,
  type ErrorEnvelope,
} from "../http/idor-404.test-util.js";
import { generateInviteToken } from "./invite-token.js";

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
      "║  DOCKER UNAVAILABLE — T-6.2 INVITES SUITE SKIPPED                  ║\n" +
      "║  Invite create/list/revoke, token preview/accept, the max_uses    ║\n" +
      "║  RACE, and the token rate limit (trips spec §3.3, R-trips-13..17) ║\n" +
      "║  were NOT verified. Start Docker and re-run                       ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-6.2 invites suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-6.2 invites suite could not " +
        "verify trips spec §3.3 (R-trips-13..17). A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
const FROZEN_NOW = new Date("2026-07-25T12:00:00.000Z");

const PaginatedInviteListSchema = paginatedSchema(InviteListItemSchema);

describe.skipIf(!dockerAvailable)("T-6.2 invites routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let authDeps: AuthRouterDeps;
  let signer: AccessTokenSigner;
  let pushEvents: RecordingTripEvents;

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
    pushEvents = createRecordingTripEvents(db);
    app = createApp({
      auth: authDeps,
      trips: { db, now: () => FROZEN_NOW, tripEvents: pushEvents.tripEvents },
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken(displayName = "Invite Tester") {
    const { user } = await createUserWithEntitlements(db, {
      email: `invites-${uniq()}@example.com`,
      displayName,
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  async function seedTrip(ownerId: string): Promise<string> {
    const [trip] = await db
      .insert(schema.trips)
      .values({
        name: `Trip ${uniq()}`,
        destinationName: "Lisbon, Portugal",
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

  async function seedCollabTrip() {
    const owner = await seedUserWithToken("Owner O");
    const editor = await seedUserWithToken("Editor E");
    const viewer = await seedUserWithToken("Viewer V");
    const tripId = await seedTrip(owner.userId);
    await addMember(tripId, editor.userId, "editor");
    await addMember(tripId, viewer.userId, "viewer");
    return { owner, editor, viewer, tripId };
  }

  /** Insert an invite row directly (state fixtures without route round-trips). */
  async function seedInvite(
    tripId: string,
    createdBy: string,
    overrides: Partial<typeof schema.invites.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(schema.invites)
      .values({
        tripId,
        token: generateInviteToken(),
        role: "editor",
        createdBy,
        expiresAt: new Date(FROZEN_NOW.getTime() + INVITE_DEFAULT_TTL_MS),
        ...overrides,
      })
      .returning();
    return row!;
  }

  const request = (path: string, token?: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  const createInvite = (tripId: string, token: string | undefined, body: unknown) =>
    request(`/api/trips/${tripId}/invites`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const listInvites = (tripId: string, token: string, query = "") =>
    request(`/api/trips/${tripId}/invites${query}`, token);
  const revokeInvite = (tripId: string, inviteId: string, token: string) =>
    request(`/api/trips/${tripId}/invites/${inviteId}`, token, { method: "DELETE" });
  const preview = (inviteToken: string, token?: string) =>
    request(`/api/invites/${inviteToken}`, token);
  const accept = (inviteToken: string, token?: string) =>
    request(`/api/invites/${inviteToken}/accept`, token, { method: "POST" });

  const inviteRowOf = async (id: string) =>
    (await db.select().from(schema.invites).where(eq(schema.invites.id, id)))[0];
  const memberRow = async (tripId: string, userId: string) =>
    (
      await db
        .select()
        .from(schema.tripMembers)
        .where(
          and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.userId, userId)),
        )
    )[0];

  // ===========================================================================
  // POST /trips/:tripId/invites (R-trips-13)
  // ===========================================================================

  it("POST: owner and editor create invites; the url rides the LINK_DOMAIN placeholder; token is 256-bit URL-safe", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();

    for (const creator of [owner, editor]) {
      const res = await createInvite(tripId, creator.accessToken, { role: "viewer" });
      expect(res.status).toBe(201);
      const invite = InviteWithUrlSchema.parse(await res.json());
      expect(invite.trip_id).toBe(tripId);
      expect(invite.role).toBe("viewer");
      expect(invite.created_by).toBe(creator.userId);
      // Token: 32 CSPRNG bytes → 43 base64url chars (≥128-bit floor, R-db-9).
      expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // URL format per the nav §2.3 registry, on the Gate-2 placeholder domain.
      expect(invite.url).toBe(`https://${LINK_DOMAIN}/invite/${invite.token}`);
      // Defaults (Gate 2): 7-day expiry, unlimited uses, zero consumed.
      expect(invite.expires_at).toBe(
        new Date(FROZEN_NOW.getTime() + INVITE_DEFAULT_TTL_MS).toISOString(),
      );
      expect(invite.max_uses).toBeNull();
      expect(invite.use_count).toBe(0);
      expect(invite.revoked_at).toBeNull();
    }

    // Uniqueness: two route-minted tokens differ.
    const [a, b] = await db.select().from(schema.invites).where(eq(schema.invites.tripId, tripId));
    expect(a!.token).not.toBe(b!.token);
  });

  it("POST: custom expires_at and max_uses are honored", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const res = await createInvite(tripId, owner.accessToken, {
      role: "editor",
      expires_at: "2026-09-01T00:00:00.000Z",
      max_uses: 5,
    });
    const invite = InviteWithUrlSchema.parse(await res.json());
    expect(invite.expires_at).toBe("2026-09-01T00:00:00.000Z");
    expect(invite.max_uses).toBe(5);
  });

  it("POST: viewer → 403; role 'owner' → 400; max_uses above int32 → 400", async () => {
    const { owner, viewer, tripId } = await seedCollabTrip();
    expect((await createInvite(tripId, viewer.accessToken, { role: "viewer" })).status).toBe(403);
    expect((await createInvite(tripId, owner.accessToken, { role: "owner" })).status).toBe(400);
    expect(
      (
        await createInvite(tripId, owner.accessToken, { role: "editor", max_uses: 2_147_483_648 })
      ).status,
    ).toBe(400);
  });

  // ===========================================================================
  // GET /trips/:tripId/invites (R-trips-13, R-trips-17)
  // ===========================================================================

  it("GET list: states computed from expires_at/revoked_at/use_count; viewer → 403", async () => {
    const { owner, viewer, tripId } = await seedCollabTrip();
    const active = await seedInvite(tripId, owner.userId);
    const expired = await seedInvite(tripId, owner.userId, {
      expiresAt: new Date(FROZEN_NOW.getTime() - 1000),
    });
    const revoked = await seedInvite(tripId, owner.userId, {
      revokedAt: new Date(FROZEN_NOW.getTime() - 1000),
    });
    const maxed = await seedInvite(tripId, owner.userId, { maxUses: 2, useCount: 2 });

    const res = await listInvites(tripId, owner.accessToken);
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { items: Record<string, unknown>[] };
    // T-6.8 defer (landed T-7.1): the raw bearer token NEVER rides the list
    // envelope — asserted on the RAW body (a schema parse would silently
    // strip a leaking key and mask the regression). Create keeps token+url.
    for (const item of raw.items) {
      expect(item).not.toHaveProperty("token");
    }
    const page = PaginatedInviteListSchema.parse(raw);
    const stateOf = (id: string) => page.items.find((i) => i.id === id)?.state;
    expect(stateOf(active.id)).toBe("active");
    expect(stateOf(expired.id)).toBe("expired");
    expect(stateOf(revoked.id)).toBe("revoked");
    expect(stateOf(maxed.id)).toBe("max_uses_reached");

    expect((await listInvites(tripId, viewer.accessToken)).status).toBe(403);
  });

  it("GET list: keyset cursor round-trips across the page boundary; malformed cursor falls back to page 1", async () => {
    const { owner, tripId } = await seedCollabTrip();
    // One over the page size (50) so a real second page exists.
    await db.insert(schema.invites).values(
      Array.from({ length: 51 }, () => ({
        tripId,
        token: generateInviteToken(),
        role: "viewer" as const,
        createdBy: owner.userId,
        expiresAt: new Date(FROZEN_NOW.getTime() + INVITE_DEFAULT_TTL_MS),
      })),
    );

    const first = PaginatedInviteListSchema.parse(
      await (await listInvites(tripId, owner.accessToken)).json(),
    );
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();

    const second = PaginatedInviteListSchema.parse(
      await (
        await listInvites(
          tripId,
          owner.accessToken,
          `?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        )
      ).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seen = new Set([...first.items, ...second.items].map((i) => i.id));
    expect(seen.size).toBe(51);

    const malformed = await listInvites(tripId, owner.accessToken, "?cursor=%25junk%25");
    expect(malformed.status).toBe(200);
    expect(PaginatedInviteListSchema.parse(await malformed.json()).items).toHaveLength(50);
  });

  // ===========================================================================
  // DELETE /trips/:tripId/invites/:inviteId (R-trips-17)
  // ===========================================================================

  it("revoke: owner revokes ANY; editor revokes OWN; editor revoking another's → 403; row persists", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();
    const ownersInvite = await seedInvite(tripId, owner.userId);
    const editorsInvite = await seedInvite(tripId, editor.userId);

    // Editor cannot touch the owner's invite…
    expect((await revokeInvite(tripId, ownersInvite.id, editor.accessToken)).status).toBe(403);
    // …but revokes their own; the owner revokes anyone's.
    expect((await revokeInvite(tripId, editorsInvite.id, editor.accessToken)).status).toBe(204);
    expect((await revokeInvite(tripId, ownersInvite.id, owner.accessToken)).status).toBe(204);

    // Rows persist with revoked_at set — never deleted as a revocation path.
    const editorsAfter = await inviteRowOf(editorsInvite.id);
    expect(editorsAfter).toBeDefined();
    expect(editorsAfter?.revokedAt).not.toBeNull();
  });

  it("revoke: already revoked → 409; unknown / other-trip / malformed invite ids → 404", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    expect((await revokeInvite(tripId, invite.id, owner.accessToken)).status).toBe(204);

    const again = await revokeInvite(tripId, invite.id, owner.accessToken);
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorEnvelope).error.details).toEqual({
      reason: "already_revoked",
    });

    // An invite that belongs to ANOTHER trip is unknown inside this one.
    const other = await seedCollabTrip();
    const foreign = await seedInvite(other.tripId, other.owner.userId);
    await expectIndistinguishable404s([
      await revokeInvite(tripId, foreign.id, owner.accessToken),
      await revokeInvite(tripId, NONEXISTENT_UUID, owner.accessToken),
      await revokeInvite(tripId, "not-a-uuid", owner.accessToken),
    ]);
    expect((await inviteRowOf(foreign.id))?.revokedAt).toBeNull();
  });

  // ===========================================================================
  // GET /invites/:token — preview (R-trips-16)
  // ===========================================================================

  it("preview: every state answers 200 with the state flagged; non-members may preview (token = capability)", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const outsider = await seedUserWithToken();
    const fixtures = {
      active: await seedInvite(tripId, owner.userId),
      expired: await seedInvite(tripId, owner.userId, {
        expiresAt: new Date(FROZEN_NOW.getTime() - 1000),
      }),
      revoked: await seedInvite(tripId, owner.userId, { revokedAt: FROZEN_NOW }),
      max_uses_reached: await seedInvite(tripId, owner.userId, { maxUses: 1, useCount: 1 }),
    } as const;

    for (const [state, invite] of Object.entries(fixtures)) {
      const res = await preview(invite.token, outsider.accessToken);
      expect(res.status).toBe(200);
      const body = InvitePreviewSchema.parse(await res.json());
      expect(body.state).toBe(state);
      expect(body.already_member).toBe(false);
      expect(body.trip.name).toContain("Trip ");
      expect(body.inviter.display_name).toBe("Owner O");
    }
  });

  it("preview: the payload carries NOTHING beyond the join-screen fields — no trip id, no member list", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    const outsider = await seedUserWithToken();

    const res = await preview(invite.token, outsider.accessToken);
    const raw = (await res.json()) as Record<string, unknown>;

    // Exact top-level and nested key sets — additive leaks fail loudly.
    expect(Object.keys(raw).sort()).toEqual([
      "already_member",
      "inviter",
      "role",
      "state",
      "trip",
    ]);
    expect(Object.keys(raw.trip as object).sort()).toEqual([
      "destination_name",
      "end_date",
      "name",
      "start_date",
    ]);
    expect(Object.keys(raw.inviter as object).sort()).toEqual(["avatar_key", "display_name"]);
    // The trip's UUID appears NOWHERE in the serialized payload.
    expect(JSON.stringify(raw)).not.toContain(tripId);
  });

  it("preview: already_member true for existing members; unknown and malformed tokens share one 404 door", async () => {
    const { owner, viewer, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);

    const memberRes = await preview(invite.token, viewer.accessToken);
    expect(InvitePreviewSchema.parse(await memberRes.json()).already_member).toBe(true);

    await expectIndistinguishable404s([
      await preview(generateInviteToken(), viewer.accessToken), // well-formed, unknown
      await preview("not+base64url.token!", viewer.accessToken), // malformed charset
      await preview("short", viewer.accessToken), // too short to be ours
    ]);
  });

  it("preview + accept: unauthenticated → 401 (auth required; deep link stashes + resumes client-side)", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    expect((await preview(invite.token)).status).toBe(401);
    expect((await accept(invite.token)).status).toBe(401);
  });

  // ===========================================================================
  // POST /invites/:token/accept (R-trips-14/15/16)
  // ===========================================================================

  it("accept: happy path — membership at the invite's role, use_count incremented, trip reachable", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId, { role: "editor" });
    const joiner = await seedUserWithToken();

    const res = await accept(invite.token, joiner.accessToken);
    expect(res.status).toBe(200);
    const body = InviteAcceptSchema.parse(await res.json());
    expect(body.trip_id).toBe(tripId);
    expect(body.role).toBe("editor");
    expect(body.already_member).toBe(false);

    expect((await memberRow(tripId, joiner.userId))?.role).toBe("editor");
    expect((await inviteRowOf(invite.id))?.useCount).toBe(1);

    // The gate now admits them (per-request truth, R-trips-1).
    expect((await request(`/api/trips/${tripId}`, joiner.accessToken)).status).toBe(200);
  });

  it("accept: transactionality — a forced membership-insert failure leaves use_count untouched", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    const joiner = await seedUserWithToken();

    await client.unsafe(`
      CREATE OR REPLACE FUNCTION t62_accept_boom() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'T62_FORCED_ACCEPT_FAILURE'; END $$;
      CREATE TRIGGER t62_accept_boom BEFORE INSERT ON trip_members
        FOR EACH ROW WHEN (NEW.user_id = '${joiner.userId}'::uuid)
        EXECUTE FUNCTION t62_accept_boom();
    `);
    try {
      const res = await accept(invite.token, joiner.accessToken);
      expect(res.status).toBe(500);
      // All-or-nothing (validate → upsert → increment): nothing landed.
      expect(await memberRow(tripId, joiner.userId)).toBeUndefined();
      expect((await inviteRowOf(invite.id))?.useCount).toBe(0);
      // T-6.3: the rolled-back acceptance emitted NOTHING (post-commit only).
      expect(await pushEvents.eventsFor(tripId)).toEqual([]);
    } finally {
      await client.unsafe(`
        DROP TRIGGER IF EXISTS t62_accept_boom ON trip_members;
        DROP FUNCTION IF EXISTS t62_accept_boom();
      `);
    }
  });

  it("accept: a COMMIT-time abort emits NOTHING — pins post-COMMIT hook placement (round-1 advisory #2)", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    const joiner = await seedUserWithToken();

    // Unlike the statement-time forced failure above, EVERY statement in the
    // acceptance succeeds here — the raise fires at COMMIT itself
    // (DEFERRABLE INITIALLY DEFERRED constraint trigger). An emit placed
    // anywhere inside the transaction — even after the final write — would
    // record a delivery for a membership that never became durable; only a
    // strictly post-commit hook stays silent.
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION t63_commit_boom() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'T63_FORCED_COMMIT_FAILURE'; END $$;
      CREATE CONSTRAINT TRIGGER t63_commit_boom AFTER INSERT ON trip_members
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.user_id = '${joiner.userId}'::uuid)
        EXECUTE FUNCTION t63_commit_boom();
    `);
    try {
      const res = await accept(invite.token, joiner.accessToken);
      expect(res.status).toBe(500);
      // The whole transaction died at COMMIT: no membership, no use charge…
      expect(await memberRow(tripId, joiner.userId)).toBeUndefined();
      expect((await inviteRowOf(invite.id))?.useCount).toBe(0);
      // …and ZERO emissions (an aborted COMMIT must never emit, R-trips-18).
      expect(await pushEvents.eventsFor(tripId)).toEqual([]);
    } finally {
      await client.unsafe(`
        DROP TRIGGER IF EXISTS t63_commit_boom ON trip_members;
        DROP FUNCTION IF EXISTS t63_commit_boom();
      `);
    }
  });

  it("accept: already-member → 200 with role UNCHANGED (even when the invite grants higher) and NO use_count increment", async () => {
    const { owner, viewer, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId, { role: "editor" });

    const res = await accept(invite.token, viewer.accessToken);
    expect(res.status).toBe(200);
    const body = InviteAcceptSchema.parse(await res.json());
    expect(body.already_member).toBe(true);
    expect(body.role).toBe("viewer"); // NOT lifted to the invite's editor
    expect((await memberRow(tripId, viewer.userId))?.role).toBe("viewer");
    expect((await inviteRowOf(invite.id))?.useCount).toBe(0);
    // T-6.3: an idempotent already-member answer committed no mutation —
    // no member.added (R-trips-15 / R-trips-18).
    expect(await pushEvents.eventsFor(tripId)).toEqual([]);
  });

  it("accept: expired / revoked / maxed → 409 with the exact details.reason; unknown token → 404", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const joiner = await seedUserWithToken();
    const dead = {
      expired: await seedInvite(tripId, owner.userId, {
        expiresAt: new Date(FROZEN_NOW.getTime() - 1000),
      }),
      revoked: await seedInvite(tripId, owner.userId, { revokedAt: FROZEN_NOW }),
      max_uses_reached: await seedInvite(tripId, owner.userId, { maxUses: 1, useCount: 1 }),
    } as const;

    for (const [reason, invite] of Object.entries(dead)) {
      const res = await accept(invite.token, joiner.accessToken);
      expect(res.status).toBe(409);
      const envelope = (await res.json()) as ErrorEnvelope;
      expect(envelope.error.code).toBe("CONFLICT");
      expect(envelope.error.details).toEqual({ reason });
    }
    // Nothing was written by any dead-invite attempt.
    expect(await memberRow(tripId, joiner.userId)).toBeUndefined();

    expect((await accept(generateInviteToken(), joiner.accessToken)).status).toBe(404);

    // T-6.3: none of the 409/404 doors above emitted anything.
    expect(await pushEvents.eventsFor(tripId)).toEqual([]);
  });

  it("accept: revocation kills acceptance (revoke → accept → 409 'revoked')", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    const joiner = await seedUserWithToken();

    expect((await revokeInvite(tripId, invite.id, owner.accessToken)).status).toBe(204);
    const res = await accept(invite.token, joiner.accessToken);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorEnvelope).error.details).toEqual({ reason: "revoked" });
  });

  it("accept RACE (§4 mandatory): two concurrent accepts on max_uses:1 — exactly one member, use_count exactly 1, loser 409", async () => {
    // A few rounds so both interleavings (lock-first vs lock-second) get
    // exercised — the invariant must hold on every one.
    for (let round = 0; round < 3; round++) {
      const { owner, tripId } = await seedCollabTrip();
      const invite = await seedInvite(tripId, owner.userId, { maxUses: 1 });
      const racerA = await seedUserWithToken();
      const racerB = await seedUserWithToken();

      const [resA, resB] = await Promise.all([
        accept(invite.token, racerA.accessToken),
        accept(invite.token, racerB.accessToken),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const loser = resA.status === 409 ? resA : resB;
      expect(((await loser.json()) as ErrorEnvelope).error.details).toEqual({
        reason: "max_uses_reached",
      });

      // use_count NEVER exceeds max_uses (R-trips-14) — and exactly one of
      // the racers holds a membership row.
      expect((await inviteRowOf(invite.id))?.useCount).toBe(1);
      const memberships = await Promise.all([
        memberRow(tripId, racerA.userId),
        memberRow(tripId, racerB.userId),
      ]);
      expect(memberships.filter((m) => m !== undefined)).toHaveLength(1);

      // T-6.3: exactly ONE member.added — the winner's; the 409 loser's
      // rolled-back transaction emitted nothing.
      const added = (await pushEvents.eventsFor(tripId)).filter(
        (d) => d.payload.event === "member.added",
      );
      expect(added).toHaveLength(1);
      expect(added[0]!.payload.entity_id).toBe(
        memberships.find((m) => m !== undefined)?.userId,
      );
    }
  });

  // ===========================================================================
  // Trip-delete membership fence (T-6.2 round-1 blocking #2)
  // ===========================================================================

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("DELETE /trips takes the membership fence BEFORE the cascade — no 40P01 with an in-flight accept", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);

    let releaseGate1!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      releaseGate1 = resolve;
    });
    let stage1Reached!: () => void;
    const stage1 = new Promise<void>((resolve) => {
      stage1Reached = resolve;
    });
    let stage2Reached!: () => void;
    const stage2 = new Promise<void>((resolve) => {
      stage2Reached = resolve;
    });
    let releaseGate2!: () => void;
    const gate2 = new Promise<void>((resolve) => {
      releaseGate2 = resolve;
    });

    const txnPromise = db.transaction(async (tx) => {
      // Accept's mid-flight state: owner-row FOR SHARE held, invite row not
      // yet locked (the exact window the cascade deadlock needs).
      await tx
        .select({ userId: schema.tripMembers.userId })
        .from(schema.tripMembers)
        .where(
          and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.role, "owner")),
        )
        .for("share");
      stage1Reached();
      await gate1;
      // THE deadlock probe: pre-fence, the parked DELETE would already hold
      // this trip's invite rows (RI cascade fires the invites FK first, 0000
      // creation order) while waiting on our member-row FOR SHARE — this
      // FOR UPDATE would close the cycle → 40P01. With the fence the delete
      // is parked BEFORE any cascade lock, so this acquires instantly.
      await tx
        .select({ id: schema.invites.id })
        .from(schema.invites)
        .where(eq(schema.invites.id, invite.id))
        .for("update");
      stage2Reached();
      await gate2;
    });
    await stage1;

    // The REAL owner trip-delete: must park at the fence (member rows), not
    // mid-cascade. While we hold the FOR SHARE it cannot resolve — the wait
    // is the lock's, not a timing guess.
    const deletePromise = Promise.resolve(
      request(`/api/trips/${tripId}`, owner.accessToken, { method: "DELETE" }),
    );
    const during = await Promise.race([
      deletePromise.then(() => "resolved" as const),
      delay(250).then(() => "blocked" as const),
    ]);
    expect(during).toBe("blocked");

    releaseGate1();
    await stage2; // invite FOR UPDATE acquired with the delete parked — no deadlock
    releaseGate2();
    await txnPromise;

    const res = await deletePromise;
    expect(res.status).toBe(204);
    expect(await db.select().from(schema.trips).where(eq(schema.trips.id, tripId))).toEqual([]);
  });

  // ===========================================================================
  // Rate limit — the /invites/:token* token-guessing guard (§3.3)
  // ===========================================================================

  it("token routes cap per user with Retry-After; preview and accept share the window", async () => {
    let nowMs = 1_800_000_000_000;
    const limited = createApp({
      auth: authDeps,
      trips: {
        db,
        now: () => FROZEN_NOW,
        rateLimit: { store: new InMemoryRateLimitStore(), now: () => nowMs },
      },
    });
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    const caller = await seedUserWithToken();
    const limitedPreview = (t: string) =>
      limited.request(`/api/invites/${t}`, {
        headers: { authorization: `Bearer ${caller.accessToken}` },
      });
    const limitedAccept = (t: string) =>
      limited.request(`/api/invites/${t}/accept`, {
        method: "POST",
        headers: { authorization: `Bearer ${caller.accessToken}` },
      });

    // Exhaust the per-user window on preview (unknown tokens count too —
    // that IS the guessing the guard exists for)…
    for (let i = 0; i < RATE_LIMITS.inviteTokenPerUser.limit; i++) {
      expect((await limitedPreview(generateInviteToken())).status).toBe(404);
    }
    const blockedPreview = await limitedPreview(invite.token);
    expect(blockedPreview.status).toBe(429);
    expect(((await blockedPreview.json()) as ErrorEnvelope).error.code).toBe("RATE_LIMITED");
    expect(Number(blockedPreview.headers.get("retry-after"))).toBeGreaterThan(0);

    // …and accept rides the SAME buckets (both routes are the guarded surface).
    expect((await limitedAccept(invite.token)).status).toBe(429);

    // Window rollover clears it.
    nowMs += RATE_LIMITS.inviteTokenPerUser.windowMs + 1;
    expect((await limitedPreview(invite.token)).status).toBe(200);
  });

  it("the per-IP window charges every token request — under-user-cap callers behind ONE IP trip it", async () => {
    let nowMs = 1_900_000_000_000;
    const limited = createApp({
      auth: authDeps,
      trips: {
        db,
        now: () => FROZEN_NOW,
        rateLimit: { store: new InMemoryRateLimitStore(), now: () => nowMs },
      },
    });
    // Under `app.request` there is no socket, so `clientIp()` answers
    // "unknown" for EVERY request — one shared IP bucket. That is exactly
    // the shape this test exploits: it proves the per-IP rule is wired and
    // CHARGING (not a silent no-op behind a null key), which no per-user
    // path can reach (30/user < 100/IP).
    const callers = await Promise.all(
      Array.from({ length: 5 }, () => seedUserWithToken("IP Racer")),
    );
    const limitedPreview = (accessToken: string) =>
      limited.request(`/api/invites/${generateInviteToken()}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

    // 4 callers × 25 requests = 100 = the per-IP cap; each caller stays well
    // under the 30/min user cap, so only the IP window accumulates.
    for (const caller of callers.slice(0, 4)) {
      for (let i = 0; i < 25; i++) {
        expect((await limitedPreview(caller.accessToken)).status).toBe(404);
      }
    }

    // The 101st request comes from a FRESH caller with an untouched user
    // bucket — only the shared IP window can 429 it.
    const blocked = await limitedPreview(callers[4]!.accessToken);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as ErrorEnvelope).error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // IP-window rollover clears it for the same fresh caller.
    nowMs += RATE_LIMITS.inviteTokenPerIp.windowMs + 1;
    expect((await limitedPreview(callers[4]!.accessToken)).status).toBe(404);
  });

  // ===========================================================================
  // F-038 IDOR harness — trip-scoped invite routes
  // ===========================================================================

  it("F-038: stranger, nonexistent, and malformed trip ids are BYTE-IDENTICAL 404s on create/list/revoke", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    const stranger = await seedUserWithToken();

    await expectIndistinguishable404s([
      await createInvite(tripId, stranger.accessToken, { role: "viewer" }),
      await createInvite(NONEXISTENT_UUID, stranger.accessToken, { role: "viewer" }),
      await createInvite("not-a-uuid", stranger.accessToken, { role: "viewer" }),
    ]);

    await expectIndistinguishable404s([
      await listInvites(tripId, stranger.accessToken),
      await listInvites(NONEXISTENT_UUID, stranger.accessToken),
      await listInvites("not-a-uuid", stranger.accessToken),
    ]);

    await expectIndistinguishable404s([
      await revokeInvite(tripId, invite.id, stranger.accessToken),
      await revokeInvite(NONEXISTENT_UUID, invite.id, stranger.accessToken),
      await revokeInvite("not-a-uuid", invite.id, stranger.accessToken),
    ]);

    // The probes wrote nothing: the invite is alive, no stranger membership.
    expect((await inviteRowOf(invite.id))?.revokedAt).toBeNull();
    expect(await memberRow(tripId, stranger.userId)).toBeUndefined();
  });

  // ===========================================================================
  // T-6.3 push invalidation (§3.5 rule 6, R-trips-18 / API-TRIPS-4)
  // ===========================================================================

  it("POST: invite.created → ALL other members incl. the viewer, minus the actor; the TOKEN never rides", async () => {
    const { owner, editor, viewer, tripId } = await seedCollabTrip();
    const res = await createInvite(tripId, owner.accessToken, { role: "viewer" });
    expect(res.status).toBe(201);
    const invite = InviteWithUrlSchema.parse(await res.json());

    const events = await pushEvents.eventsFor(tripId);
    expect(events.map((d) => d.payload.event)).toEqual(["invite.created"]);
    // entity_id is the invite ID — the capability TOKEN must never appear in
    // an event (ids only, R-trips-18; the token is a bearer secret).
    expect(Object.keys(events[0]!.payload)).toEqual(["event", "trip_id", "entity_id"]);
    expect(events[0]!.payload.entity_id).toBe(invite.id);
    expect(JSON.stringify(events[0])).not.toContain(invite.token);
    // §3.5: fan-out is MEMBERSHIP-drawn, not list-capability-drawn — the
    // viewer receives the event even though GET invites 403s them.
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual(
      [editor.userId, viewer.userId].sort(),
    );
  });

  it("POST: a viewer's 403 create emits nothing", async () => {
    const { viewer, tripId } = await seedCollabTrip();
    expect((await createInvite(tripId, viewer.accessToken, { role: "viewer" })).status).toBe(403);
    expect(await pushEvents.eventsFor(tripId)).toEqual([]);
  });

  it("revoke: invite.revoked once — the already-revoked 409 and an editor's 403 never emit", async () => {
    const { owner, editor, viewer, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId); // direct seed: no create event
    // Editor revoking another's invite: 403, no event.
    expect((await revokeInvite(tripId, invite.id, editor.accessToken)).status).toBe(403);
    expect((await revokeInvite(tripId, invite.id, owner.accessToken)).status).toBe(204);
    // Second revocation converges on 409 — still exactly one event.
    expect((await revokeInvite(tripId, invite.id, owner.accessToken)).status).toBe(409);

    const events = await pushEvents.eventsFor(tripId);
    expect(events.map((d) => d.payload.event)).toEqual(["invite.revoked"]);
    expect(events[0]!.payload.entity_id).toBe(invite.id);
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual(
      [editor.userId, viewer.userId].sort(),
    );
  });

  it("accept: member.added → the pre-existing members; the joining actor is excluded", async () => {
    const { owner, editor, viewer, tripId } = await seedCollabTrip();
    const invite = await seedInvite(tripId, owner.userId);
    const joiner = await seedUserWithToken();

    expect((await accept(invite.token, joiner.accessToken)).status).toBe(200);

    const events = await pushEvents.eventsFor(tripId);
    expect(events.map((d) => d.payload.event)).toEqual(["member.added"]);
    expect(events[0]!.payload.entity_id).toBe(joiner.userId);
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual(
      [owner.userId, editor.userId, viewer.userId].sort(),
    );
  });
});
