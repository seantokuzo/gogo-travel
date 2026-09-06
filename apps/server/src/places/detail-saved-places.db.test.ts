/**
 * T-8.1 integration suite (PL-3/PL-4): GET /places/:placeId (spine detail +
 * the dormant fresh seam) and the saved-places CRUD, end-to-end over a real
 * Postgres behind the real app-wide `requireAuth` + `requireTripMember`.
 * Covers every §3.3 "Tests required" bullet for the five endpoints
 * (R-places-11..17) that is reachable in v1 — the FSQ-stubbed fresh happy
 * path, degrade, zero-persistence, entitlement-off, and daily-cap bullets
 * belong to the DEFERRED premium integration (Gate 2: no FSQ client exists
 * to stub; PL-3 ships spine read + reason plumbing only).
 *
 * Headline adversarial assertions: the F-038 byte-identity harness on the
 * detail door (invisible custom ≡ absent ≡ malformed), on the saved-places
 * trip door (non-member ≡ nonexistent trip), and on the savedPlaceId door
 * (wrong-trip ≡ absent ≡ malformed); viewer 403s on every write WITH the
 * ungated editor control arm; duplicate-save 409; unsave-then-resave (no
 * tombstone); the fresh seam's reason split + `Cache-Control: no-store`
 * with its absent-by-default control; and the route-order control proving
 * /places/search is not shadowed by the new :placeId route.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. No network beyond the local container (Law #5).
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import {
  PlaceDetailsSchema,
  SavedPlaceWithPlaceSchema,
  type SavedPlaceWithPlace,
} from "@gogo/shared/domains/place";
import type { PlaceSource, TripMemberRole } from "@gogo/shared/enums";
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
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place now: src/test/global-setup.ts (T-S3.3 shared container; the
// `--no-file-parallelism` workaround is retired — QUEUE P1).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

const PaginatedSavedPlacesSchema = paginatedSchema(SavedPlaceWithPlaceSchema);

describe.skipIf(!dockerAvailable)("T-8.1 place detail + saved-places routes (integration)", () => {
  let suiteDb: SuiteDb;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let signer: AccessTokenSigner;

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("places_detail_saved_places");
    db = suiteDb.db;

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
    // Minimal places deps: no limiter, no ingest trigger — neither surface
    // under test consumes them (the search route degrades by design).
    app = createApp({ auth: authDeps, places: { db } });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `t81-${uniq()}@example.com`,
      displayName: "Detail Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  async function seedSpinePlace(input: {
    source: Exclude<PlaceSource, "custom">;
    name: string;
    lat?: number;
    lng?: number;
    category?: string | null;
  }) {
    const [row] = await db
      .insert(schema.places)
      .values({
        source: input.source,
        sourceId: `${input.source}-${uniq()}`,
        name: input.name,
        lat: String(input.lat ?? 38.6916),
        lng: String(input.lng ?? -9.216),
        category: input.category ?? null,
      })
      .returning();
    if (!row) throw new Error("spine seed failed");
    return row;
  }

  async function seedCustomPlace(createdBy: string, name: string) {
    const [row] = await db
      .insert(schema.places)
      .values({
        source: "custom",
        name,
        lat: "38.700000",
        lng: "-9.200000",
        createdBy,
      })
      .returning();
    if (!row) throw new Error("custom seed failed");
    return row;
  }

  /** Trip + owner membership, inserted directly (trips surface not mounted). */
  async function seedTrip(ownerId: string) {
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
      .returning();
    if (!trip) throw new Error("trip seed failed");
    await db.insert(schema.tripMembers).values({ tripId: trip.id, userId: ownerId, role: "owner" });
    return trip;
  }

  async function addMember(tripId: string, userId: string, role: TripMemberRole) {
    await db.insert(schema.tripMembers).values({ tripId, userId, role });
  }

  /** Direct saved-place insert (for list/pagination seeding with controlled created_at). */
  async function insertSavedPlace(input: {
    tripId: string;
    placeId: string;
    createdBy: string;
    note?: string | null;
    createdAt?: Date;
  }) {
    const [row] = await db
      .insert(schema.savedPlaces)
      .values({
        tripId: input.tripId,
        placeId: input.placeId,
        createdBy: input.createdBy,
        note: input.note ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning();
    if (!row) throw new Error("saved place seed failed");
    return row;
  }

  // ---- request helpers ------------------------------------------------------

  const request = (path: string, token?: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  const getDetail = (placeId: string, token?: string, query = "") =>
    request(`/api/places/${placeId}${query}`, token);
  const listSaved = (tripId: string, token?: string, query = "") =>
    request(`/api/trips/${tripId}/saved-places${query}`, token);
  const postSaved = (tripId: string, token: string | undefined, body: unknown) =>
    request(`/api/trips/${tripId}/saved-places`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const patchSaved = (tripId: string, savedPlaceId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/saved-places/${savedPlaceId}`, token, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  const deleteSaved = (tripId: string, savedPlaceId: string, token: string) =>
    request(`/api/trips/${tripId}/saved-places/${savedPlaceId}`, token, { method: "DELETE" });

  async function saveOk(tripId: string, token: string, body: unknown): Promise<SavedPlaceWithPlace> {
    const res = await postSaved(tripId, token, body);
    expect(res.status).toBe(201);
    return SavedPlaceWithPlaceSchema.parse(await res.json());
  }

  // ===========================================================================
  // GET /places/:placeId — spine detail (R-places-11..14 dormant, R-places-17)
  // ===========================================================================

  it("spine detail: 200 with the full wire place, coarse_category derived; no fresh, no reason, no no-store", async () => {
    const user = await seedUserWithToken();
    const row = await seedSpinePlace({
      source: "overture",
      name: "Belém Tower",
      category: "tourist_attraction",
    });

    const res = await getDetail(row.id, user.accessToken);
    expect(res.status).toBe(200);
    // The default detail answer is cacheable — no-store only rides
    // fresh-requesting calls (CONTROL for the fresh=true assertions below).
    expect(res.headers.get("cache-control")).toBeNull();

    const body = PlaceDetailsSchema.parse(await res.json());
    expect(body.place).toMatchObject({
      id: row.id,
      source: "overture",
      source_id: row.sourceId,
      name: "Belém Tower",
      lat: 38.6916,
      lng: -9.216,
      category: "tourist_attraction",
      coarse_category: "attraction",
      created_by: null,
    });
    expect(body.fresh).toBeUndefined();
    expect(body.fresh_unavailable_reason).toBeUndefined();
    // The raw JSON carries no fresh keys at all (absent ≠ null on the wire).
    const raw = (await (await getDetail(row.id, user.accessToken)).json()) as Record<
      string,
      unknown
    >;
    expect("fresh" in raw).toBe(false);
    expect("fresh_unavailable_reason" in raw).toBe(false);
  });

  it("custom place: readable by its creator AND by a member of a trip that references it", async () => {
    const creator = await seedUserWithToken();
    const coMember = await seedUserWithToken();
    const custom = await seedCustomPlace(creator.userId, "Mom's House");
    const trip = await seedTrip(creator.userId);
    await addMember(trip.id, coMember.userId, "viewer");
    await insertSavedPlace({ tripId: trip.id, placeId: custom.id, createdBy: creator.userId });

    const own = await getDetail(custom.id, creator.accessToken);
    expect(own.status).toBe(200);
    const viaTrip = await getDetail(custom.id, coMember.accessToken);
    expect(viaTrip.status).toBe(200);
    expect(PlaceDetailsSchema.parse(await viaTrip.json()).place.name).toBe("Mom's House");
  });

  it("?fresh=true: v1 dormant seam — no-store + reason 'disabled' (fsq_os) / 'no_fsq_id' (others); fresh never present", async () => {
    const user = await seedUserWithToken();
    const fsq = await seedSpinePlace({ source: "fsq_os", name: "Pastéis de Belém" });
    const ovt = await seedSpinePlace({ source: "overture", name: "Time Out Market" });
    const custom = await seedCustomPlace(user.userId, "My Secret Spot");

    const fsqRes = await getDetail(fsq.id, user.accessToken, "?fresh=true");
    expect(fsqRes.status).toBe(200);
    expect(fsqRes.headers.get("cache-control")).toBe("no-store");
    const fsqBody = PlaceDetailsSchema.parse(await fsqRes.json());
    expect(fsqBody.fresh).toBeUndefined();
    expect(fsqBody.fresh_unavailable_reason).toBe("disabled");

    const ovtRes = await getDetail(ovt.id, user.accessToken, "?fresh=true");
    expect(ovtRes.headers.get("cache-control")).toBe("no-store");
    expect(PlaceDetailsSchema.parse(await ovtRes.json()).fresh_unavailable_reason).toBe(
      "no_fsq_id",
    );

    const customRes = await getDetail(custom.id, user.accessToken, "?fresh=true");
    expect(PlaceDetailsSchema.parse(await customRes.json()).fresh_unavailable_reason).toBe(
      "no_fsq_id",
    );
  });

  it("?fresh=false is NOT a fresh request (no no-store, no reason); non-boolish fresh → 400", async () => {
    const user = await seedUserWithToken();
    const fsq = await seedSpinePlace({ source: "fsq_os", name: "Fresh Control" });

    const explicitFalse = await getDetail(fsq.id, user.accessToken, "?fresh=false");
    expect(explicitFalse.status).toBe(200);
    expect(explicitFalse.headers.get("cache-control")).toBeNull();
    expect(
      PlaceDetailsSchema.parse(await explicitFalse.json()).fresh_unavailable_reason,
    ).toBeUndefined();

    const garbage = await getDetail(fsq.id, user.accessToken, "?fresh=maybe");
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
  });

  it("F-038 detail door: invisible custom ≡ absent ≡ malformed (byte-identical 404s), with and without ?fresh=true; the fresh 404 arm carries no-store", async () => {
    const creator = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const hidden = await seedCustomPlace(creator.userId, "Hidden Cabin");

    await expectIndistinguishable404s([
      await getDetail(hidden.id, stranger.accessToken), // exists, invisible
      await getDetail(NONEXISTENT_UUID, stranger.accessToken), // does not exist
      await getDetail("not-a-uuid", stranger.accessToken), // malformed, same door
    ]);

    // The fresh=true door (R-places-11): `Cache-Control: no-store` must ride
    // EVERY fresh-requesting response — the 404 arm included, or a stale
    // negative gets cached — and the three 404 classes stay byte-identical
    // within that door (the header depends only on caller input, so it is no
    // existence oracle).
    const freshProbes = [
      await getDetail(hidden.id, stranger.accessToken, "?fresh=true"),
      await getDetail(NONEXISTENT_UUID, stranger.accessToken, "?fresh=true"),
      await getDetail("not-a-uuid", stranger.accessToken, "?fresh=true"),
    ];
    for (const probe of freshProbes) {
      expect(probe.headers.get("cache-control")).toBe("no-store");
    }
    await expectIndistinguishable404s(freshProbes);
  });

  it("route-order control: /places/search still resolves to the search handler, not the :placeId 404 door", async () => {
    const user = await seedUserWithToken();
    await seedSpinePlace({ source: "overture", name: "Ordering Probe Cafe" });
    const res = await request(`/api/places/search?q=ordering%20probe`, user.accessToken);
    expect(res.status).toBe(200); // the :placeId route would answer 404 ("search" is no UUID)
  });

  it("unauthenticated detail → 401", async () => {
    const row = await seedSpinePlace({ source: "overture", name: "No Token Tower" });
    expect((await getDetail(row.id)).status).toBe(401);
  });

  // ===========================================================================
  // Saved places — POST (R-places-15/16)
  // ===========================================================================

  it("save happy path: 201 SavedPlaceWithPlace, created_by = caller, note round-trips; no note → null", async () => {
    const owner = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    const a = await seedSpinePlace({ source: "overture", name: "Save Target A" });
    const b = await seedSpinePlace({ source: "fsq_os", name: "Save Target B" });

    const withNote = await saveOk(trip.id, owner.accessToken, {
      place_id: a.id,
      note: "try the tarts",
    });
    expect(withNote.trip_id).toBe(trip.id);
    expect(withNote.place_id).toBe(a.id);
    expect(withNote.created_by).toBe(owner.userId);
    expect(withNote.note).toBe("try the tarts");
    expect(withNote.place.name).toBe("Save Target A");

    const noNote = await saveOk(trip.id, owner.accessToken, { place_id: b.id });
    expect(noNote.note).toBeNull();
    expect(noNote.place.source).toBe("fsq_os");
  });

  it("duplicate save → 409 CONFLICT (R-places-16); unsave-then-resave succeeds (no tombstone)", async () => {
    const owner = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    const place = await seedSpinePlace({ source: "overture", name: "Dup Target" });

    const first = await saveOk(trip.id, owner.accessToken, { place_id: place.id });

    const dup = await postSaved(trip.id, owner.accessToken, { place_id: place.id });
    expect(dup.status).toBe(409);
    const envelope = (await dup.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("CONFLICT");
    expect((envelope.error.details as { reason?: string }).reason).toBe("already_saved");

    // Unsave, then the same place saves again — the unique key holds no tombstone.
    expect((await deleteSaved(trip.id, first.id, owner.accessToken)).status).toBe(204);
    const again = await saveOk(trip.id, owner.accessToken, { place_id: place.id });
    expect(again.place_id).toBe(place.id);
    expect(again.id).not.toBe(first.id);
  });

  it("save authz: viewer → 403 with the editor CONTROL arm; non-member trip door byte-identical 404s", async () => {
    const owner = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    await addMember(trip.id, viewer.userId, "viewer");
    await addMember(trip.id, editor.userId, "editor");
    const place = await seedSpinePlace({ source: "overture", name: "Role Probe" });

    const denied = await postSaved(trip.id, viewer.accessToken, { place_id: place.id });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as ErrorEnvelope).error.code).toBe("FORBIDDEN");
    // Nothing was written by the denied call.
    const rows = await db
      .select()
      .from(schema.savedPlaces)
      .where(eq(schema.savedPlaces.tripId, trip.id));
    expect(rows).toHaveLength(0);

    // CONTROL: the identical request from an editor succeeds — the 403 is
    // the role gate, not a broken route.
    const allowed = await saveOk(trip.id, editor.accessToken, { place_id: place.id });
    expect(allowed.created_by).toBe(editor.userId);

    // Non-member probes: real trip ≡ nonexistent trip (F-038 trip door).
    await expectIndistinguishable404s([
      await postSaved(trip.id, stranger.accessToken, { place_id: place.id }),
      await postSaved(NONEXISTENT_UUID, stranger.accessToken, { place_id: place.id }),
      await postSaved("not-a-trip", stranger.accessToken, { place_id: place.id }),
    ]);
  });

  it("save visibility (Law #3): unknown place_id ≡ someone else's custom place (byte-identical 404s); own custom saves fine", async () => {
    const owner = await seedUserWithToken();
    const other = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    const foreignCustom = await seedCustomPlace(other.userId, "Their Secret Spot");
    const ownCustom = await seedCustomPlace(owner.userId, "My Custom Pin");

    await expectIndistinguishable404s([
      await postSaved(trip.id, owner.accessToken, { place_id: foreignCustom.id }), // exists, invisible
      await postSaved(trip.id, owner.accessToken, { place_id: NONEXISTENT_UUID }), // absent
    ]);
    // The invisible probe wrote nothing (the visibility check is BEFORE the insert).
    const rows = await db
      .select()
      .from(schema.savedPlaces)
      .where(eq(schema.savedPlaces.tripId, trip.id));
    expect(rows).toHaveLength(0);

    // CONTROL: the caller's own custom place is visible and saves.
    const saved = await saveOk(trip.id, owner.accessToken, { place_id: ownCustom.id });
    expect(saved.place.source).toBe("custom");

    // Malformed place_id is boundary validation (400) — a value that can
    // never name a real place reveals nothing (shared-schema door).
    const malformed = await postSaved(trip.id, owner.accessToken, { place_id: "nope" });
    expect(malformed.status).toBe(400);
  });

  it("note caps at the boundary: 2000 saves (CONTROL), 2001 → 400", async () => {
    const owner = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    const place = await seedSpinePlace({ source: "overture", name: "Cap Probe" });

    const over = await postSaved(trip.id, owner.accessToken, {
      place_id: place.id,
      note: "n".repeat(2001),
    });
    expect(over.status).toBe(400);
    expect(((await over.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    const atCap = await saveOk(trip.id, owner.accessToken, {
      place_id: place.id,
      note: "n".repeat(2000),
    });
    expect(atCap.note).toHaveLength(2000);
  });

  // ===========================================================================
  // Saved places — LIST (R-places-15)
  // ===========================================================================

  it("list: any member (viewer included) reads the pin set with embedded places, created_at DESC", async () => {
    const owner = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    await addMember(trip.id, viewer.userId, "viewer");
    const older = await seedSpinePlace({ source: "overture", name: "Older Pin" });
    const newer = await seedSpinePlace({ source: "fsq_os", name: "Newer Pin" });
    await insertSavedPlace({
      tripId: trip.id,
      placeId: older.id,
      createdBy: owner.userId,
      note: "first",
      createdAt: new Date("2026-08-10T00:00:00Z"),
    });
    await insertSavedPlace({
      tripId: trip.id,
      placeId: newer.id,
      createdBy: owner.userId,
      createdAt: new Date("2026-08-12T00:00:00Z"),
    });

    const res = await listSaved(trip.id, viewer.accessToken);
    expect(res.status).toBe(200);
    const body = PaginatedSavedPlacesSchema.parse(await res.json());
    expect(body.items.map((i) => i.place.name)).toEqual(["Newer Pin", "Older Pin"]);
    expect(body.items[0]?.note).toBeNull();
    expect(body.items[1]?.note).toBe("first");
    expect(body.nextCursor).toBeNull();
  });

  it("list pagination: limit walk visits every row exactly once; malformed cursor falls back to page 1", async () => {
    const owner = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const place = await seedSpinePlace({ source: "overture", name: `Page Pin ${i}` });
      const saved = await insertSavedPlace({
        tripId: trip.id,
        placeId: place.id,
        createdBy: owner.userId,
        createdAt: new Date(`2026-08-0${i + 1}T00:00:00Z`),
      });
      ids.push(saved.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const query = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await listSaved(trip.id, owner.accessToken, query);
      expect(res.status).toBe(200);
      const body = PaginatedSavedPlacesSchema.parse(await res.json());
      expect(body.items).toHaveLength(1);
      seen.push(body.items[0]!.id);
      cursor = body.nextCursor;
      if (page < 2) expect(cursor).not.toBeNull();
    }
    expect(cursor).toBeNull();
    // DESC by created_at ⇒ newest (index 2) first; every row exactly once.
    expect(seen).toEqual([ids[2], ids[1], ids[0]]);

    const malformed = await listSaved(trip.id, owner.accessToken, "?cursor=%%%garbage");
    expect(malformed.status).toBe(200);
    expect(PaginatedSavedPlacesSchema.parse(await malformed.json()).items[0]?.id).toBe(ids[2]);
  });

  it("list pagination tiebreak: identical created_at rows walk id DESC — every row exactly once, no skip, no dup (r1 A4)", async () => {
    const owner = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    // ONE shared timestamp (a single-txn bulk save shares now()): only the id
    // tiebreak can order this walk. If the ORDER BY tiebreak ever flipped to
    // `id ASC` while the row-value cursor predicate stayed DESC, the page-2
    // predicate would exclude every remaining equal-timestamp row and the
    // walk would silently drop pins — this test's exactly-once check goes RED.
    const sharedCreatedAt = new Date("2026-08-05T12:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const place = await seedSpinePlace({ source: "overture", name: `Tiebreak Pin ${i}` });
      const saved = await insertSavedPlace({
        tripId: trip.id,
        placeId: place.id,
        createdBy: owner.userId,
        createdAt: sharedCreatedAt,
      });
      ids.push(saved.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await listSaved(trip.id, owner.accessToken, query);
      expect(res.status).toBe(200);
      const body = PaginatedSavedPlacesSchema.parse(await res.json());
      for (const item of body.items) seen.push(item.id);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    // Exhaustion (not truncation) ended the walk; every id exactly once.
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    // And the visit order IS id DESC — canonical uuid text sorts bytewise,
    // so a lexicographic sort mirrors Postgres uuid ordering exactly.
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("list authz: non-member trip door byte-identical 404s; unauthenticated → 401", async () => {
    const owner = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);

    await expectIndistinguishable404s([
      await listSaved(trip.id, stranger.accessToken),
      await listSaved(NONEXISTENT_UUID, stranger.accessToken),
      await listSaved("not-a-trip", stranger.accessToken),
    ]);
    expect((await listSaved(trip.id)).status).toBe(401);
  });

  // ===========================================================================
  // Saved places — PATCH note (R-places-15)
  // ===========================================================================

  it("note edit: set, replace, and clear via null; response embeds the place", async () => {
    const owner = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    const place = await seedSpinePlace({ source: "overture", name: "Note Target" });
    const saved = await saveOk(trip.id, owner.accessToken, { place_id: place.id });
    expect(saved.note).toBeNull();

    const set = await patchSaved(trip.id, saved.id, owner.accessToken, { note: "window seat" });
    expect(set.status).toBe(200);
    const setBody = SavedPlaceWithPlaceSchema.parse(await set.json());
    expect(setBody.note).toBe("window seat");
    expect(setBody.place.name).toBe("Note Target");

    const cleared = await patchSaved(trip.id, saved.id, owner.accessToken, { note: null });
    expect(SavedPlaceWithPlaceSchema.parse(await cleared.json()).note).toBeNull();

    // Body without `note` is a validation failure — the key is required.
    const missing = await patchSaved(trip.id, saved.id, owner.accessToken, {});
    expect(missing.status).toBe(400);
  });

  it("note-edit authz: viewer → 403 (editor CONTROL); wrong-trip ≡ absent ≡ malformed savedPlaceId; non-member 404", async () => {
    const owner = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    await addMember(trip.id, viewer.userId, "viewer");
    const otherTrip = await seedTrip(owner.userId);
    const place = await seedSpinePlace({ source: "overture", name: "Patch Probe" });
    const otherPlace = await seedSpinePlace({ source: "overture", name: "Other Trip Pin" });
    const saved = await saveOk(trip.id, owner.accessToken, { place_id: place.id });
    const otherSaved = await saveOk(otherTrip.id, owner.accessToken, { place_id: otherPlace.id });

    const denied = await patchSaved(trip.id, saved.id, viewer.accessToken, { note: "nope" });
    expect(denied.status).toBe(403);
    // CONTROL: the owner's identical patch succeeds and the viewer's wrote nothing.
    const control = await patchSaved(trip.id, saved.id, owner.accessToken, { note: "mine" });
    expect(SavedPlaceWithPlaceSchema.parse(await control.json()).note).toBe("mine");

    // The savedPlaceId door: a row of ANOTHER trip is indistinguishable from
    // absent and from malformed — the caller is a full member of `trip`, so
    // only the resource layer answers here (not the membership gate).
    await expectIndistinguishable404s([
      await patchSaved(trip.id, otherSaved.id, owner.accessToken, { note: "x" }),
      await patchSaved(trip.id, NONEXISTENT_UUID, owner.accessToken, { note: "x" }),
      await patchSaved(trip.id, "not-a-uuid", owner.accessToken, { note: "x" }),
    ]);
    // And the wrong-trip probe did not write through to the other trip's row.
    const [otherRow] = await db
      .select()
      .from(schema.savedPlaces)
      .where(eq(schema.savedPlaces.id, otherSaved.id));
    expect(otherRow?.note).toBeNull();

    // Non-member: the trip door (gate 404) is byte-identical to the resource 404s.
    await expectIndistinguishable404s([
      await patchSaved(trip.id, saved.id, stranger.accessToken, { note: "x" }),
      await patchSaved(NONEXISTENT_UUID, saved.id, stranger.accessToken, { note: "x" }),
    ]);
  });

  // ===========================================================================
  // Saved places — DELETE (R-places-15)
  // ===========================================================================

  it("unsave: 204, row gone; viewer → 403 (owner CONTROL); wrong-trip/absent/malformed byte-identical 404s", async () => {
    const owner = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const trip = await seedTrip(owner.userId);
    await addMember(trip.id, viewer.userId, "viewer");
    const otherTrip = await seedTrip(owner.userId);
    const place = await seedSpinePlace({ source: "overture", name: "Delete Probe" });
    const otherPlace = await seedSpinePlace({ source: "overture", name: "Delete Other" });
    const saved = await saveOk(trip.id, owner.accessToken, { place_id: place.id });
    const otherSaved = await saveOk(otherTrip.id, owner.accessToken, { place_id: otherPlace.id });

    const denied = await deleteSaved(trip.id, saved.id, viewer.accessToken);
    expect(denied.status).toBe(403);
    // The viewer's denied call deleted nothing (CONTROL half 1).
    expect(
      await db.select().from(schema.savedPlaces).where(eq(schema.savedPlaces.id, saved.id)),
    ).toHaveLength(1);

    await expectIndistinguishable404s([
      await deleteSaved(trip.id, otherSaved.id, owner.accessToken), // wrong trip
      await deleteSaved(trip.id, NONEXISTENT_UUID, owner.accessToken), // absent
      await deleteSaved(trip.id, "not-a-uuid", owner.accessToken), // malformed
    ]);
    // The wrong-trip probe deleted nothing.
    expect(
      await db.select().from(schema.savedPlaces).where(eq(schema.savedPlaces.id, otherSaved.id)),
    ).toHaveLength(1);

    // CONTROL half 2: the owner's identical delete succeeds and the row is gone.
    expect((await deleteSaved(trip.id, saved.id, owner.accessToken)).status).toBe(204);
    expect(
      await db.select().from(schema.savedPlaces).where(eq(schema.savedPlaces.id, saved.id)),
    ).toHaveLength(0);
  });
});
