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
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import { coarseCategory, PlaceSchema, type Place } from "@gogo/shared/domains/place";
import { regionCellAt, type RegionCell } from "@gogo/shared/region-grid";
import { SPINE_SOURCE_PRIORITY } from "@gogo/shared/config/places";
import type { PlaceSource } from "@gogo/shared/enums";
import { PLACES_SEARCH_MISS_MAX_CELLS, RATE_LIMITS } from "../config.js";
import { createApp } from "../app.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import { isCheckViolationOf } from "../db/pg-errors.js";
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
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place now: src/test/global-setup.ts (T-S3.3 shared container; the
// `--no-file-parallelism` workaround is retired — QUEUE P1).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Frozen server clock — drives region-freshness in the coverage check. */
const FROZEN_NOW = new Date("2026-07-26T12:00:00.000Z");

const PaginatedPlacesSchema = paginatedSchema(PlaceSchema);

describe.skipIf(!dockerAvailable)("T-6.5 places routes (integration)", () => {
  let suiteDb: SuiteDb;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let signer: AccessTokenSigner;

  /** Search-miss trigger stub — every enqueue call captured, in order. */
  const enqueued: RegionCell[][] = [];
  /** Background coverage tasks (round-1 #9: the probe runs OFF the response
   * path) — collected via the router's settle seam so enqueue assertions,
   * positive AND negative, are deterministic. */
  const coverageTasks: Promise<void>[] = [];
  /** Await every outstanding coverage task (strays from earlier searches
   * included) — call before snapshotting AND before asserting `enqueued`. */
  const settleCoverage = async () => {
    await Promise.all(coverageTasks.splice(0));
  };

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("places_routes");
    client = suiteDb.client;
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
        trackCoverageTask: (task) => {
          coverageTasks.push(task);
        },
      },
    });

    await seedSpine();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
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
  // Moved off the real Tokyo/23-wards coordinates (B-7's destination-tier
  // migration seeded Tokyo AND several wards as real global spine rows —
  // the original 35.68,139.76 anchor sat ~500m from the real Tokyo row and
  // every candidate nearby anchor sat within 1-2km of some other ward);
  // this point (Ibaraki prefecture, ~16km from the nearest real tier row,
  // Tsuchiura) keeps the "somewhere in the Tokyo area" flavor with a safe
  // margin for the 1km-radius queries below.
  const TOKYO = { lat: 36.2, lng: 140.3 };

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
    // B-7 destination tier (migration 0004) seeded the REAL city of Belém,
    // Brazil into the global spine — an exact (case-aside) match for
    // "belém" outranks the "Belém Tower"/"Pastéis de Belém" substring
    // matches, so it is now the top hit; both test fixtures still match
    // through the real GIN'd `%` operator, and the unrelated fixture is
    // still absent.
    expect(names[0]).toBe("Belém");
    expect(names).toContain("Belém Tower");
    expect(names).toContain("Pastéis de Belém");
    // Round-1 review advisory A5: restores the ordering this test is NAMED
    // for ("similarity ranking") — the shorter, more-similar fixture name
    // ("Belém Tower") still outranks the longer one ("Pastéis de Belém").
    expect(names.indexOf("Belém Tower")).toBeLessThan(names.indexOf("Pastéis de Belém"));
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

  it("tied-rank pagination: identical rank keys page exactly on the id tiebreak (row-compare pin)", async () => {
    // Five IDENTICALLY-NAMED rows under a text-only search share ONE rank
    // key — the page boundary falls entirely on the id half of the
    // (rank, id) row-value predicate. This pins the tuple comparison
    // against reverts to a rank-only (or non-strict) cursor predicate,
    // which the distance-walk test can never catch.
    const user = await seedUserWithToken();
    for (let i = 0; i < 5; i++) {
      await seedSpinePlace({
        source: "overture",
        sourceId: `ovt-dup-${i}`,
        name: "Duplicate Diner",
        lat: -33.9 + 0.001 * i,
        lng: 18.4,
        category: "restaurant",
      });
    }

    const full = await searchOk(user.accessToken, "q=duplicate&limit=10");
    expect(full.items).toHaveLength(5);
    expect(new Set(full.items.map((p) => p.name))).toEqual(new Set(["Duplicate Diner"]));

    const walked: Place[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await searchOk(
        user.accessToken,
        `q=duplicate&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      walked.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(4); // 2+2+1 → 3 pages, never loops
    } while (cursor !== null);

    // Exact: no duplicate, no drop, same order as the single-page truth.
    expect(walked.map((p) => p.id)).toEqual(full.items.map((p) => p.id));
  });

  it("short q (2–3 chars) is accepted WITH a geo bound (trigram/blend arm); text-only is ALSO accepted (B-7 follow-up, 2026-09-14, R-places-28) but runs the exact-match tier arm instead — 200 either way (falsification: reverting the routes.ts arm branch turns the text-only case back into 400)", async () => {
    const user = await seedUserWithToken();
    // Map typeahead: 2-char q + near → valid request (spec's 2-char floor),
    // unaffected by the B-7 follow-up (still the geo-bounded arm).
    const withGeo = await search(user.accessToken, `q=be&near=${TOWER.lat},${TOWER.lng}`);
    expect(withGeo.status).toBe(200);
    // The same q with NO geo bound: no longer 400 — the exact-match tier
    // arm runs instead (this suite's fixtures don't seed a real "abc" tier
    // row, so the honest expectation is 200 + empty, not a specific hit;
    // `destination-tier.db.test.ts` pins the positive-match cases).
    const textOnly = await search(user.accessToken, "q=abc");
    expect(textOnly.status).toBe(200);
    const page = PaginatedPlacesSchema.parse(await textOnly.json());
    expect(page.items).toEqual([]);
  });

  it("oversized bbox CLAMPS to the centered max-span window instead of scanning the world", async () => {
    const user = await seedUserWithToken();
    // Isolated corner of the Indian Ocean: one row inside the clamp window,
    // one inside the ORIGINAL box but outside the window.
    const inWindow = await seedSpinePlace({
      source: "overture",
      sourceId: "ovt-clamp-in",
      name: "Clamp Window Reef",
      lat: -30,
      lng: 70,
      category: null,
    });
    await seedSpinePlace({
      source: "overture",
      sourceId: "ovt-clamp-out",
      name: "Clamp Outside Atoll",
      lat: -25,
      lng: 75,
      category: null,
    });

    // 20°×20° box centered on (70, -30) → clamped window ±1° around center.
    const { items } = await searchOk(user.accessToken, "bbox=60,-40,80,-20");
    expect(items.map((p) => p.id)).toEqual([inWindow.id]);
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
      "q=a", // sub-minimum text (below the ABSOLUTE 2-char floor)
      // NOTE: "q=abc" (sub-text-only-floor, no geo bound) is DELIBERATELY
      // absent here — B-7 follow-up (2026-09-14, R-places-28) moved it to
      // 200 (exact-match tier arm), not 400. See the dedicated test above.
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

    // Round-1 review advisory A4: this bbox now also contains the REAL
    // Tokyo tier row (B-7 migration 0004, 35.676857,139.763885) — the
    // "partial results still 200" assertion below used to be
    // `length > 0`, which the tier row alone satisfies, silently making
    // this suite's own precondition load-bearing on upstream Overture data
    // instead of on a fixture it owns. Seed one and assert ON it.
    const coverageMissFixture = await seedSpinePlace({
      source: "overture",
      sourceId: "ovt-coverage-miss-fixture",
      name: "Coverage Miss Fixture",
      lat: 35.685,
      lng: 139.755,
      category: null,
    });

    // 1) Never-ingested area: results from whatever the spine holds + enqueue.
    await settleCoverage(); // drain strays from earlier geo searches
    let before = enqueued.length;
    const missed = await searchOk(user.accessToken, query);
    await settleCoverage();
    // Degrades, never errors — and owns its own precondition (the fixture
    // above), not an incidental real-data row.
    expect(missed.items.some((p) => p.id === coverageMissFixture.id)).toBe(true);
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
    await settleCoverage();
    expect(enqueued.length).toBe(before);

    // 3) Past the refresh window (R-places-5): stale again → enqueue again.
    await db
      .update(schema.placeIngestRegions)
      .set({ ingestedAt: new Date(FROZEN_NOW.getTime() - 91 * DAY_MS) })
      .where(eq(schema.placeIngestRegions.regionKey, cellKey));
    before = enqueued.length;
    await searchOk(user.accessToken, query);
    await settleCoverage();
    expect(enqueued.length).toBe(before + 1);
    expect(enqueued[enqueued.length - 1]!.map((c) => c.key)).toEqual([cellKey]);
  });

  it("a single source stale ⇒ still a miss (full-source coverage required)", async () => {
    const user = await seedUserWithToken();
    // This test's OWN cell (round-1 #8: self-seeded, no cross-test row
    // mutation): overture fresh, fsq_os stale from the start.
    const cellKey = regionCellAt(34.68, 138.76).key;
    expect(cellKey).toBe("r:69:277");
    await db.insert(schema.placeIngestRegions).values(
      SPINE_SOURCE_PRIORITY.map((source) => ({
        regionKey: cellKey,
        source,
        minLat: "34.5",
        minLng: "138.5",
        maxLat: "35",
        maxLng: "139",
        status: "ready",
        ingestedAt:
          source === "overture" ? FROZEN_NOW : new Date(FROZEN_NOW.getTime() - 91 * DAY_MS),
        rowCount: 0,
      })),
    );

    await settleCoverage();
    const before = enqueued.length;
    await searchOk(user.accessToken, "bbox=138.75,34.67,138.77,34.69");
    await settleCoverage();
    expect(enqueued.length).toBe(before + 1);
    expect(enqueued[enqueued.length - 1]!.map((c) => c.key)).toEqual([cellKey]);
  });

  it("globe-pan bbox is hard-capped at PLACES_SEARCH_MISS_MAX_CELLS cells (enqueue-volume bound)", async () => {
    const user = await seedUserWithToken();
    await settleCoverage();
    const before = enqueued.length;
    await searchOk(user.accessToken, "bbox=-170,-80,170,80");
    await settleCoverage();
    expect(enqueued.length).toBe(before + 1);
    const cells = enqueued[enqueued.length - 1]!;
    expect(cells.length).toBe(PLACES_SEARCH_MISS_MAX_CELLS);
  });

  it("text-only search never enqueues (R-places-7 is geo-scoped)", async () => {
    const user = await seedUserWithToken();
    await settleCoverage();
    const before = enqueued.length;
    await searchOk(user.accessToken, "q=bel%C3%A9m");
    await settleCoverage();
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
    expect((await searchOk(creator.accessToken, nearMom)).items.map((p) => p.id)).toEqual([mom.id]);
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
  // B-7 part 3: nullable coordinates for custom places
  // ===========================================================================

  it("[B-7 part 3] POST: omitting BOTH lat/lng creates a coordinate-less custom place — 201 with null, never 0", async () => {
    const user = await seedUserWithToken();
    const res = await postPlace(user.accessToken, { name: "Grandma's cabin" });
    expect(res.status).toBe(201);
    const place = PlaceSchema.parse(await res.json());
    expect(place.lat).toBeNull();
    expect(place.lng).toBeNull();
    expect(place.source).toBe("custom");

    // The DB row itself is NULL, not the string "0" (S2 pin).
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(row?.lat).toBeNull();
    expect(row?.lng).toBeNull();
    // Falsification: restore `lat: String(body.lat)` unconditionally at
    // places/routes.ts's insert — `String(undefined) === "undefined"`, a
    // numeric-column write that throws at the driver, and this whole test
    // reds with a 500 instead of a 201.
  });

  it("[B-7 part 3] POST: exactly one of lat/lng present → 400 (the pair moves together)", async () => {
    const user = await seedUserWithToken();
    expect((await postPlace(user.accessToken, { name: "Half a place", lat: 35.6 })).status).toBe(
      400,
    );
    expect((await postPlace(user.accessToken, { name: "Half a place", lng: 139.7 })).status).toBe(
      400,
    );
  });

  it("[B-7 part 3] PATCH: a map-drop onto a coordinate-less custom place sets real coordinates (the P-8 follow-up seam stays open)", async () => {
    const user = await seedUserWithToken();
    const created = await postPlace(user.accessToken, { name: "Someday cabin" });
    const place = PlaceSchema.parse(await created.json());
    expect(place.lat).toBeNull();

    const patched = await patchPlace(place.id, user.accessToken, { lat: 35.61, lng: 139.61 });
    expect(patched.status).toBe(200);
    const updated = PlaceSchema.parse(await patched.json());
    expect(updated.lat).toBeCloseTo(35.61, 6);
    expect(updated.lng).toBeCloseTo(139.61, 6);
  });

  it("[B-7 part 3] search: a coordinate-less custom place is found by TEXT-ONLY search, and invisible to bbox/near (R-places-27)", async () => {
    const user = await seedUserWithToken();
    const created = await postPlace(user.accessToken, {
      name: `Nullisland Cabin ${uniq()}`,
    });
    const place = PlaceSchema.parse(await created.json());
    expect(place.lat).toBeNull();

    // Text-only: found, ranked by text similarity alone.
    const textHit = await searchOk(user.accessToken, `q=${encodeURIComponent(place.name)}`);
    expect(textHit.items.map((p) => p.id)).toContain(place.id);

    // A bbox covering (0,0) — a coordinate-less row can never satisfy
    // `lat/lng BETWEEN ...` (NULL BETWEEN is never true) — absent.
    const bboxHit = await searchOk(
      user.accessToken,
      `q=${encodeURIComponent(place.name)}&bbox=-1,-1,1,1`,
    );
    expect(bboxHit.items.map((p) => p.id)).not.toContain(place.id);

    // Law #3 pin: text-only visibility is STILL R-places-8-gated — a
    // stranger never sees it, coordinate-less or not (only the geo BETWEEN
    // exclusion is new; the visibility predicate is unchanged, R-places-6).
    const stranger = await seedUserWithToken();
    const strangerHit = await searchOk(stranger.accessToken, `q=${encodeURIComponent(place.name)}`);
    expect(strangerHit.items.map((p) => p.id)).not.toContain(place.id);
    // Falsification: drop the `createdBy = userId` arm from the visibility
    // predicate (search-query.ts) — this reds ("Mom's house" reappears in a
    // stranger's search).

    // Same for `near`.
    const nearHit = await searchOk(
      user.accessToken,
      `q=${encodeURIComponent(place.name)}&near=0,0&radius_m=50000`,
    );
    expect(nearHit.items.map((p) => p.id)).not.toContain(place.id);
    // Falsification: change the bbox/near BETWEEN predicates in
    // search-query.ts to `lat IS NULL OR lat BETWEEN ...` — the bbox/near
    // assertions above go red (the row reappears where it must not).
  });

  it("[B-7 part 3] search: a text-only page containing a coordinate-less row still paginates (cursor round-trip)", async () => {
    const user = await seedUserWithToken();
    const stem = `Nullpage${uniq()}`;
    const noCoordsName = `${stem} Alpha`;
    const withCoordsName = `${stem} Beta`;
    const noCoords = PlaceSchema.parse(
      await (await postPlace(user.accessToken, { name: noCoordsName })).json(),
    );
    const withCoords = PlaceSchema.parse(
      await (
        await postPlace(user.accessToken, { name: withCoordsName, lat: 35.5, lng: 139.5 })
      ).json(),
    );

    const page1 = await searchOk(user.accessToken, `q=${encodeURIComponent(stem)}&limit=1`);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await search(
      user.accessToken,
      `q=${encodeURIComponent(stem)}&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    expect(page2Res.status).toBe(200);
    const page2 = PaginatedPlacesSchema.parse(await page2Res.json());
    expect(page2.items).toHaveLength(1);

    // No duplicate, no drop — both rows appear across the two pages exactly once.
    const seen = [...page1.items, ...page2.items].map((p) => p.id).sort();
    expect(seen).toEqual([noCoords.id, withCoords.id].sort());
    // Falsification note (round-1 fix — the original claim here was
    // INERT, on two counts): this test's query is `q`-only, no `near`/
    // `bbox` — `anchor` is null, so `proxTerm` takes the `: sql\`0::bigint\``
    // fallback and never touches `distanceM`/`greatest` at all; separately,
    // the `coalesce(greatest(...), 0::bigint)` this test used to reference
    // was PROVEN dead code regardless (`greatest`'s first argument is
    // always the literal `0::bigint`, and Postgres's GREATEST/LEAST return
    // NULL only when EVERY argument is NULL — so it can never return NULL
    // to coalesce) and has been removed (search-query.ts). This pin's real,
    // still-valid job: prove a coordinate-less row coexists correctly with
    // a located one across a keyset-paginated text search — no duplicate,
    // no drop. Falsification: change the cursor predicate's `<` to `<=`
    // (search-query.ts) — the boundary row reappears on page 2, and `seen`
    // above gains a duplicate id while `page2.items` still has length 1,
    // failing the `toEqual` sorted-array comparison.
  });

  it("[B-7 part 3] DB CHECK: places_coords_pair_ck rejects half a coordinate; places_spine_coords_ck rejects a null-coord spine row (23514)", async () => {
    await expect(
      db.insert(schema.places).values({
        source: "custom",
        name: "Half pair direct insert",
        lat: "35.6",
        lng: null,
      }),
    ).rejects.toSatisfy((err: unknown) => isCheckViolationOf(err, "places_coords_pair_ck"));

    await expect(
      db.insert(schema.places).values({
        source: "overture",
        sourceId: `ovt-null-${uniq()}`,
        name: "Spine row with no coordinates",
        lat: null,
        lng: null,
      }),
    ).rejects.toSatisfy((err: unknown) => isCheckViolationOf(err, "places_spine_coords_ck"));
    // Falsification: drop either CHECK from the migration — the matching
    // assertion above reds (the insert succeeds instead of throwing).
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

    // B-7 part 3 round-1 fix: lat/lng move as a PAIR on a PATCH now (the
    // architecture blocking finding — a lone `lat` here used to silently
    // relocate half the coordinate, 200, `lng` untouched); both fields ride
    // together in every request from here on.
    const res = await patchPlace(place.id, user.accessToken, {
      name: "Final Spot",
      lat: 35.625,
      lng: 139.625,
      category: null,
    });
    expect(res.status).toBe(200);
    const updated = PlaceSchema.parse(await res.json());
    expect(updated.name).toBe("Final Spot");
    expect(updated.lat).toBeCloseTo(35.625, 6);
    expect(updated.lng).toBeCloseTo(139.625, 6);
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

  // ===========================================================================
  // PATCH pair rule (B-7 part 3 round-1 fix, architecture blocking finding):
  // `PlaceUpdateSchema` had no `superRefine` at all — a lone `lat` in a PATCH
  // reached the DB unpaired, where `places_coords_pair_ck` was the only
  // backstop and its escape was an unhandled 500 on a coordinate-less
  // custom place, or a SILENT RELOCATION (200, half the pair moved) on a
  // located one.
  // ===========================================================================

  it("[B-7 part 3 R1] PATCH: a lone lat on a coordinate-less custom place → 400, never 500", async () => {
    const user = await seedUserWithToken();
    const place = await postPlace(user.accessToken, { name: "No Coords Yet" });
    const created = PlaceSchema.parse(await place.json());
    expect(created.lat).toBeNull();

    const res = await patchPlace(created.id, user.accessToken, { lat: 35.61 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, created.id));
    expect(row?.lat).toBeNull();
    expect(row?.lng).toBeNull();
    // Falsification (empirically layered — this row happens to have a DB
    // backstop the LOCATED-place pin below does not): dropping ONLY
    // `placeCoordsPairRule`'s `.superRefine` off `PlaceUpdateSchema`
    // (place.ts) does NOT red this pin — `places/routes.ts`'s try/catch
    // belt (db/coords-ck.ts) still maps the escaping `places_coords_pair_ck`
    // 23514 onto the same 400. Drop BOTH the refine AND that belt (revert
    // the PATCH handler's update call to an unguarded
    // `const [updated] = await deps.db.update(...)`) and this reds with a
    // raw 500 (`createErrorHandler`'s generic arm sees the driver error
    // directly) — verified by reverting both together.
  });

  it("[B-7 part 3 R1] PATCH: a lone lat on a LOCATED place → 400 and the row is unchanged (the silent-relocation case)", async () => {
    const user = await seedUserWithToken();
    const place = await createPlaceVia(user.accessToken, {
      name: "Fixed Spot",
      lat: 10,
      lng: 20,
    });

    const res = await patchPlace(place.id, user.accessToken, { lat: 35.61 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    // Before the fix this was a 200 that silently moved lat to 35.61 while
    // lng stayed 20 — no DB CHECK catches a valid-looking, wrong relocation.
    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(row?.lat).toBe("10.000000");
    expect(row?.lng).toBe("20.000000");
    // Falsification: dropping ONLY `placeCoordsPairRule`'s `.superRefine`
    // off `PlaceUpdateSchema` (place.ts) is enough here — unlike the
    // coordinate-less pin above, both `lat` AND `lng` stay non-null
    // throughout (only the VALUE is wrong), so `places_coords_pair_ck` never
    // fires and the routes.ts belt has nothing to catch. This reds with a
    // 200 that moved `lat` alone (row.lat becomes "35.610000" while
    // row.lng stays "20.000000") — the exact silent relocation the
    // architecture finding named, and the reason this pin, not the one
    // above, is the one that actually isolates the Zod refine.
  });

  it("[B-7 part 3 R1] PATCH: both coords on a custom place → 200 (relocate)", async () => {
    const user = await seedUserWithToken();
    const place = await createPlaceVia(user.accessToken, {
      name: "Movable Spot",
      lat: 10,
      lng: 20,
    });

    const res = await patchPlace(place.id, user.accessToken, { lat: 35.61, lng: 139.61 });
    expect(res.status).toBe(200);
    const updated = PlaceSchema.parse(await res.json());
    expect(updated.lat).toBeCloseTo(35.61, 6);
    expect(updated.lng).toBeCloseTo(139.61, 6);
  });

  it("[B-7 part 3 R1] PATCH: both lat/lng null on a CUSTOM place → 200 with nulls (clears coordinates)", async () => {
    const user = await seedUserWithToken();
    const place = await createPlaceVia(user.accessToken, {
      name: "Regretted Pin",
      lat: 10,
      lng: 20,
    });

    const res = await patchPlace(place.id, user.accessToken, { lat: null, lng: null });
    expect(res.status).toBe(200);
    const updated = PlaceSchema.parse(await res.json());
    expect(updated.lat).toBeNull();
    expect(updated.lng).toBeNull();

    const [row] = await db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(row?.lat).toBeNull();
    expect(row?.lng).toBeNull();
    // Falsification: revert `places/routes.ts`'s `set.lat`/`set.lng` write
    // to bare `String(body.lat)` — `String(null) === "null"` is not a legal
    // numeric-column value; this reds with a 500.
  });

  it("[B-7 part 3 R1] PATCH: both lat/lng null on a SPINE place → 400, distinct from the blanket spine 403 (source-aware clearing)", async () => {
    const user = await seedUserWithToken();

    const res = await patchPlace(towerId, user.accessToken, { lat: null, lng: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    // A non-coordinate edit to the SAME spine place still gets the general
    // immutability 403 — the 400 above is source-aware-clearing-specific,
    // not a relaxation of "spine places cannot be modified".
    const nameOnly = await patchPlace(towerId, user.accessToken, { name: "Hacked Tower" });
    expect(nameOnly.status).toBe(403);
    expect(((await nameOnly.json()) as ErrorEnvelope).error.code).toBe("FORBIDDEN");
    // Falsification: delete the `access.kind === "spine"` branch's
    // `body.lat === null && body.lng === null` check in places/routes.ts —
    // this reds with a 403 (the generic spine-immutable arm) instead of 400.
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

    // Third RESTRICT referencer (R-places-10's full set): tour guide bundles.
    const bundled = await createPlaceVia(user.accessToken, {
      name: "Bundled Spot",
      lat: 35.675,
      lng: 139.675,
    });
    await db.insert(schema.tourGuideBundles).values({ tripId: trip.id, placeId: bundled.id });
    const bundledRes = await deletePlace(bundled.id, user.accessToken);
    expect(bundledRes.status).toBe(409);
    expect(((await bundledRes.json()) as ErrorEnvelope).error.details).toEqual({
      reason: "place_referenced",
      by: "tour_guide_bundles",
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
    // `selectDistinct` (not `select`), post-B-7: `places` now also carries
    // the 6,927-row destination tier, all `category='locality'` — parity is
    // purely a function of `(source, category)`, so 6,927 identical checks
    // add zero coverage while risking the test timeout (T-6.4/T-6.5 round-1
    // precedent: this suite's tests are fast on purpose). DISTINCT keeps
    // exactly the same assertion strength (every UNIQUE category this suite
    // + the tier ever produces is still checked) at O(distinct) cost instead
    // of O(rows) — 'locality' itself is still covered, once.
    const rows = await db
      .selectDistinct({
        source: schema.places.source,
        category: schema.places.category,
        sqlCoarse: coarseCategorySqlExpr(schema.places.category),
      })
      .from(schema.places);
    expect(rows.length).toBeGreaterThan(8);
    expect(rows.some((r) => r.category === "locality")).toBe(true);
    for (const row of rows) {
      expect(row.sqlCoarse).toBe(coarseCategory(row.source, row.category));
    }
  });
});
