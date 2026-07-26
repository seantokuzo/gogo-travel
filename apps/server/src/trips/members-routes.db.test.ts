/**
 * T-6.2 members integration suite (API-TRIPS-2): GET/PATCH/DELETE
 * `/trips/:tripId/members*` + transfer-ownership end-to-end over a real
 * Postgres, behind the real app-wide `requireAuth` + `requireTripMember`
 * gates. Covers every §3.3 "Tests required" bullet for the member endpoints
 * EXCEPT the push-event bullets — the §3.5 post-commit emitter is T-6.3's
 * seam (STATE P-6 wave plan) and its emission tests land with it.
 *
 * Headline adversarial assertions: the F-038 IDOR harness on every route
 * (incl. target-id probes — an unknown target and a malformed target are
 * byte-identical 404s); transfer transactionality via a REAL forced
 * promote failure (DB trigger) rolling back the demote (at-least-one owner,
 * R-trips-9); and R-trips-12 — removal touches ONLY the membership row
 * (expenses, shares, settlements, saved-place attribution all survive).
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. No network beyond the local container (Law #5).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemberListSchema,
  OwnershipTransferResultSchema,
  TripMemberSchema,
} from "@gogo/shared/domains/member";
import type { TripMemberRole } from "@gogo/shared/enums";
import { createApp } from "../app.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import {
  expectIndistinguishable404s,
  NONEXISTENT_UUID,
  type ErrorEnvelope,
} from "../http/idor-404.test-util.js";

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
      "║  DOCKER UNAVAILABLE — T-6.2 MEMBERS SUITE SKIPPED                  ║\n" +
      "║  Member list/role/removal/leave + ownership transfer (trips spec  ║\n" +
      "║  §3.3, R-trips-9..12) and their F-038 IDOR proofs were NOT        ║\n" +
      "║  verified. Start Docker and re-run                                ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-6.2 members suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-6.2 members suite could not " +
        "verify trips spec §3.3 (R-trips-9..12). A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
const FROZEN_NOW = new Date("2026-07-25T12:00:00.000Z");

describe.skipIf(!dockerAvailable)("T-6.2 members routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let signer: AccessTokenSigner;

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
    const authDeps: AuthRouterDeps = {
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
    app = createApp({ auth: authDeps, trips: { db, now: () => FROZEN_NOW } });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken(displayName = "Member Tester") {
    const { user } = await createUserWithEntitlements(db, {
      email: `members-${uniq()}@example.com`,
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

  async function seedCollabTrip() {
    const owner = await seedUserWithToken("Owner O");
    const editor = await seedUserWithToken("Editor E");
    const viewer = await seedUserWithToken("Viewer V");
    const tripId = await seedTrip(owner.userId);
    await addMember(tripId, editor.userId, "editor");
    await addMember(tripId, viewer.userId, "viewer");
    return { owner, editor, viewer, tripId };
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

  const listMembers = (tripId: string, token: string) =>
    request(`/api/trips/${tripId}/members`, token);
  const patchRole = (tripId: string, targetId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/members/${targetId}`, token, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  const removeMember = (tripId: string, targetId: string, token: string) =>
    request(`/api/trips/${tripId}/members/${targetId}`, token, { method: "DELETE" });
  const transfer = (tripId: string, token: string, toUserId: string) =>
    request(`/api/trips/${tripId}/transfer-ownership`, token, {
      method: "POST",
      body: JSON.stringify({ to_user_id: toUserId }),
    });

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
  // GET /trips/:tripId/members (R-trips-1, §3.2 member list)
  // ===========================================================================

  it("GET members: all members with roles + member-visible payment handles; owner-first order", async () => {
    const { owner, editor, viewer, tripId } = await seedCollabTrip();
    await db
      .update(schema.users)
      .set({ venmoUsername: "editor-venmo", cashtag: "editorcash" })
      .where(eq(schema.users.id, editor.userId));

    const res = await listMembers(tripId, viewer.accessToken);
    expect(res.status).toBe(200);
    const body = MemberListSchema.parse(await res.json());

    expect(body.items).toHaveLength(3);
    // joined_at ASC ⇒ the owner (created first) leads.
    expect(body.items[0]?.user.id).toBe(owner.userId);
    expect(body.items[0]?.role).toBe("owner");

    const editorItem = body.items.find((m) => m.user.id === editor.userId);
    expect(editorItem?.role).toBe("editor");
    // Handles are deliberately member-visible (settle-up, §3.2 note).
    expect(editorItem?.user.venmo_username).toBe("editor-venmo");
    expect(editorItem?.user.cashtag).toBe("editorcash");
    // And the member-visible view NEVER carries email/prefs (R-user-4 shape).
    expect(JSON.stringify(body)).not.toContain("@example.com");
  });

  it("GET members: a ghost (scrubbed) member is excluded — aggregates join LIVE users", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const ghost = await seedUserWithToken("Ghost G");
    await addMember(tripId, ghost.userId, "viewer");
    await db
      .update(schema.users)
      .set({ deletedAt: FROZEN_NOW, googleSub: null, email: `deleted:${ghost.userId}` })
      .where(eq(schema.users.id, ghost.userId));

    const body = MemberListSchema.parse(await (await listMembers(tripId, owner.accessToken)).json());
    expect(body.items).toHaveLength(3);
    expect(body.items.some((m) => m.user.id === ghost.userId)).toBe(false);
  });

  // ===========================================================================
  // PATCH /trips/:tripId/members/:userId (R-trips-9)
  // ===========================================================================

  it("PATCH role: owner flips editor↔viewer both ways; the updated member row returns", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();

    const down = await patchRole(tripId, editor.userId, owner.accessToken, { role: "viewer" });
    expect(down.status).toBe(200);
    const demoted = TripMemberSchema.parse(await down.json());
    expect(demoted.role).toBe("viewer");
    expect(demoted.user_id).toBe(editor.userId);
    expect((await memberRow(tripId, editor.userId))?.role).toBe("viewer");

    const up = await patchRole(tripId, editor.userId, owner.accessToken, { role: "editor" });
    expect(TripMemberSchema.parse(await up.json()).role).toBe("editor");
  });

  it("PATCH role: 'owner' is rejected at the boundary; targeting the owner is a 400", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();

    const grantOwner = await patchRole(tripId, editor.userId, owner.accessToken, {
      role: "owner",
    });
    expect(grantOwner.status).toBe(400);
    expect(((await grantOwner.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    const targetOwner = await patchRole(tripId, owner.userId, owner.accessToken, {
      role: "editor",
    });
    expect(targetOwner.status).toBe(400);
    // Nothing moved: exactly one owner, unchanged.
    expect((await memberRow(tripId, owner.userId))?.role).toBe("owner");
    expect((await memberRow(tripId, editor.userId))?.role).toBe("editor");
  });

  it("PATCH role: editor and viewer callers → 403 (proven members, role too low)", async () => {
    const { editor, viewer, tripId } = await seedCollabTrip();
    expect(
      (await patchRole(tripId, viewer.userId, editor.accessToken, { role: "editor" })).status,
    ).toBe(403);
    expect(
      (await patchRole(tripId, editor.userId, viewer.accessToken, { role: "viewer" })).status,
    ).toBe(403);
    expect((await memberRow(tripId, viewer.userId))?.role).toBe("viewer");
  });

  // ===========================================================================
  // DELETE /trips/:tripId/members/:userId (R-trips-11, R-trips-12)
  // ===========================================================================

  it("DELETE: owner removes editor (204); the removed member's NEXT request is the gate 404", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();
    expect((await removeMember(tripId, editor.userId, owner.accessToken)).status).toBe(204);
    expect(await memberRow(tripId, editor.userId)).toBeUndefined();

    // Per-request gate truth (R-trips-1): access dies on the next request —
    // and it is the INDISTINGUISHABLE 404 (no "you were removed" oracle).
    await expectIndistinguishable404s([
      await listMembers(tripId, editor.accessToken),
      await listMembers(NONEXISTENT_UUID, editor.accessToken),
    ]);
  });

  it("DELETE: editor leaves self; viewer leaves self (204 each)", async () => {
    const { editor, viewer, tripId } = await seedCollabTrip();
    expect((await removeMember(tripId, editor.userId, editor.accessToken)).status).toBe(204);
    expect((await removeMember(tripId, viewer.userId, viewer.accessToken)).status).toBe(204);
    expect(await memberRow(tripId, editor.userId)).toBeUndefined();
    expect(await memberRow(tripId, viewer.userId)).toBeUndefined();
  });

  it("DELETE: editor removing another member → 403, nothing deleted", async () => {
    const { editor, viewer, tripId } = await seedCollabTrip();
    const res = await removeMember(tripId, viewer.userId, editor.accessToken);
    expect(res.status).toBe(403);
    expect(await memberRow(tripId, viewer.userId)).toBeDefined();
  });

  it("DELETE: owner removes a GHOST member's legacy row — 204, raw row gone (removal operates on rows, not aggregates)", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const ghost = await seedUserWithToken("Ghost G");
    await addMember(tripId, ghost.userId, "viewer");
    await db
      .update(schema.users)
      .set({ deletedAt: FROZEN_NOW, googleSub: null, email: `deleted:${ghost.userId}` })
      .where(eq(schema.users.id, ghost.userId));

    // The list hides the ghost (live-join aggregate), but the OWNER can still
    // clean the raw row up — the module-doc removal semantics, pinned so a
    // live-joined-delete refactor can't silently strand legacy ghost rows.
    expect((await removeMember(tripId, ghost.userId, owner.accessToken)).status).toBe(204);
    expect(await memberRow(tripId, ghost.userId)).toBeUndefined();
  });

  it("DELETE: a leave racing a transfer-to-the-leaver can NEVER strand the trip owner-less (EPQ role guard)", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();

    // Hold the transfer's critical section open, mirroring members-routes.ts:
    // ordered FOR UPDATE fence on both rows, demote, promote — uncommitted.
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
          and(
            eq(schema.tripMembers.tripId, tripId),
            inArray(schema.tripMembers.userId, [owner.userId, editor.userId]),
          ),
        )
        .orderBy(schema.tripMembers.userId)
        .for("update");
      await tx
        .update(schema.tripMembers)
        .set({ role: "editor" })
        .where(
          and(
            eq(schema.tripMembers.tripId, tripId),
            eq(schema.tripMembers.userId, owner.userId),
            eq(schema.tripMembers.role, "owner"),
          ),
        );
      await tx
        .update(schema.tripMembers)
        .set({ role: "owner" })
        .where(
          and(
            eq(schema.tripMembers.tripId, tripId),
            eq(schema.tripMembers.userId, editor.userId),
          ),
        );
      locksTaken();
      await gate;
    });
    await locksReady;

    // The editor's REAL leave request: the gate reads them as 'editor'
    // (pre-transfer snapshot) → leave path → its DELETE parks on the row
    // lock the in-flight promote holds. While we hold the transaction open
    // the leave cannot resolve — the wait is the lock's, not a timing guess.
    const leavePromise = Promise.resolve(removeMember(tripId, editor.userId, editor.accessToken));
    const during = await Promise.race([
      leavePromise.then(() => "resolved" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
    ]);
    expect(during).toBe("blocked");

    releaseTxn();
    await txnPromise;

    // EvalPlanQual re-evaluated the DELETE's WHERE against the promoted row:
    // ne(role,'owner') missed → 0 rows → converge on 404. Without the guard
    // this deletes the NEW OWNER row and strands the trip owner-less
    // (T-6.2 round-1 blocking #1).
    const res = await leavePromise;
    expect(res.status).toBe(404);
    expect((await memberRow(tripId, editor.userId))?.role).toBe("owner"); // survives
    expect((await memberRow(tripId, owner.userId))?.role).toBe("editor");
    const owners = await db
      .select()
      .from(schema.tripMembers)
      .where(and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.role, "owner")));
    expect(owners).toHaveLength(1); // exactly one owner, always
  });

  it("DELETE: owner leave with members present → 409 transfer-first (R-trips-11, Gate 2)", async () => {
    const { owner, tripId } = await seedCollabTrip();
    const res = await removeMember(tripId, owner.userId, owner.accessToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details).toEqual({ reason: "owner_transfer_required" });
    expect((await memberRow(tripId, owner.userId))?.role).toBe("owner");
  });

  it("DELETE: sole-member owner leave → 409 in favor of explicit trip deletion; ghost co-members don't change that", async () => {
    const owner = await seedUserWithToken();
    const tripId = await seedTrip(owner.userId);
    // A legacy ghost row must not turn this into "transfer first" — there is
    // nobody to transfer to (live-member semantics).
    const ghost = await seedUserWithToken();
    await addMember(tripId, ghost.userId, "viewer");
    await db
      .update(schema.users)
      .set({ deletedAt: FROZEN_NOW, googleSub: null, email: `deleted:${ghost.userId}` })
      .where(eq(schema.users.id, ghost.userId));

    const res = await removeMember(tripId, owner.userId, owner.accessToken);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorEnvelope).error.details).toEqual({
      reason: "delete_trip_instead",
    });
    expect((await memberRow(tripId, owner.userId))?.role).toBe("owner");
  });

  it("DELETE: removal touches ONLY the membership row — financial history + attribution survive (R-trips-12)", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();

    // The departing editor paid an expense split with the owner, settled part
    // of it, and pinned a place.
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        tripId,
        description: "group dinner",
        category: "food",
        paidBy: editor.userId,
        amountCents: 8_000,
        currency: "USD",
        createdBy: editor.userId,
      })
      .returning();
    await db.insert(schema.expenseShares).values([
      { expenseId: expense!.id, userId: editor.userId, shareCents: 4_000 },
      { expenseId: expense!.id, userId: owner.userId, shareCents: 4_000 },
    ]);
    await db.insert(schema.settlements).values({
      tripId,
      fromUserId: owner.userId,
      toUserId: editor.userId,
      amountCents: 4_000,
      currency: "USD",
      method: "venmo",
      createdBy: editor.userId,
    });
    const [place] = await db
      .insert(schema.places)
      .values({
        source: "custom",
        name: "Secret viewpoint",
        lat: "38.710000",
        lng: "-9.130000",
        createdBy: editor.userId,
      })
      .returning();
    await db
      .insert(schema.savedPlaces)
      .values({ tripId, placeId: place!.id, createdBy: editor.userId });

    expect((await removeMember(tripId, editor.userId, owner.accessToken)).status).toBe(204);

    // Ledger rows: present, un-reassigned, amounts intact (Law #2 history).
    const [expenseAfter] = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.tripId, tripId));
    expect(expenseAfter?.paidBy).toBe(editor.userId);
    expect(expenseAfter?.amountCents).toBe(8_000);
    const shares = await db
      .select()
      .from(schema.expenseShares)
      .where(eq(schema.expenseShares.expenseId, expense!.id));
    expect(shares).toHaveLength(2);
    expect(shares.find((s) => s.userId === editor.userId)?.shareCents).toBe(4_000);
    const [settlement] = await db
      .select()
      .from(schema.settlements)
      .where(eq(schema.settlements.tripId, tripId));
    expect(settlement?.toUserId).toBe(editor.userId);
    // Attribution detaches ONLY via schema §3.6 (user deletion), not removal.
    const [pin] = await db
      .select()
      .from(schema.savedPlaces)
      .where(eq(schema.savedPlaces.tripId, tripId));
    expect(pin?.createdBy).toBe(editor.userId);
  });

  // ===========================================================================
  // POST /trips/:tripId/transfer-ownership (R-trips-9, R-trips-10)
  // ===========================================================================

  it("transfer: one transaction — old owner → editor, target → owner; exactly one owner survives", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();

    const res = await transfer(tripId, owner.accessToken, editor.userId);
    expect(res.status).toBe(200);
    const body = OwnershipTransferResultSchema.parse(await res.json());
    expect(body.items).toHaveLength(2);
    expect(body.items.find((m) => m.user_id === owner.userId)?.role).toBe("editor");
    expect(body.items.find((m) => m.user_id === editor.userId)?.role).toBe("owner");

    // DB agrees, and the partial-unique owner index holds: exactly one owner.
    const owners = await db
      .select()
      .from(schema.tripMembers)
      .where(and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.role, "owner")));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(editor.userId);

    // The new owner can act as owner; the old owner cannot.
    expect((await transfer(tripId, owner.accessToken, editor.userId)).status).toBe(403);
  });

  it("transfer: transactionality — a forced promote failure rolls back the demote (at-least-one owner)", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();
    // A REAL failure: reject promoting exactly this target to owner. The
    // demote runs first and must be taken down with the transaction.
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION t62_promote_boom() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'T62_FORCED_PROMOTE_FAILURE'; END $$;
      CREATE TRIGGER t62_promote_boom BEFORE UPDATE ON trip_members
        FOR EACH ROW WHEN (NEW.role = 'owner' AND NEW.user_id = '${editor.userId}'::uuid)
        EXECUTE FUNCTION t62_promote_boom();
    `);
    try {
      const res = await transfer(tripId, owner.accessToken, editor.userId);
      expect(res.status).toBe(500);

      // Rolled back whole: the caller is STILL the owner (never a windowless
      // trip), the target still an editor.
      expect((await memberRow(tripId, owner.userId))?.role).toBe("owner");
      expect((await memberRow(tripId, editor.userId))?.role).toBe("editor");
    } finally {
      await client.unsafe(`
        DROP TRIGGER IF EXISTS t62_promote_boom ON trip_members;
        DROP FUNCTION IF EXISTS t62_promote_boom();
      `);
    }
  });

  it("transfer: outsider / ghost / unknown targets are BYTE-IDENTICAL 404s (with the gate 404); self → 400; non-owner → 403", async () => {
    const { owner, editor, viewer, tripId } = await seedCollabTrip();
    const outsider = await seedUserWithToken();
    const stranger = await seedUserWithToken();

    // A ghost member cannot receive ownership (R-trips-10 needs an actor).
    const ghost = await seedUserWithToken();
    await addMember(tripId, ghost.userId, "editor");
    await db
      .update(schema.users)
      .set({ deletedAt: FROZEN_NOW, googleSub: null, email: `deleted:${ghost.userId}` })
      .where(eq(schema.users.id, ghost.userId));

    // ONE 404 door: outsider target, ghost target, unknown target, and the
    // membership-gate 404 all serialize to the same bytes — no target-
    // existence or live-ness oracle for a probing owner, and no divergence
    // between the gate's return path and the transaction's thrown path.
    await expectIndistinguishable404s([
      await transfer(tripId, owner.accessToken, outsider.userId),
      await transfer(tripId, owner.accessToken, ghost.userId),
      await transfer(tripId, owner.accessToken, NONEXISTENT_UUID),
      await transfer(tripId, stranger.accessToken, editor.userId),
    ]);

    const self = await transfer(tripId, owner.accessToken, owner.userId);
    expect(self.status).toBe(400);

    expect((await transfer(tripId, editor.accessToken, viewer.userId)).status).toBe(403);
    expect((await transfer(tripId, viewer.accessToken, editor.userId)).status).toBe(403);

    // Through all of it: the owner never changed.
    expect((await memberRow(tripId, owner.userId))?.role).toBe("owner");
  });

  // ===========================================================================
  // F-038 IDOR harness — every member route, incl. target-id probes
  // ===========================================================================

  it("F-038: stranger, nonexistent, and malformed trip ids are BYTE-IDENTICAL 404s on every member route", async () => {
    const { owner, editor, tripId } = await seedCollabTrip();
    const stranger = await seedUserWithToken();

    await expectIndistinguishable404s([
      await listMembers(tripId, stranger.accessToken),
      await listMembers(NONEXISTENT_UUID, stranger.accessToken),
      await listMembers("not-a-uuid", stranger.accessToken),
    ]);

    // PATCH: stranger-on-real-trip vs owner-on-unknown-target vs owner-on-
    // malformed-target — the trip gate and the target lookup share ONE door.
    await expectIndistinguishable404s([
      await patchRole(tripId, editor.userId, stranger.accessToken, { role: "viewer" }),
      await patchRole(NONEXISTENT_UUID, editor.userId, stranger.accessToken, {
        role: "viewer",
      }),
      await patchRole(tripId, NONEXISTENT_UUID, owner.accessToken, { role: "viewer" }),
      await patchRole(tripId, "not-a-uuid", owner.accessToken, { role: "viewer" }),
    ]);

    await expectIndistinguishable404s([
      await removeMember(tripId, editor.userId, stranger.accessToken),
      await removeMember(NONEXISTENT_UUID, editor.userId, stranger.accessToken),
      await removeMember(tripId, NONEXISTENT_UUID, owner.accessToken),
      await removeMember(tripId, "not-a-uuid", owner.accessToken),
    ]);

    await expectIndistinguishable404s([
      await transfer(tripId, stranger.accessToken, editor.userId),
      await transfer(NONEXISTENT_UUID, stranger.accessToken, editor.userId),
      await transfer("not-a-uuid", stranger.accessToken, editor.userId),
    ]);

    // The probes wrote nothing.
    expect((await memberRow(tripId, owner.userId))?.role).toBe("owner");
    expect((await memberRow(tripId, editor.userId))?.role).toBe("editor");
  });

  it("unauthenticated → 401 on every member route", async () => {
    const { tripId, editor } = await seedCollabTrip();
    expect((await listMembers(tripId, undefined as unknown as string)).status).toBe(401);
    expect((await patchRole(tripId, editor.userId, "", { role: "viewer" })).status).toBe(401);
    expect((await removeMember(tripId, editor.userId, "")).status).toBe(401);
    expect((await transfer(tripId, "", editor.userId)).status).toBe(401);
  });
});
