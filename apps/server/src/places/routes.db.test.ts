/**
 * T-6.5 places-surface integration suite (PL-2): GET /places/search +
 * POST/PATCH/DELETE custom places end-to-end over a real Postgres — REAL
 * pg_trgm text matching (no mocks), real GIN/btree indexes behind the
 * EXPLAIN pins — behind the real app-wide `requireAuth`. Covers every §3.3
 * "Tests required" bullet for the four endpoints (R-places-6..10).
 *
 * Headline adversarial assertions: custom-place visibility NEVER crosses
 * the trip boundary (creator / co-member / other-trip member / stranger
 * matrix, R-places-8 — Law #3 posture); the F-038 harness on the search
 * `trip_id` door and on PATCH/DELETE `:placeId` (invisible ≡ absent ≡
 * malformed, byte-identical); the search query's plan shape (trgm GIN for
 * text, lat/lng btree for geo — the T-6.4 sargability precedent); the
 * JS↔SQL coarse-category parity; and the enqueue-volume bounds (per-search
 * cell cap + per-user 429 — the T-6.4 round-1 security defer).
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. No network beyond the local container (Law #5).
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import { coarseCategory, PlaceSchema, type Place } from "@gogo/shared/domains/place";
import { regionCellAt, type RegionCell } from "@gogo/shared/region-grid";
import { SPINE_SOURCE_PRIORITY } from "@gogo/shared/config/places";
import type { PlaceSource } from "@gogo/shared/enums";
import { PLACES_SEARCH_MISS_MAX_CELLS, RATE_LIMITS } from "../config.js";
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
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { coarseCategorySqlExpr, placesSearchQuery } from "./search-query.js";

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
      "║  DOCKER UNAVAILABLE — T-6.5 PLACES SUITE SKIPPED                  ║\n" +
      "║  /places/search (pg_trgm + geo + blend + pagination + visibility),║\n" +
      "║  custom-place CRUD authz, the F-038 harness, the EXPLAIN plan     ║\n" +
      "║  pins, and the enqueue bounds (places spec §3.3, R-places-6..10)  ║\n" +
      "║  were NOT verified. Start Docker and re-run                       ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-6.5 places suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-6.5 places suite could not " +
        "verify places spec §3.3 (R-places-6..10). A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Frozen server clock — drives region-freshness in the coverage check. */
const FROZEN_NOW = new Date("2026-07-26T12:00:00.000Z");

const PaginatedPlacesSchema = paginatedSchema(PlaceSchema);

describe.skipIf(!dockerAvailable)("T-6.5 places routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let signer: AccessTokenSigner;

  /** Search-miss trigger stub — every enqueue call captured, in order. */
  const enqueued: RegionCell[][] = [];

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
    app = createApp({
      auth: authDeps,
      places: {
        db,
        now: () => FROZEN_NOW,
        // Fixed store clock: one window for the whole suite — the 429 test
        // uses a dedicated user so per-user keying isolates every other test.
        rateLimit: { store: new InMemoryRateLimitStore(), now: () => 1_000_000 },
        placesIngest: {
          enqueueDestination: () => undefined,
          enqueueSearchMiss: (cells) => {
            enqueued.push([...cells]);
          },
        },
      },
    });

    await seedSpine();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `places-${uniq()}@example.com`,
      displayName: "Place Tester",
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
    sourceId: string;
    name: string;
    lat: number;
    lng: number;
    category?: string | null;
  }) {
    const [row] = await db
      .insert(schema.places)
      .values({
        source: input.source,
        sourceId: input.sourceId,
        name: input.name,
        lat: String(input.lat),
        lng: String(input.lng),
        category: input.category ?? null,
      })
      .returning();
    if (!row) throw new Error("spine seed failed");
    return row;
  }

  // Lisbon cluster (text + geo + blend + coarse filter targets).
  const TOWER = { lat: 38.6916, lng: -9.216 };
  const PASTEIS = { lat: 38.6975, lng: -9.2033 };
  const TIMEOUT_MKT = { lat: 38.7067, lng: -9.1459 };
  // Tokyo pagination cluster — distinct distances from its near point.
  const TOKYO = { lat: 35.68, lng: 139.76 };

  let towerId = "";
  let pasteisId = "";
  let timeoutId = "";
  const tokyoIds: string[] = [];

  async function seedSpine() {
    towerId = (
      await seedSpinePlace({
        source: "overture",
        sourceId: "ovt-belem-tower",
        name: "Belém Tower",
        ...TOWER,
        category: "tourist_attraction",
      })
    ).id;
    pasteisId = (
      await seedSpinePlace({
        source: "fsq_os",
        sourceId: "fsq-pasteis",
        name: "Pastéis de Belém",
        ...PASTEIS,
        category: "Dining and Drinking > Bakery",
      })
    ).id;
    timeoutId = (
      await seedSpinePlace({
        source: "overture",
        sourceId: "ovt-time-out",
        name: "Time Out Market",
        ...TIMEOUT_MKT,
        category: "restaurant",
      })
    ).id;
    await seedSpinePlace({
      source: "overture",
      sourceId: "ovt-porto",
      name: "Porto Mercado",
      lat: 41.1579,
      lng: -8.6291,
      category: "restaurant",
    });
    for (let i = 0; i < 5; i++) {
      tokyoIds.push(
        (
          await seedSpinePlace({
            source: "overture",
            sourceId: `ovt-tokyo-${i}`,
            name: `Tokyo Cluster ${i}`,
            lat: TOKYO.lat + 0.0005 * i,
            lng: TOKYO.lng,
            category: null,
          })
        ).id,
      );
    }
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

  const search = (token: string | undefined, query: string) =>
    request(`/api/places/search?${query}`, token);
  const postPlace = (token: string | undefined, body: unknown) =>
    request("/api/places", token, { method: "POST", body: JSON.stringify(body) });
  const patchPlace = (placeId: string, token: string, body: unknown) =>
    request(`/api/places/${placeId}`, token, { method: "PATCH", body: JSON.stringify(body) });
  const deletePlace = (placeId: string, token: string) =>
    request(`/api/places/${placeId}`, token, { method: "DELETE" });

  async function searchOk(token: string, query: string) {
    const res = await search(token, query);
    expect(res.status).toBe(200);
    return PaginatedPlacesSchema.parse(await res.json());
  }

  async function createPlaceVia(
    token: string,
    body: { name: string; lat: number; lng: number; category?: string },
  ): Promise<Place> {
    const res = await postPlace(token, body);
    expect(res.status).toBe(201);
    return PlaceSchema.parse(await res.json());
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

  // ===========================================================================
  // GET /places/search — text / geo / blend / pagination (R-places-6)
  // ===========================================================================

  it("text mode: REAL pg_trgm match + similarity ranking; unrelated names absent", async () => {
    const user = await seedUserWithToken();
    const { items } = await searchOk(user.accessToken, "q=bel%C3%A9m");

    const names = items.map((p) => p.name);
    // Both Belém names match through the real GIN'd `%` operator; the
    // shorter (more similar) name ranks first; Time Out Market is absent.
    expect(names[0]).toBe("Belém Tower");
    expect(names).toContain("Pastéis de Belém");
    expect(names).not.toContain("Time Out Market");
  });

  it("geo mode (near): nearest-first within the radius; outside excluded", async () => {
    const user = await seedUserWithToken();
    const { items } = await searchOk(
      user.accessToken,
      `near=${TOWER.lat},${TOWER.lng}&radius_m=2000`,
    );

    // Tower (0 m) → Pastéis (~1.3 km); Time Out (~6 km) outside the radius.
    expect(items.map((p) => p.id)).toEqual([towerId, pasteisId]);
  });

  it("geo mode (bbox): only rows inside the box", async () => {
    const user = await seedUserWithToken();
    const { items } = await searchOk(user.accessToken, "bbox=-9.25,38.65,-9.19,38.72");
    expect(new Set(items.map((p) => p.id))).toEqual(new Set([towerId, pasteisId]));
  });

  it("blend: similarity dominates, proximity breaks ties (deterministic §3.3 ranking)", async () => {
    const user = await seedUserWithToken();
    // From Time Out Market, Pastéis is CLOSER than the Tower — but the
    // Tower's trigram similarity to the query is higher, and similarity
    // strictly outranks proximity in the blend.
    const { items } = await searchOk(
      user.accessToken,
      `q=bel%C3%A9m&near=${TIMEOUT_MKT.lat},${TIMEOUT_MKT.lng}&radius_m=50000`,
    );
    expect(items.map((p) => p.id)).toEqual([towerId, pasteisId]);
  });

  it("coarse_category filters on the DERIVED category (§3.2.3)", async () => {
    const user = await seedUserWithToken();
    const base = `near=${PASTEIS.lat},${PASTEIS.lng}&radius_m=50000`;

    const food = await searchOk(user.accessToken, `${base}&coarse_category=food`);
    expect(new Set(food.items.map((p) => p.id))).toEqual(new Set([pasteisId, timeoutId]));
    expect(food.items.every((p) => p.coarse_category === "food")).toBe(true);

    const attractions = await searchOk(user.accessToken, `${base}&coarse_category=attraction`);
    expect(attractions.items.map((p) => p.id)).toEqual([towerId]);
  });

  it("pagination: cursor walk is exact — no dup, no skip, order == single page (R-places-6)", async () => {
    const user = await seedUserWithToken();
    const query = `near=${TOKYO.lat},${TOKYO.lng}&radius_m=1000`;

    const full = await searchOk(user.accessToken, `${query}&limit=10`);
    expect(full.items).toHaveLength(5);
    expect(full.nextCursor).toBeNull();
    // Nearest-first: the cluster was seeded at increasing lat offsets.
    expect(full.items.map((p) => p.id)).toEqual(tokyoIds);

    const walked: Place[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await searchOk(
        user.accessToken,
        `${query}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      walked.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(4); // 2+2+1 → 3 pages, never loops
    } while (cursor !== null);

    expect(walked.map((p) => p.id)).toEqual(full.items.map((p) => p.id));
  });

  it("malformed cursor falls back to page 1 (opaque token — trips precedent)", async () => {
    const user = await seedUserWithToken();
    const query = `near=${TOKYO.lat},${TOKYO.lng}&radius_m=1000&limit=2`;
    const page1 = await searchOk(user.accessToken, query);
    const junk = await searchOk(user.accessToken, `${query}&cursor=not-a-cursor`);
    expect(junk.items.map((p) => p.id)).toEqual(page1.items.map((p) => p.id));
  });

  it("error cases: no criteria / bad bbox / oversized radius / limit cap → 400", async () => {
    const user = await seedUserWithToken();
    for (const query of [
      "", // no criteria
      "coarse_category=food", // filters alone are not criteria
      "bbox=1,2,3", // malformed bbox (arity)
      "bbox=-9,38.5,-9.5,39", // inverted bbox
      "near=38.7,-9.14&radius_m=50001", // oversized radius
      "q=belem&radius_m=100", // radius without near
      "q=belem&limit=51", // page-size cap
      "q=a", // sub-minimum text
    ]) {
      const res = await search(user.accessToken, query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("unauthenticated search → 401 (app-wide guard)", async () => {
    const res = await search(undefined, "q=belem");
    expect(res.status).toBe(401);
  });

  // ===========================================================================
  // Search-miss trigger (R-places-7) + enqueue bounds (T-6.4 defer)
  // ===========================================================================

  it("coverage miss: partial results still 200 AND stale cells enqueue; fresh coverage does not; staleness re-triggers", async () => {
    const user = await seedUserWithToken();
    const query = "bbox=139.75,35.67,139.77,35.69"; // exactly cell r:71:279
    const cellKey = regionCellAt(35.68, 139.76).key;
    expect(cellKey).toBe("r:71:279");

    // 1) Never-ingested area: results from whatever the spine holds + enqueue.
    let before = enqueued.length;
    const missed = await searchOk(user.accessToken, query);
    expect(missed.items.length).toBeGreaterThan(0); // degrades, never errors
    expect(enqueued.length).toBe(before + 1);
    expect(enqueued[enqueued.length - 1]!.map((c) => c.key)).toEqual([cellKey]);

    // 2) Fresh full-source coverage: no enqueue.
    for (const source of SPINE_SOURCE_PRIORITY) {
      await db.insert(schema.placeIngestRegions).values({
        regionKey: cellKey,
        source,
        minLat: "35.5",
        minLng: "139.5",
        maxLat: "36",
        maxLng: "140",
        status: "ready",
        ingestedAt: FROZEN_NOW,
        rowCount: 5,
      });
    }
    before = enqueued.length;
    await searchOk(user.accessToken, query);
    expect(enqueued.length).toBe(before);

    // 3) Past the refresh window (R-places-5): stale again → enqueue again.
    await db
      .update(schema.placeIngestRegions)
      .set({ ingestedAt: new Date(FROZEN_NOW.getTime() - 91 * DAY_MS) })
      .where(eq(schema.placeIngestRegions.regionKey, cellKey));
    before = enqueued.length;
    await searchOk(user.accessToken, query);
    expect(enqueued.length).toBe(before + 1);
    expect(enqueued[enqueued.length - 1]!.map((c) => c.key)).toEqual([cellKey]);
  });

  it("a single source stale ⇒ still a miss (full-source coverage required)", async () => {
    const user = await seedUserWithToken();
    // Reuse the r:71:279 rows: overture fresh again, fsq_os left stale.
    await db
      .update(schema.placeIngestRegions)
      .set({ ingestedAt: FROZEN_NOW })
      .where(eq(schema.placeIngestRegions.source, "overture"));
    const before = enqueued.length;
    await searchOk(user.accessToken, "bbox=139.75,35.67,139.77,35.69");
    expect(enqueued.length).toBe(before + 1);
  });

  it("globe-pan bbox is hard-capped at PLACES_SEARCH_MISS_MAX_CELLS cells (enqueue-volume bound)", async () => {
    const user = await seedUserWithToken();
    const before = enqueued.length;
    await searchOk(user.accessToken, "bbox=-170,-80,170,80");
    expect(enqueued.length).toBe(before + 1);
    const cells = enqueued[enqueued.length - 1]!;
    expect(cells.length).toBe(PLACES_SEARCH_MISS_MAX_CELLS);
  });

  it("text-only search never enqueues (R-places-7 is geo-scoped)", async () => {
    const user = await seedUserWithToken();
    const before = enqueued.length;
    await searchOk(user.accessToken, "q=bel%C3%A9m");
    expect(enqueued.length).toBe(before);
  });

  it("per-user search rate limit charges and 429s past the window (RATE_LIMITS.placesSearch)", async () => {
    const user = await seedUserWithToken();
    // Criteria-less requests: the limiter sits BEFORE validation, so even
    // 400-spam charges the window (flood-penalizing by design).
    for (let i = 0; i < RATE_LIMITS.placesSearch.limit; i++) {
      const res = await search(user.accessToken, "");
      expect(res.status).toBe(400);
    }
    const limited = await search(user.accessToken, "q=belem");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(((await limited.json()) as ErrorEnvelope).error.code).toBe("RATE_LIMITED");

    // Per-user keying: an untouched user is unaffected.
    const other = await seedUserWithToken();
    const ok = await search(other.accessToken, "q=belem");
    expect(ok.status).toBe(200);
  });

  // ===========================================================================
  // Custom-place visibility (R-places-8 — Law #3 posture)
  // ===========================================================================

  it("visibility matrix: creator sees; stranger never; trip_id widens ONLY that trip's referenced places to ONLY its members", async () => {
    const creator = await seedUserWithToken();
    const coMember = await seedUserWithToken();
    const otherTripper = await seedUserWithToken();

    const mom = await createPlaceVia(creator.accessToken, {
      name: "Mom's House",
      lat: 35.601,
      lng: 139.601,
      category: "family home",
    });
    const nearMom = "near=35.601,139.601&radius_m=500";

    // Creator: visible with no trip scope.
    expect(
      (await searchOk(creator.accessToken, nearMom)).items.map((p) => p.id),
    ).toEqual([mom.id]);
    // Stranger: byte-for-byte absent ("Mom's house" never appears in
    // strangers' searches — R-places-8's own example).
    expect((await searchOk(coMember.accessToken, nearMom)).items).toEqual([]);

    // Reference it in the creator+coMember trip.
    const trip = await seedTrip(creator.userId);
    await db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: coMember.userId, role: "viewer" });
    await db
      .insert(schema.savedPlaces)
      .values({ tripId: trip.id, placeId: mom.id, createdBy: creator.userId });

    // Co-member WITH the trip scope: visible (trip-referenced, R-places-8).
    expect(
      (await searchOk(coMember.accessToken, `${nearMom}&trip_id=${trip.id}`)).items.map(
        (p) => p.id,
      ),
    ).toEqual([mom.id]);
    // Co-member WITHOUT the scope: still absent — the search door only
    // widens under an explicit, membership-checked trip scope.
    expect((await searchOk(coMember.accessToken, nearMom)).items).toEqual([]);

    // Other-trip member scoping THEIR OWN trip: absent — visibility never
    // crosses the trip boundary via an unrelated membership.
    const otherTrip = await seedTrip(otherTripper.userId);
    expect(
      (await searchOk(otherTripper.accessToken, `${nearMom}&trip_id=${otherTrip.id}`)).items,
    ).toEqual([]);

    // Non-member trip_id: the indistinguishable 404 — the search door can't
    // confirm the trip exists (F-038 property, same envelope byte-for-byte).
    await expectIndistinguishable404s([
      await search(otherTripper.accessToken, `${nearMom}&trip_id=${trip.id}`),
      await search(otherTripper.accessToken, `${nearMom}&trip_id=${NONEXISTENT_UUID}`),
    ]);

    // Malformed trip_id is boundary validation (400) — a value that can
    // never name a real trip reveals nothing (shared-schema door, not the
    // membership gate).
    const malformed = await search(otherTripper.accessToken, `${nearMom}&trip_id=nope`);
    expect(malformed.status).toBe(400);
  });

  it("itinerary and booking references widen visibility under the trip scope too (R-places-8)", async () => {
    const creator = await seedUserWithToken();
    const member = await seedUserWithToken();
    const trip = await seedTrip(creator.userId);
    await db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: member.userId, role: "editor" });

    const picnic = await createPlaceVia(creator.accessToken, {
      name: "Secret Picnic Spot",
      lat: 35.611,
      lng: 139.611,
      category: "hilltop picnic area",
    });
    const dinner = await createPlaceVia(creator.accessToken, {
      name: "Secret Dinner Spot",
      lat: 35.6115,
      lng: 139.6115,
    });
    await db.insert(schema.itineraryItems).values({
      tripId: trip.id,
      kind: "place_visit",
      placeId: picnic.id,
      day: "2026-08-02",
      createdBy: creator.userId,
    });
    await db.insert(schema.bookings).values({
      tripId: trip.id,
      category: "restaurant",
      title: "Secret dinner",
      placeId: dinner.id,
      createdBy: creator.userId,
    });

    const nearSpots = "near=35.611,139.611&radius_m=300";
    expect((await searchOk(member.accessToken, nearSpots)).items).toEqual([]);
    const scoped = await searchOk(member.accessToken, `${nearSpots}&trip_id=${trip.id}`);
    expect(new Set(scoped.items.map((p) => p.id))).toEqual(new Set([picnic.id, dinner.id]));
  });

  // ===========================================================================
  // POST /places (R-places-9)
  // ===========================================================================

  it("POST: creates source='custom', source_id NULL, created_by=caller, coarse derived", async () => {
    const user = await seedUserWithToken();
    const place = await createPlaceVia(user.accessToken, {
      name: "Ramen Alley Favorite",
      lat: 35.66,
      lng: 139.7,
      category: "late-night ramen restaurant",
    });

    expect(place.source).toBe("custom");
    expect(place.source_id).toBeNull();
    expect(place.created_by).toBe(user.userId);
    expect(place.coarse_category).toBe("food");
    expect(place.lat).toBeCloseTo(35.66, 6);

    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(row?.source).toBe("custom");
    expect(row?.sourceId).toBeNull();
    expect(row?.createdBy).toBe(user.userId);
  });

  it("POST error cases: blank name, out-of-range coords, uncapped name → 400; no token → 401", async () => {
    const user = await seedUserWithToken();
    for (const body of [
      { name: "   ", lat: 35, lng: 139 },
      { name: "Ok", lat: 90.1, lng: 139 },
      { name: "Ok", lat: 35, lng: -180.5 },
      { name: "x".repeat(201), lat: 35, lng: 139 },
    ]) {
      const res = await postPlace(user.accessToken, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    }
    expect((await postPlace(undefined, { name: "Ok", lat: 35, lng: 139 })).status).toBe(401);
  });

  // ===========================================================================
  // PATCH /places/:placeId (R-places-10)
  // ===========================================================================

  it("PATCH: creator edits name/coords; category:null clears (coarse follows); empty patch is a no-op read", async () => {
    const user = await seedUserWithToken();
    const place = await createPlaceVia(user.accessToken, {
      name: "Draft Spot",
      lat: 35.62,
      lng: 139.62,
      category: "ramen restaurant",
    });
    expect(place.coarse_category).toBe("food");

    const res = await patchPlace(place.id, user.accessToken, {
      name: "Final Spot",
      lat: 35.625,
      category: null,
    });
    expect(res.status).toBe(200);
    const updated = PlaceSchema.parse(await res.json());
    expect(updated.name).toBe("Final Spot");
    expect(updated.lat).toBeCloseTo(35.625, 6);
    expect(updated.lng).toBeCloseTo(139.62, 6);
    expect(updated.category).toBeNull();
    expect(updated.coarse_category).toBe("other");

    // Empty patch: 200 with the current row, updated_at untouched.
    const noop = await patchPlace(place.id, user.accessToken, {});
    expect(noop.status).toBe(200);
    expect(PlaceSchema.parse(await noop.json()).updated_at).toBe(updated.updated_at);
  });

  it("PATCH authz: spine → 403 for everyone; visible non-creator → 403; invalid coords → 400", async () => {
    const creator = await seedUserWithToken();
    const coMember = await seedUserWithToken();

    // Spine places reject mutation for EVERYONE (R-places-10).
    const spineRes = await patchPlace(towerId, creator.accessToken, { name: "Hacked Tower" });
    expect(spineRes.status).toBe(403);
    expect(((await spineRes.json()) as ErrorEnvelope).error.code).toBe("FORBIDDEN");

    // A co-member who can SEE the place via a trip reference still can't
    // edit it — 403 is safe: the reference already proved existence to them.
    const place = await createPlaceVia(creator.accessToken, {
      name: "Shared Sight",
      lat: 35.63,
      lng: 139.63,
    });
    const trip = await seedTrip(creator.userId);
    await db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: coMember.userId, role: "editor" });
    await db
      .insert(schema.savedPlaces)
      .values({ tripId: trip.id, placeId: place.id, createdBy: creator.userId });

    const forbidden = await patchPlace(place.id, coMember.accessToken, { name: "Mine Now" });
    expect(forbidden.status).toBe(403);

    const badBody = await patchPlace(place.id, creator.accessToken, { lat: 91 });
    expect(badBody.status).toBe(400);
  });

  it("PATCH F-038 harness: invisible custom ≡ nonexistent ≡ malformed id — byte-identical 404s", async () => {
    const creator = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const hidden = await createPlaceVia(creator.accessToken, {
      name: "Hidden Cabin",
      lat: 35.64,
      lng: 139.64,
    });

    const body = JSON.stringify({ name: "Probe" });
    const probe = (placeId: string) =>
      request(`/api/places/${placeId}`, stranger.accessToken, { method: "PATCH", body });
    await expectIndistinguishable404s([
      await probe(hidden.id), // exists, invisible to the caller
      await probe(NONEXISTENT_UUID), // does not exist
      await probe("not-a-uuid"), // malformed id, same door
    ]);
    // And the probe wrote nothing.
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, hidden.id));
    expect(row?.name).toBe("Hidden Cabin");
  });

  // ===========================================================================
  // DELETE /places/:placeId (R-places-10)
  // ===========================================================================

  it("DELETE: unreferenced custom place → 204 and gone", async () => {
    const user = await seedUserWithToken();
    const place = await createPlaceVia(user.accessToken, {
      name: "Throwaway",
      lat: 35.65,
      lng: 139.65,
    });

    const res = await deletePlace(place.id, user.accessToken);
    expect(res.status).toBe(204);
    const rows = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(rows).toEqual([]);
    // A second delete converges on the indistinguishable 404.
    expect((await deletePlace(place.id, user.accessToken)).status).toBe(404);
  });

  it("DELETE: RESTRICT references → 409 CONFLICT naming the referencer, never a 500", async () => {
    const user = await seedUserWithToken();
    const trip = await seedTrip(user.userId);

    const saved = await createPlaceVia(user.accessToken, {
      name: "Pinned Spot",
      lat: 35.66,
      lng: 139.66,
    });
    await db
      .insert(schema.savedPlaces)
      .values({ tripId: trip.id, placeId: saved.id, createdBy: user.userId });
    const savedRes = await deletePlace(saved.id, user.accessToken);
    expect(savedRes.status).toBe(409);
    const savedBody = (await savedRes.json()) as ErrorEnvelope;
    expect(savedBody.error.code).toBe("CONFLICT");
    expect(savedBody.error.details).toEqual({ reason: "place_referenced", by: "saved_places" });

    const visited = await createPlaceVia(user.accessToken, {
      name: "Visited Spot",
      lat: 35.67,
      lng: 139.67,
    });
    await db.insert(schema.itineraryItems).values({
      tripId: trip.id,
      kind: "place_visit",
      placeId: visited.id,
      day: "2026-08-03",
      createdBy: user.userId,
    });
    const visitedRes = await deletePlace(visited.id, user.accessToken);
    expect(visitedRes.status).toBe(409);
    expect(((await visitedRes.json()) as ErrorEnvelope).error.details).toEqual({
      reason: "place_referenced",
      by: "itinerary_items",
    });
  });

  it("DELETE: a booking reference does NOT block (SET NULL, outside the R-places-10 RESTRICT set)", async () => {
    const user = await seedUserWithToken();
    const trip = await seedTrip(user.userId);
    const place = await createPlaceVia(user.accessToken, {
      name: "Booked Spot",
      lat: 35.68,
      lng: 139.6805,
    });
    const [booking] = await db
      .insert(schema.bookings)
      .values({
        tripId: trip.id,
        category: "restaurant",
        title: "Dinner",
        placeId: place.id,
        createdBy: user.userId,
      })
      .returning();

    expect((await deletePlace(place.id, user.accessToken)).status).toBe(204);
    const [after] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking!.id));
    expect(after?.placeId).toBeNull();
  });

  it("DELETE authz: spine → 403; visible non-creator → 403; F-038 harness on the invisible door", async () => {
    const creator = await seedUserWithToken();
    const coMember = await seedUserWithToken();
    const stranger = await seedUserWithToken();

    expect((await deletePlace(towerId, creator.accessToken)).status).toBe(403);

    const place = await createPlaceVia(creator.accessToken, {
      name: "Shared Keeper",
      lat: 35.69,
      lng: 139.69,
    });
    const trip = await seedTrip(creator.userId);
    await db
      .insert(schema.tripMembers)
      .values({ tripId: trip.id, userId: coMember.userId, role: "editor" });
    await expectIndistinguishable404s([
      await deletePlace(place.id, stranger.accessToken), // exists, invisible
      await deletePlace(NONEXISTENT_UUID, stranger.accessToken),
      await deletePlace("not-a-uuid", stranger.accessToken),
    ]);

    await db
      .insert(schema.savedPlaces)
      .values({ tripId: trip.id, placeId: place.id, createdBy: creator.userId });
    expect((await deletePlace(place.id, coMember.accessToken)).status).toBe(403);

    // Nothing above deleted it.
    const rows = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(rows).toHaveLength(1);
  });

  // ===========================================================================
  // Plan-shape pins (T-6.4 sargability precedent) + JS↔SQL coarse parity
  // ===========================================================================

  async function explainSearch(params: Parameters<typeof placesSearchQuery>[1]) {
    const { sql: text, params: values } = placesSearchQuery(db, params).toSQL();
    const planRows = await client.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx.unsafe(`explain (costs false) ${text}`, values as never[]);
    });
    return planRows.map((row) => String(Object.values(row as object)[0])).join("\n");
  }

  it("text mode drives the pg_trgm GIN (`%` operator) — never a seq scan (EXPLAIN pin)", async () => {
    const user = await seedUserWithToken();
    const plan = await explainSearch({ userId: user.userId, q: "belém", limit: 21 });
    expect(plan).toContain("places_name_trgm_idx");
    expect(plan).not.toMatch(/Seq Scan on places\b/);
  });

  it("geo mode drives places_lat_lng_idx with bare-column probes (EXPLAIN pin)", async () => {
    const user = await seedUserWithToken();
    const plan = await explainSearch({
      userId: user.userId,
      near: { lat: 38.6916, lng: -9.216, radiusM: 2000 },
      limit: 21,
    });
    expect(plan).toContain("places_lat_lng_idx");
    expect(plan).not.toMatch(/Seq Scan on places\b/);
  });

  it("SQL coarse mapping ≡ shared JS mapping over every seeded category (parity pin)", async () => {
    const rows = await db
      .select({
        source: schema.places.source,
        category: schema.places.category,
        sqlCoarse: coarseCategorySqlExpr(schema.places.category),
      })
      .from(schema.places);
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) {
      expect(row.sqlCoarse).toBe(coarseCategory(row.source, row.category));
    }
  });
});
