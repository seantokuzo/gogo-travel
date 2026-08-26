/**
 * T-6.1 trip CRUD integration suite (API-TRIPS-1): POST/GET/GET:id/PATCH/
 * DELETE `/trips` end-to-end over a real Postgres, behind the real app-wide
 * `requireAuth` + `requireTripMember` gates. Covers every §3.3 "Tests
 * required" bullet for the five endpoints INCLUDING the push-event bullets
 * (T-6.3): trip.updated to other members minus the actor, trip.deleted to
 * the pre-delete member snapshot, trip.status_changed on both the manual
 * override and the derived read-path reconciliation (§3.5), ids-only
 * payloads, push_tokens fan-out, no emission on any rollback/failure path,
 * and a throwing emitter never breaking a request.
 *
 * Headline adversarial assertions: the F-038 IDOR harness (non-member,
 * nonexistent, and malformed trip ids produce BYTE-IDENTICAL 404s across
 * GET/PATCH/DELETE); create transactionality via a REAL forced membership-
 * insert failure (DB trigger) rolling back the trip row; the base-currency
 * lock with the budgets-currency sync in one transaction; and the
 * `expect_updated_at` microsecond landmine (a fresh row's echoed wire value
 * must NOT false-conflict).
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
import {
  TripListItemSchema,
  TripSchema,
  TripWithRoleSchema,
  type TripWithRole,
} from "@gogo/shared/domains/trip";
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
import { createTripEventEmitter } from "./push-invalidation.js";
import {
  createRecordingTripEvents,
  type RecordingTripEvents,
} from "./push-invalidation.test-util.js";

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
      "║  DOCKER UNAVAILABLE — T-6.1 TRIP CRUD SUITE SKIPPED               ║\n" +
      "║  Trip CRUD, the F-038 IDOR harness, create transactionality,      ║\n" +
      "║  the base-currency lock, expect_updated_at, and the status seam   ║\n" +
      "║  (trips spec §3.3/§3.4, R-trips-1..8/19/20/22) were NOT           ║\n" +
      "║  verified. Start Docker and re-run                                ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-6.1 trip CRUD suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-6.1 trip CRUD suite could " +
        "not verify trips spec §3.3/§3.4 (R-trips-1..8/19/20/22). A skip is " +
        "NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

/** Frozen server clock: derivation's `today` is 2026-07-25 (UTC) everywhere. */
const FROZEN_NOW = new Date("2026-07-25T12:00:00.000Z");

const PaginatedTripListSchema = paginatedSchema(TripListItemSchema);

describe.skipIf(!dockerAvailable)("T-6.1 trip CRUD routes (integration)", () => {
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

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `trips-${uniq()}@example.com`,
      displayName: "Trip Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  const VALID_CREATE = {
    name: "Lisbon",
    destination_name: "Lisbon, Portugal",
    destination_lat: 38.722252,
    destination_lng: -9.139337,
    start_date: "2026-08-01",
    end_date: "2026-08-10",
  };

  const request = (path: string, token?: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  const postTrip = (token: string | undefined, body: unknown) =>
    request("/api/trips", token, { method: "POST", body: JSON.stringify(body) });
  const listTrips = (token: string, query = "") => request(`/api/trips${query}`, token);
  const getTrip = (tripId: string, token: string) => request(`/api/trips/${tripId}`, token);
  const patchTrip = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}`, token, { method: "PATCH", body: JSON.stringify(body) });
  const deleteTrip = (tripId: string, token: string) =>
    request(`/api/trips/${tripId}`, token, { method: "DELETE" });

  /** POST a trip through the real route; returns the parsed wire trip. */
  async function createTripVia(
    token: string,
    overrides: Partial<typeof VALID_CREATE> & { base_currency?: string; theme?: string } = {},
  ): Promise<TripWithRole> {
    const res = await postTrip(token, { ...VALID_CREATE, name: `Trip ${uniq()}`, ...overrides });
    expect(res.status).toBe(201);
    return TripWithRoleSchema.parse(await res.json());
  }

  async function addMember(tripId: string, userId: string, role: TripMemberRole) {
    await db.insert(schema.tripMembers).values({ tripId, userId, role });
  }

  /** A trip with owner/editor/viewer members, created through the API. */
  async function seedCollabTrip() {
    const owner = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);
    await addMember(trip.id, editor.userId, "editor");
    await addMember(trip.id, viewer.userId, "viewer");
    return { owner, editor, viewer, trip };
  }

  const dbTrip = async (tripId: string) => {
    const [row] = await db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    return row;
  };

  // ===========================================================================
  // POST /trips (R-trips-3)
  // ===========================================================================

  it("POST: creates the trip + the creator's owner membership in one call; role returned", async () => {
    const owner = await seedUserWithToken();
    const res = await postTrip(owner.accessToken, VALID_CREATE);
    expect(res.status).toBe(201);

    const trip = TripWithRoleSchema.parse(await res.json());
    expect(trip.role).toBe("owner");
    expect(trip.name).toBe("Lisbon");
    expect(trip.destination_lat).toBeCloseTo(38.722252, 6);
    expect(trip.base_currency).toBe("USD"); // schema default (§3.3)
    expect(trip.created_by).toBe(owner.userId);
    // Frozen today (2026-07-25) precedes the dates → derived 'planning'.
    expect(trip.status).toBe("planning");
    expect(trip.status_override).toBeNull();

    const [membership] = await db
      .select()
      .from(schema.tripMembers)
      .where(
        and(
          eq(schema.tripMembers.tripId, trip.id),
          eq(schema.tripMembers.userId, owner.userId),
        ),
      );
    expect(membership?.role).toBe("owner");
  });

  it("POST: a trip whose dates span today is born 'active' (derived at insert, §3.4)", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken, {
      start_date: "2026-07-20",
      end_date: "2026-07-30",
    });
    expect(trip.status).toBe("active");
    expect((await dbTrip(trip.id))?.status).toBe("active");
  });

  it("POST: transactionality — a forced membership-insert failure rolls back the trip row", async () => {
    const owner = await seedUserWithToken();
    // A REAL failure, not a mock: a trigger that rejects trip_members inserts
    // for exactly this user. The trip insert succeeds first; the transaction
    // must take it down on the membership failure (R-trips-3).
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION t61_boom() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'T61_FORCED_MEMBERSHIP_FAILURE'; END $$;
      CREATE TRIGGER t61_members_boom BEFORE INSERT ON trip_members
        FOR EACH ROW WHEN (NEW.user_id = '${owner.userId}'::uuid)
        EXECUTE FUNCTION t61_boom();
    `);
    try {
      const res = await postTrip(owner.accessToken, VALID_CREATE);
      expect(res.status).toBe(500);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("INTERNAL");

      const orphans = await db
        .select({ id: schema.trips.id })
        .from(schema.trips)
        .where(eq(schema.trips.createdBy, owner.userId));
      expect(orphans).toEqual([]);
    } finally {
      await client.unsafe(`
        DROP TRIGGER IF EXISTS t61_members_boom ON trip_members;
        DROP FUNCTION IF EXISTS t61_boom();
      `);
    }
  });

  it("POST: start_date > end_date → 400 VALIDATION_FAILED", async () => {
    const owner = await seedUserWithToken();
    const res = await postTrip(owner.accessToken, {
      ...VALID_CREATE,
      start_date: "2026-08-11",
      end_date: "2026-08-10",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
  });

  it("POST: missing dates or missing destination_lat/lng → 400 (required at creation, Gate 2)", async () => {
    const owner = await seedUserWithToken();
    const { start_date: _s, ...noDates } = VALID_CREATE;
    expect((await postTrip(owner.accessToken, noDates)).status).toBe(400);
    const { destination_lat: _lat, ...noLat } = VALID_CREATE;
    expect((await postTrip(owner.accessToken, noLat)).status).toBe(400);
  });

  it("POST: unauthenticated → 401", async () => {
    const res = await postTrip(undefined, VALID_CREATE);
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("UNAUTHENTICATED");
  });

  it("POST: an overlong name (cap+1) → 400 at the boundary (DoS-headroom caps)", async () => {
    const owner = await seedUserWithToken();
    const res = await postTrip(owner.accessToken, { ...VALID_CREATE, name: "n".repeat(201) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    // Nothing reached the DB.
    const rows = await db
      .select({ id: schema.trips.id })
      .from(schema.trips)
      .where(eq(schema.trips.createdBy, owner.userId));
    expect(rows).toEqual([]);
  });

  // ===========================================================================
  // GET /trips (R-trips-4)
  // ===========================================================================

  it("GET list: returns only trips with caller membership, with correct role + member_count", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    // A second trip the editor does NOT belong to.
    await createTripVia(owner.accessToken);

    const res = await listTrips(editor.accessToken);
    expect(res.status).toBe(200);
    const page = PaginatedTripListSchema.parse(await res.json());
    expect(page.items.map((t) => t.id)).toEqual([trip.id]);
    expect(page.items[0]?.role).toBe("editor");
    expect(page.items[0]?.member_count).toBe(3);

    const viewerPage = PaginatedTripListSchema.parse(
      await (await listTrips(viewer.accessToken)).json(),
    );
    expect(viewerPage.items[0]?.role).toBe("viewer");
  });

  it("GET list: member_count counts LIVE members only — a legacy ghost membership row is excluded", async () => {
    const { owner, trip } = await seedCollabTrip(); // 3 live members
    // Legacy pre-T-6.1 state: a member's account was scrubbed but their
    // membership row survived. The count must not inflate for ghosts (same
    // live-member semantics as the account-deletion sole-owner guard).
    const ghost = await seedUserWithToken();
    await addMember(trip.id, ghost.userId, "viewer");
    await db
      .update(schema.users)
      .set({ deletedAt: FROZEN_NOW, googleSub: null, email: `deleted:${ghost.userId}` })
      .where(eq(schema.users.id, ghost.userId));

    const page = PaginatedTripListSchema.parse(
      await (await listTrips(owner.accessToken)).json(),
    );
    expect(page.items.find((t) => t.id === trip.id)?.member_count).toBe(3);
  });

  it("GET list: excludes trips the caller was removed from (per-request gate truth)", async () => {
    const { editor, trip } = await seedCollabTrip();
    await db
      .delete(schema.tripMembers)
      .where(
        and(
          eq(schema.tripMembers.tripId, trip.id),
          eq(schema.tripMembers.userId, editor.userId),
        ),
      );
    const page = PaginatedTripListSchema.parse(
      await (await listTrips(editor.accessToken)).json(),
    );
    expect(page.items).toEqual([]);
  });

  it("GET list: pagination cursor round-trips with no overlap and no phantom page", async () => {
    const owner = await seedUserWithToken();
    const t1 = await createTripVia(owner.accessToken);
    const t2 = await createTripVia(owner.accessToken);
    const t3 = await createTripVia(owner.accessToken);
    const allIds = new Set([t1.id, t2.id, t3.id]);

    const first = PaginatedTripListSchema.parse(
      await (await listTrips(owner.accessToken, "?limit=2")).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = PaginatedTripListSchema.parse(
      await (
        await listTrips(
          owner.accessToken,
          `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        )
      ).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((t) => t.id);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(allIds);
  });

  it("GET list: a malformed cursor falls back to page 1 — never a 500", async () => {
    const owner = await seedUserWithToken();
    await createTripVia(owner.accessToken);
    const res = await listTrips(owner.accessToken, "?cursor=%25not-a-cursor%25");
    expect(res.status).toBe(200);
    expect(PaginatedTripListSchema.parse(await res.json()).items).toHaveLength(1);
  });

  it("GET list: an out-of-bounds limit → 400 (server cap is the shared schema)", async () => {
    const owner = await seedUserWithToken();
    expect((await listTrips(owner.accessToken, "?limit=101")).status).toBe(400);
    expect((await listTrips(owner.accessToken, "?limit=0")).status).toBe(400);
  });

  // ===========================================================================
  // GET /trips/:tripId (R-trips-1) + the F-038 IDOR harness
  // ===========================================================================

  it("GET :id — member gets the trip + their own role", async () => {
    const { viewer, trip } = await seedCollabTrip();
    const res = await getTrip(trip.id, viewer.accessToken);
    expect(res.status).toBe(200);
    const body = TripWithRoleSchema.parse(await res.json());
    expect(body.id).toBe(trip.id);
    expect(body.role).toBe("viewer");
  });

  it("F-038 IDOR harness: non-member, nonexistent, and malformed ids are BYTE-IDENTICAL 404s across GET/PATCH/DELETE", async () => {
    const { trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();

    // GET — the read probe (also covers "wrong user / wrong trip").
    await expectIndistinguishable404s([
      await getTrip(trip.id, stranger.accessToken),
      await getTrip(NONEXISTENT_UUID, stranger.accessToken),
      await getTrip("not-a-uuid", stranger.accessToken),
    ]);

    // PATCH — a valid body so validation (which runs first, R-authz-4) passes
    // and the membership gate answers. A stranger must never see 403.
    await expectIndistinguishable404s([
      await patchTrip(trip.id, stranger.accessToken, { name: "probe" }),
      await patchTrip(NONEXISTENT_UUID, stranger.accessToken, { name: "probe" }),
    ]);

    // DELETE — owner-gated route still answers a stranger with the same 404.
    await expectIndistinguishable404s([
      await deleteTrip(trip.id, stranger.accessToken),
      await deleteTrip(NONEXISTENT_UUID, stranger.accessToken),
    ]);

    // Nothing was written by the probes.
    expect(await dbTrip(trip.id)).toBeDefined();
    expect((await dbTrip(trip.id))?.name).not.toBe("probe");
  });

  // ===========================================================================
  // Status reconciliation seam (§3.4, R-trips-7)
  // ===========================================================================

  /**
   * Seed a trip row directly with a stale stored status (drift simulation).
   * Default dates are fully past vs frozen today (2026-07-25) → derived 'past'.
   */
  async function seedDriftedTrip(
    ownerId: string,
    dates: { startDate: string; endDate: string } = {
      startDate: "2026-07-01",
      endDate: "2026-07-10",
    },
  ) {
    const [row] = await db
      .insert(schema.trips)
      .values({
        name: `Drifted ${uniq()}`,
        destinationName: "Porto",
        destinationLat: "41.157944",
        destinationLng: "-8.629105",
        startDate: dates.startDate,
        endDate: dates.endDate,
        status: "planning", // stale stored value
        createdBy: ownerId,
      })
      .returning();
    await addMember(row!.id, ownerId, "owner");
    return row!;
  }

  it("GET :id reconciles stored status to the derived value WITHOUT bumping updated_at", async () => {
    const owner = await seedUserWithToken();
    const seeded = await seedDriftedTrip(owner.userId);

    const res = await getTrip(seeded.id, owner.accessToken);
    const body = TripWithRoleSchema.parse(await res.json());
    expect(body.status).toBe("past"); // derived (today > end_date)

    const after = await dbTrip(seeded.id);
    expect(after?.status).toBe("past"); // stored value converged
    expect(after?.updatedAt.toISOString()).toBe(seeded.updatedAt.toISOString()); // no bump
  });

  it("GET list reconciles drifted rows the same way", async () => {
    const owner = await seedUserWithToken();
    const seeded = await seedDriftedTrip(owner.userId);

    const page = PaginatedTripListSchema.parse(
      await (await listTrips(owner.accessToken)).json(),
    );
    expect(page.items.find((t) => t.id === seeded.id)?.status).toBe("past");
    expect((await dbTrip(seeded.id))?.status).toBe("past");
  });

  it("one list call reconciles MULTIPLE drifted rows to DIFFERENT targets (per-status batching)", async () => {
    const owner = await seedUserWithToken();
    // Both stored 'planning'; derivation disagrees in different directions:
    const toPast = await seedDriftedTrip(owner.userId); // ended 07-10 → 'past'
    const toActive = await seedDriftedTrip(owner.userId, {
      startDate: "2026-07-20",
      endDate: "2026-07-30", // spans frozen today → 'active'
    });

    const page = PaginatedTripListSchema.parse(
      await (await listTrips(owner.accessToken)).json(),
    );
    expect(page.items.find((t) => t.id === toPast.id)?.status).toBe("past");
    expect(page.items.find((t) => t.id === toActive.id)?.status).toBe("active");

    // Each row converged to ITS OWN derived value — no cross-contamination
    // from the grouped UPDATE batches — and updated_at never moved.
    const pastRow = await dbTrip(toPast.id);
    const activeRow = await dbTrip(toActive.id);
    expect(pastRow?.status).toBe("past");
    expect(activeRow?.status).toBe("active");
    expect(pastRow?.updatedAt.toISOString()).toBe(toPast.updatedAt.toISOString());
    expect(activeRow?.updatedAt.toISOString()).toBe(toActive.updatedAt.toISOString());
  });

  it("a manual override wins over derivation on read — no reconcile write happens", async () => {
    const owner = await seedUserWithToken();
    const [row] = await db
      .insert(schema.trips)
      .values({
        name: `Overridden ${uniq()}`,
        destinationName: "Porto",
        destinationLat: "41.157944",
        destinationLng: "-8.629105",
        startDate: "2026-07-01",
        endDate: "2026-07-10", // derived would be 'past'
        status: "planning",
        statusOverride: "planning", // owner pinned it
        createdBy: owner.userId,
      })
      .returning();
    await addMember(row!.id, owner.userId, "owner");

    const body = TripWithRoleSchema.parse(
      await (await getTrip(row!.id, owner.accessToken)).json(),
    );
    expect(body.status).toBe("planning");
    expect(body.status_override).toBe("planning");
    expect((await dbTrip(row!.id))?.status).toBe("planning");
  });

  // ===========================================================================
  // PATCH /trips/:tripId (R-trips-5/6/19/20/22, §3.4 override seam)
  // ===========================================================================

  it("PATCH: editor updates name/dates/theme — updated_at bumped, full row returned (LWW)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const res = await patchTrip(trip.id, editor.accessToken, {
      name: "Renamed",
      start_date: "2026-08-02",
      end_date: "2026-08-12",
      theme: "sunset",
    });
    expect(res.status).toBe(200);
    const body = TripSchema.parse(await res.json());
    expect(body.name).toBe("Renamed");
    expect(body.start_date).toBe("2026-08-02");
    expect(body.theme).toBe("sunset");
    // Bumped = changed. (Not `>` — the update stamp comes from the JS clock
    // while the insert stamp came from Postgres now(); a Docker-VM clock skew
    // must not flake the suite. Distinctness is the R-trips-5 contract.)
    expect(body.updated_at).not.toBe(trip.updated_at);
    // The response IS the row (R-trips-19) — DB agrees.
    expect((await dbTrip(trip.id))?.name).toBe("Renamed");
  });

  it("PATCH: viewer → 403 (no PATCH field is viewer-writable, §3.2)", async () => {
    const { viewer, trip } = await seedCollabTrip();
    const res = await patchTrip(trip.id, viewer.accessToken, { name: "nope" });
    expect(res.status).toBe(403);
    expect((await dbTrip(trip.id))?.name).not.toBe("nope");
  });

  it("PATCH: editor touching base_currency → 403; owner succeeds pre-expense and budgets follow in the same txn", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    await db.insert(schema.budgets).values({
      tripId: trip.id,
      category: "food",
      capCents: 50_000,
      currency: "USD",
    });

    const editorRes = await patchTrip(trip.id, editor.accessToken, { base_currency: "EUR" });
    expect(editorRes.status).toBe(403);
    expect((await dbTrip(trip.id))?.baseCurrency).toBe("USD");

    const ownerRes = await patchTrip(trip.id, owner.accessToken, { base_currency: "EUR" });
    expect(ownerRes.status).toBe(200);
    expect(TripSchema.parse(await ownerRes.json()).base_currency).toBe("EUR");

    // budgets.currency == trips.base_currency invariant preserved (R-trips-22).
    const [budget] = await db
      .select()
      .from(schema.budgets)
      .where(eq(schema.budgets.tripId, trip.id));
    expect(budget?.currency).toBe("EUR");
    expect(budget?.capCents).toBe(50_000); // amounts unchanged
  });

  it("PATCH: base_currency change with ≥1 expense → 409 (R-trips-22 lock); same-value resubmit passes", async () => {
    const { owner, trip } = await seedCollabTrip();
    await db.insert(schema.expenses).values({
      tripId: trip.id,
      description: "taxi",
      category: "transport",
      paidBy: owner.userId,
      amountCents: 1_200,
      currency: "USD",
      createdBy: owner.userId,
    });

    const res = await patchTrip(trip.id, owner.accessToken, { base_currency: "EUR" });
    expect(res.status).toBe(409);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.details).toEqual({ reason: "base_currency_locked" });
    expect((await dbTrip(trip.id))?.baseCurrency).toBe("USD"); // nothing written

    // Same value = not a change — the settings form stays re-savable.
    expect((await patchTrip(trip.id, owner.accessToken, { base_currency: "USD" })).status).toBe(
      200,
    );
  });

  it("PATCH: base_currency racing a first-expense insert → 409, never a stale-snapshot write (T-6.1 TOCTOU closed — T-9.2 rider)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Second connection holds the trip row FOR UPDATE — exactly the lock the
    // expense-create service takes before validating against base_currency
    // (expenses/service.ts). The PATCH must PARK on it instead of running
    // its R-trips-22 has-expenses check against the pre-insert snapshot.
    // Holder object: TS control-flow can't track a `let` assigned inside the
    // begin-callback closure — a property read re-widens correctly.
    const holder: { pending?: Promise<Response> } = {};
    let settled = false;
    await client.begin(async (tx) => {
      await tx`SELECT id FROM trips WHERE id = ${trip.id} FOR UPDATE`;
      const pending = Promise.resolve(
        patchTrip(trip.id, owner.accessToken, { base_currency: "EUR" }),
      );
      holder.pending = pending;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await sleep(200);
      expect(settled).toBe(false); // parked on the trip-row lock
      // The racing FIRST expense commits while the lock is held.
      await tx`
        INSERT INTO expenses (trip_id, description, category, paid_by, amount_cents, currency, created_by)
        VALUES (${trip.id}, 'racing first expense', 'food', ${owner.userId}, 1000, 'USD', ${owner.userId})
      `;
    });

    if (!holder.pending) throw new Error("pending PATCH never fired");
    const res = await holder.pending;
    // Unblocked AFTER the expense committed: the check now sees it → 409.
    // Before the T-9.2 rider this PATCH read the empty pre-insert snapshot
    // and changed the base out from under the expense.
    expect(res.status).toBe(409);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.details).toEqual({ reason: "base_currency_locked" });
    expect((await dbTrip(trip.id))?.baseCurrency).toBe("USD"); // nothing written
  });

  it("PATCH: the R-trips-22 probe covers settlements — a settlements-ONLY trip cannot re-denominate its ledger (PR #30 R1, PR #29 root cause)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    // Zero expenses; ONE settlement row (base currency by convention,
    // R-money-13). Before the probe extension this PATCH succeeded and
    // silently re-denominated the settlement (USD→JPY ≈150×).
    await db.insert(schema.settlements).values({
      tripId: trip.id,
      fromUserId: editor.userId,
      toUserId: owner.userId,
      amountCents: 2500,
      currency: "USD",
      method: "venmo",
      createdBy: editor.userId,
    });

    const res = await patchTrip(trip.id, owner.accessToken, { base_currency: "JPY" });
    expect(res.status).toBe(409);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.details).toEqual({ reason: "base_currency_locked" });
    expect((await dbTrip(trip.id))?.baseCurrency).toBe("USD");

    // Same-value resubmit is still not a change — form stays re-savable.
    expect((await patchTrip(trip.id, owner.accessToken, { base_currency: "USD" })).status).toBe(
      200,
    );
  });

  it("PATCH: the R-trips-22 probe covers settle-requests — a requests-ONLY trip locks its base too (PR #30 R1)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    await db.insert(schema.settlementRequests).values({
      tripId: trip.id,
      fromUserId: editor.userId,
      toUserId: owner.userId,
      amountCents: 1800,
      currency: "USD",
    });

    const res = await patchTrip(trip.id, owner.accessToken, { base_currency: "EUR" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorEnvelope).error.details).toEqual({
      reason: "base_currency_locked",
    });
    expect((await dbTrip(trip.id))?.baseCurrency).toBe("USD");
  });

  it("PATCH: stale expect_updated_at → 409 with the stale reason, row unchanged (R-trips-6)", async () => {
    const { editor, trip } = await seedCollabTrip();
    // Someone else wins the race first.
    expect((await patchTrip(trip.id, editor.accessToken, { name: "First" })).status).toBe(200);

    // Now replay with the ORIGINAL (stale) updated_at.
    const res = await patchTrip(trip.id, editor.accessToken, {
      name: "Second",
      expect_updated_at: trip.updated_at,
    });
    expect(res.status).toBe(409);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope.error.details).toEqual({ reason: "stale_updated_at" });
    expect((await dbTrip(trip.id))?.name).toBe("First"); // write blocked
  });

  it("PATCH: a fresh row's echoed updated_at matches — the timestamptz microsecond landmine", async () => {
    const { owner, trip } = await seedCollabTrip();
    // trip.updated_at came straight off the wire from POST — the DB row still
    // carries now()'s microseconds. A naive equality would false-conflict.
    const res = await patchTrip(trip.id, owner.accessToken, {
      name: "Guarded",
      expect_updated_at: trip.updated_at,
    });
    expect(res.status).toBe(200);
    expect(TripSchema.parse(await res.json()).name).toBe("Guarded");
  });

  it("PATCH: omitted expect_updated_at → plain last-write-wins (§3.5 rule 1)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    expect((await patchTrip(trip.id, owner.accessToken, { name: "A" })).status).toBe(200);
    expect((await patchTrip(trip.id, editor.accessToken, { name: "B" })).status).toBe(200);
    expect((await dbTrip(trip.id))?.name).toBe("B");
  });

  it("PATCH: owner archives (override → 'past') mid-trip; clearing with null resumes derivation (§3.4)", async () => {
    const owner = await seedUserWithToken();
    // Dates span frozen today → derived 'active'.
    const trip = await createTripVia(owner.accessToken, {
      start_date: "2026-07-20",
      end_date: "2026-07-30",
    });
    expect(trip.status).toBe("active");

    const archived = TripSchema.parse(
      await (await patchTrip(trip.id, owner.accessToken, { status: "past" })).json(),
    );
    expect(archived.status).toBe("past");
    expect(archived.status_override).toBe("past");

    const cleared = TripSchema.parse(
      await (await patchTrip(trip.id, owner.accessToken, { status: null })).json(),
    );
    expect(cleared.status_override).toBeNull();
    expect(cleared.status).toBe("active"); // derivation resumed
  });

  it("PATCH: editor touching the status override → 403 (owner-only, R-trips-20)", async () => {
    const { editor, trip } = await seedCollabTrip();
    expect((await patchTrip(trip.id, editor.accessToken, { status: "past" })).status).toBe(403);
    expect((await dbTrip(trip.id))?.statusOverride).toBeNull();
  });

  it("PATCH: key PRESENCE is the owner-only touch — editor 403s on { status: null } and on a same-value base_currency", async () => {
    const { editor, trip } = await seedCollabTrip();

    // `null` clears the override — still an owner-only touch even though the
    // value is falsy (pins the presence check against a truthiness refactor).
    const clearProbe = await patchTrip(trip.id, editor.accessToken, { status: null });
    expect(clearProbe.status).toBe(403);

    // Echoing the CURRENT base_currency is not a change (R-trips-22) but IS a
    // touch (R-trips-20) — authz keys on presence, never on value diffing.
    expect(trip.base_currency).toBe("USD");
    const sameValueProbe = await patchTrip(trip.id, editor.accessToken, {
      base_currency: trip.base_currency,
    });
    expect(sameValueProbe.status).toBe(403);

    const after = await dbTrip(trip.id);
    expect(after?.statusOverride).toBeNull();
    expect(after?.baseCurrency).toBe("USD");
  });

  it("PATCH: an overlong theme (cap+1) → 400 at the boundary (DoS-headroom caps)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const res = await patchTrip(trip.id, owner.accessToken, { theme: "t".repeat(65) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    expect((await dbTrip(trip.id))?.theme).toBeNull();
  });

  it("PATCH: merged date-order violation → 400 (partial update can't sneak start > end)", async () => {
    const { editor, trip } = await seedCollabTrip(); // 2026-08-01 .. 2026-08-10
    const res = await patchTrip(trip.id, editor.accessToken, { start_date: "2026-08-11" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    expect((await dbTrip(trip.id))?.startDate).toBe("2026-08-01");
  });

  it("PATCH: a write-less body (expect_updated_at only / empty) never moves updated_at; stale precondition still 409s", async () => {
    const { editor, trip } = await seedCollabTrip();
    const before = await dbTrip(trip.id);

    const noop = await patchTrip(trip.id, editor.accessToken, {});
    expect(noop.status).toBe(200);
    expect((await dbTrip(trip.id))?.updatedAt.toISOString()).toBe(
      before?.updatedAt.toISOString(),
    );

    const fresh = await patchTrip(trip.id, editor.accessToken, {
      expect_updated_at: trip.updated_at,
    });
    expect(fresh.status).toBe(200);

    const stale = await patchTrip(trip.id, editor.accessToken, {
      expect_updated_at: "2020-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe(409);
  });

  // ===========================================================================
  // DELETE /trips/:tripId (R-trips-8)
  // ===========================================================================

  it("DELETE: owner deletes — 204 and children cascade (members, invites, bookings, expenses, budgets)", async () => {
    const { owner, trip } = await seedCollabTrip();
    await db.insert(schema.invites).values({
      tripId: trip.id,
      token: `tok-${uniq()}`,
      role: "editor",
      createdBy: owner.userId,
      expiresAt: new Date(FROZEN_NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    await db.insert(schema.bookings).values({
      tripId: trip.id,
      category: "lodging",
      title: "Hotel Lisboa",
      createdBy: owner.userId,
    });
    await db.insert(schema.expenses).values({
      tripId: trip.id,
      description: "dinner",
      category: "food",
      paidBy: owner.userId,
      amountCents: 4_500,
      currency: "USD",
      createdBy: owner.userId,
    });
    await db.insert(schema.budgets).values({
      tripId: trip.id,
      category: "food",
      capCents: 90_000,
      currency: "USD",
    });

    const res = await deleteTrip(trip.id, owner.accessToken);
    expect(res.status).toBe(204);

    expect(await dbTrip(trip.id)).toBeUndefined();
    expect(
      await db.select().from(schema.tripMembers).where(eq(schema.tripMembers.tripId, trip.id)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.invites).where(eq(schema.invites.tripId, trip.id)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.bookings).where(eq(schema.bookings.tripId, trip.id)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.expenses).where(eq(schema.expenses.tripId, trip.id)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.budgets).where(eq(schema.budgets.tripId, trip.id)),
    ).toEqual([]);
  });

  it("DELETE: editor and viewer → 403 (proven members, so no leak)", async () => {
    const { editor, viewer, trip } = await seedCollabTrip();
    expect((await deleteTrip(trip.id, editor.accessToken)).status).toBe(403);
    expect((await deleteTrip(trip.id, viewer.accessToken)).status).toBe(403);
    expect(await dbTrip(trip.id)).toBeDefined();
  });

  it("DELETE: deleting an already-deleted trip converges to the indistinguishable 404 (§3.5 rule 3)", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);
    expect((await deleteTrip(trip.id, owner.accessToken)).status).toBe(204);

    // The membership row died with the trip — the gate answers with the same
    // 404 a nonexistent trip gets.
    await expectIndistinguishable404s([
      await deleteTrip(trip.id, owner.accessToken),
      await deleteTrip(NONEXISTENT_UUID, owner.accessToken),
    ]);
  });

  // ===========================================================================
  // T-6.3 push invalidation (§3.5 rule 6, R-trips-18 / API-TRIPS-4)
  // ===========================================================================

  async function seedPushToken(userId: string): Promise<string> {
    const token = `ExponentPushToken[${uniq()}]`;
    await db.insert(schema.pushTokens).values({ userId, token, platform: "ios" });
    return token;
  }

  it("PATCH: trip.updated → other members minus the actor; push_tokens attached; payload ids-only", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    const editorTokenA = await seedPushToken(editor.userId);
    const editorTokenB = await seedPushToken(editor.userId);

    expect((await patchTrip(trip.id, owner.accessToken, { name: "Renamed" })).status).toBe(200);

    // Exactly ONE event — which also proves POST /trips emitted nothing for
    // this trip (§3.5 has no trip.created).
    const events = await pushEvents.eventsFor(trip.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.updated"]);
    const delivery = events[0]!;
    // Ids only (R-trips-18): no name, no content, no PII — exact key set.
    expect(Object.keys(delivery.payload)).toEqual(["event", "trip_id"]);
    expect(pushEvents.recipientIdsOf(delivery)).toEqual(
      [editor.userId, viewer.userId].sort(),
    );
    // Device fan-out via push_tokens (API-TRIPS-4): registered tokens ride
    // along; token-less members stay user-grained recipients.
    const editorRecipient = delivery.recipients.find((r) => r.userId === editor.userId);
    expect([...(editorRecipient?.tokens ?? [])].sort()).toEqual(
      [editorTokenA, editorTokenB].sort(),
    );
    expect(delivery.recipients.find((r) => r.userId === viewer.userId)?.tokens).toEqual([]);
  });

  it("PATCH: actor exclusion follows the ACTOR, not a role — editor PATCH fans out to owner + viewer", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    expect((await patchTrip(trip.id, editor.accessToken, { theme: "sunset" })).status).toBe(200);
    const events = await pushEvents.eventsFor(trip.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.updated"]);
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual(
      [owner.userId, viewer.userId].sort(),
    );
  });

  it("PATCH: failure and no-op paths NEVER emit — 403, stale 409, gate 404, write-less body", async () => {
    const { editor, viewer, trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();

    expect((await patchTrip(trip.id, viewer.accessToken, { name: "x" })).status).toBe(403);
    expect(
      (
        await patchTrip(trip.id, editor.accessToken, {
          name: "x",
          expect_updated_at: "2020-01-01T00:00:00.000Z",
        })
      ).status,
    ).toBe(409);
    expect((await patchTrip(trip.id, stranger.accessToken, { name: "x" })).status).toBe(404);
    // Write-less request: 200, but no mutation committed → no event
    // (R-trips-18 fires "WHEN any mutation ... commits").
    expect(
      (await patchTrip(trip.id, editor.accessToken, { expect_updated_at: trip.updated_at }))
        .status,
    ).toBe(200);

    expect(await pushEvents.eventsFor(trip.id)).toEqual([]);
  });

  it("PATCH: archiving (override → 'past') emits trip.updated AND trip.status_changed", async () => {
    const { owner, trip } = await seedCollabTrip();
    expect((await patchTrip(trip.id, owner.accessToken, { status: "past" })).status).toBe(200);
    // Independent §3.5 rows: the PATCH committed (trip.updated) and the
    // STORED status moved planning → past (trip.status_changed).
    const events = await pushEvents.eventsFor(trip.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.updated", "trip.status_changed"]);
  });

  it("PATCH: a date change that flips the DERIVED status emits trip.updated AND trip.status_changed", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip(); // 08-01..10 → 'planning' at frozen 07-25
    // Pull start_date behind frozen today: derived planning → active — the
    // §3.5 "stored status changes" trigger with NO override involved.
    expect(
      (await patchTrip(trip.id, owner.accessToken, { start_date: "2026-07-20" })).status,
    ).toBe(200);

    const events = await pushEvents.eventsFor(trip.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.updated", "trip.status_changed"]);
    expect(pushEvents.recipientIdsOf(events[1]!)).toEqual(
      [editor.userId, viewer.userId].sort(),
    );
    expect((await dbTrip(trip.id))?.status).toBe("active");
  });

  it("PATCH: a write-less body on a DRIFTED trip emits trip.status_changed ONLY (no trip.updated)", async () => {
    const owner = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const seeded = await seedDriftedTrip(owner.userId); // stored 'planning', derived 'past'
    await addMember(seeded.id, editor.userId, "editor");

    // Empty body: no writable field committed — the in-transaction
    // reconciliation still converged the stored status, and ONLY that event
    // fires (a write-less request is not a client mutation, R-trips-18).
    expect((await patchTrip(seeded.id, owner.accessToken, {})).status).toBe(200);

    const events = await pushEvents.eventsFor(seeded.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.status_changed"]);
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual([editor.userId]);
    expect((await dbTrip(seeded.id))?.status).toBe("past");
  });

  it("GET :id: derived reconciliation emits trip.status_changed to other members minus the READER", async () => {
    const owner = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const seeded = await seedDriftedTrip(owner.userId);
    await addMember(seeded.id, editor.userId, "editor");

    expect((await getTrip(seeded.id, editor.accessToken)).status).toBe(200);
    const events = await pushEvents.eventsFor(seeded.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.status_changed"]);
    expect(Object.keys(events[0]!.payload)).toEqual(["event", "trip_id"]);
    // The reader is the actor — their device already has the fresh value.
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual([owner.userId]);

    // Converged rows emit nothing on re-read: drift, not reads, is the trigger.
    expect((await getTrip(seeded.id, editor.accessToken)).status).toBe(200);
    expect(await pushEvents.eventsFor(seeded.id)).toHaveLength(1);
  });

  it("GET list: reconciliation emits one trip.status_changed PER drifted trip", async () => {
    const owner = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const toPast = await seedDriftedTrip(owner.userId);
    const toActive = await seedDriftedTrip(owner.userId, {
      startDate: "2026-07-20",
      endDate: "2026-07-30",
    });
    await addMember(toPast.id, editor.userId, "editor");
    await addMember(toActive.id, editor.userId, "viewer");

    expect((await listTrips(owner.accessToken)).status).toBe(200);
    const pastEvents = await pushEvents.eventsFor(toPast.id);
    const activeEvents = await pushEvents.eventsFor(toActive.id);
    expect(pastEvents.map((d) => d.payload.event)).toEqual(["trip.status_changed"]);
    expect(activeEvents.map((d) => d.payload.event)).toEqual(["trip.status_changed"]);
    expect(pushEvents.recipientIdsOf(pastEvents[0]!)).toEqual([editor.userId]);
  });

  it("DELETE: trip.deleted → the PRE-delete member set minus actor (fence snapshot; a 403 never emits)", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    expect((await deleteTrip(trip.id, editor.accessToken)).status).toBe(403); // must not emit
    expect((await deleteTrip(trip.id, owner.accessToken)).status).toBe(204);

    const events = await pushEvents.eventsFor(trip.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.deleted"]);
    expect(Object.keys(events[0]!.payload)).toEqual(["event", "trip_id"]);
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual(
      [editor.userId, viewer.userId].sort(),
    );
    // The recipients could ONLY have come from the pre-delete snapshot
    // (R-trips-8 "captured before the delete") — the rows are cascade-gone.
    expect(
      await db
        .select()
        .from(schema.tripMembers)
        .where(eq(schema.tripMembers.tripId, trip.id)),
    ).toEqual([]);
  });

  it("ghost members never receive events — fan-out is LIVE users only (STATE P-6 landmine)", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    await db
      .update(schema.users)
      .set({ deletedAt: FROZEN_NOW, googleSub: null, email: `deleted:${viewer.userId}` })
      .where(eq(schema.users.id, viewer.userId));

    expect((await patchTrip(trip.id, owner.accessToken, { name: "Live only" })).status).toBe(200);
    const events = await pushEvents.eventsFor(trip.id);
    expect(pushEvents.recipientIdsOf(events[0]!)).toEqual([editor.userId]);
  });

  it("a sole-member trip still emits — empty fan-out is not 'no emission'", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);
    expect((await patchTrip(trip.id, owner.accessToken, { name: "Solo" })).status).toBe(200);
    const events = await pushEvents.eventsFor(trip.id);
    expect(events.map((d) => d.payload.event)).toEqual(["trip.updated"]);
    expect(events[0]!.recipients).toEqual([]);
  });

  it("a THROWING emitter transport never breaks a request (fire-and-forget, R-trips-18)", async () => {
    const warnings: string[] = [];
    const throwingEmitter = createTripEventEmitter({
      db,
      transport: {
        deliver: () => {
          throw new Error("push transport down");
        },
      },
      logger: { warn: (m) => warnings.push(m) },
    });
    const hostile = createApp({
      auth: authDeps,
      trips: { db, now: () => FROZEN_NOW, tripEvents: throwingEmitter },
    });

    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken); // main app; create emits nothing
    const patched = await hostile.request(`/api/trips/${trip.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.accessToken}`,
      },
      body: JSON.stringify({ name: "Still fine" }),
    });
    expect(patched.status).toBe(200);
    const deletedRes = await hostile.request(`/api/trips/${trip.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(deletedRes.status).toBe(204);

    await throwingEmitter.idle();
    // Both drops were logged — and neither touched the responses above.
    expect(warnings.some((m) => m.includes("trip.updated"))).toBe(true);
    expect(warnings.some((m) => m.includes("trip.deleted"))).toBe(true);
  });
});
