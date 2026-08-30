/**
 * `requireTripMember` integration suite (AU-5, R-authz-2/3 / §3.6.4 / Law #3) —
 * THE reusable trip-scoped authz fixture every later spec's authz tests build
 * on. End-to-end over a real Postgres with real access tokens.
 *
 * The headline, tested adversarially: a non-member and a nonexistent trip
 * produce BYTE-IDENTICAL 404 bodies (modulo the per-request `requestId`) — a
 * non-member cannot tell the trip exists. A proven member below the required
 * role gets 403 (their membership already proved existence, so no leak).
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less CI
 * run is a HARD FAILURE; a local Docker-less run skips with a loud banner. No
 * network beyond the local container (Law #5).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateKeyPair } from "jose";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TripMemberRole } from "@gogo/shared/enums";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import { requestIdMiddleware, createErrorHandler } from "./app-middleware.js";
import type { RequestVars } from "./errors.js";
import { createRequireAuth } from "./require-auth.js";
import { createRequireTripMember, tripContextOf } from "./require-trip-member.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place now: src/test/global-setup.ts (T-S3.3 shared container; the
// `--no-file-parallelism` workaround is retired — QUEUE P1).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const NONEXISTENT_TRIP = "99999999-9999-4999-8999-999999999999";

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
/** The envelope minus the per-request correlation id — the byte-identity unit. */
function withoutRequestId(body: Envelope): Omit<Envelope["error"], "requestId"> {
  const { requestId: _omit, ...rest } = body.error;
  return rest;
}

describe.skipIf(!dockerAvailable)("requireTripMember (integration)", () => {
  let suiteDb: SuiteDb;
  let db: PostgresJsDatabase<typeof schema>;
  let app: Hono<RequestVars>;
  let signer: AccessTokenSigner;

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("http_require_trip_member");
    db = suiteDb.db;

    const pair = await generateKeyPair("ES256");
    signer = { privateKey: pair.privateKey, kid: "gogo-es256-test" };

    const requireTripMember = createRequireTripMember({ db });
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
    // viewer read, editor mutation, owner management — the R-authz-3 ladder.
    app.get("/api/trips/:tripId", requireTripMember(), (c) => c.json(tripContextOf(c)));
    app.post("/api/trips/:tripId/edit", requireTripMember("editor"), (c) => c.json({ ok: true }));
    app.delete("/api/trips/:tripId/manage", requireTripMember("owner"), (c) =>
      c.json({ ok: true }),
    );
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  /** Seed a user and mint a live access token for them. */
  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `tm-${uniq()}@example.com`,
      displayName: "Trip Member Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  /** Seed a trip owned by `ownerId` (also inserts the owner membership). */
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

  const get = (tripId: string, token?: string) =>
    app.request(`/api/trips/${tripId}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const postEdit = (tripId: string, token: string) =>
    app.request(`/api/trips/${tripId}/edit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  const deleteManage = (tripId: string, token: string) =>
    app.request(`/api/trips/${tripId}/manage`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

  // -------------------------------------------------------------------------
  // The headline: 404-indistinguishability (§3.6.4 / R-authz-2 / Law #3)
  // -------------------------------------------------------------------------

  it("member → 200 with the real trip context; non-member and nonexistent trip → BYTE-IDENTICAL 404", async () => {
    const owner = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const tripId = await seedTrip(owner.userId);
    await addMember(tripId, viewer.userId, "viewer");

    // Member sees the real resource.
    const memberRes = await get(tripId, viewer.accessToken);
    expect(memberRes.status).toBe(200);
    expect(await memberRes.json()).toEqual({ tripId, role: "viewer" });

    // Non-member of a REAL trip.
    const nonMemberRes = await get(tripId, stranger.accessToken);
    expect(nonMemberRes.status).toBe(404);

    // A trip that does not exist.
    const ghostRes = await get(NONEXISTENT_TRIP, stranger.accessToken);
    expect(ghostRes.status).toBe(404);

    // The whole point: the two 404 bodies are identical minus the requestId —
    // no field, no length, nothing distinguishes "exists, not yours" from "gone".
    const nonMember = withoutRequestId((await nonMemberRes.json()) as Envelope);
    const ghost = withoutRequestId((await ghostRes.json()) as Envelope);
    expect(nonMember).toEqual(ghost);
    expect(nonMember).toEqual({ code: "NOT_FOUND", message: "not found" });
    expect((nonMember as { details?: unknown }).details).toBeUndefined();
  });

  it("a malformed (non-UUID) tripId is the SAME 404 — never a 500, never an oracle", async () => {
    const stranger = await seedUserWithToken();
    const res = await get("not-a-uuid", stranger.accessToken);
    expect(res.status).toBe(404);
    expect(withoutRequestId((await res.json()) as Envelope)).toEqual({
      code: "NOT_FOUND",
      message: "not found",
    });
  });

  it("cross-trip: a member of trip A is a non-member of trip B → 404 (same as a stranger)", async () => {
    const owner = await seedUserWithToken();
    const member = await seedUserWithToken();
    const tripA = await seedTrip(owner.userId);
    const tripB = await seedTrip(owner.userId);
    await addMember(tripA, member.userId, "viewer");

    expect((await get(tripA, member.accessToken)).status).toBe(200);
    expect((await get(tripB, member.accessToken)).status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Role ladder: viewer < editor < owner (R-authz-3) — 403 for proven members
  // -------------------------------------------------------------------------

  it("viewer is blocked from an editor route with 403 FORBIDDEN (membership already proved existence)", async () => {
    const owner = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const tripId = await seedTrip(owner.userId);
    await addMember(tripId, viewer.userId, "viewer");

    const res = await postEdit(tripId, viewer.accessToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Envelope).error.code).toBe("FORBIDDEN");
  });

  it("editor passes the editor route but is 403 on the owner route; owner passes both", async () => {
    const owner = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const tripId = await seedTrip(owner.userId);
    await addMember(tripId, editor.userId, "editor");

    expect((await postEdit(tripId, editor.accessToken)).status).toBe(200);
    expect((await deleteManage(tripId, editor.accessToken)).status).toBe(403);

    expect((await postEdit(tripId, owner.accessToken)).status).toBe(200);
    expect((await deleteManage(tripId, owner.accessToken)).status).toBe(200);
  });

  it("a non-member hitting an editor/owner route still gets 404, never 403 (no existence leak up the ladder)", async () => {
    const owner = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const tripId = await seedTrip(owner.userId);

    // A stranger must NEVER see 403 — that would confirm the trip exists.
    expect((await postEdit(tripId, stranger.accessToken)).status).toBe(404);
    expect((await deleteManage(tripId, stranger.accessToken)).status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Runs behind requireAuth (R-authz-1/4)
  // -------------------------------------------------------------------------

  it("unauthenticated → 401 (requireAuth precedes the membership check)", async () => {
    const owner = await seedUserWithToken();
    const tripId = await seedTrip(owner.userId);
    const res = await get(tripId);
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
  });
});
