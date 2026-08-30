/**
 * T-S3.3 fresh-install suite (testing-overhaul spec §3.3, R-test-3) — the
 * full authed app against an EMPTY migrated database, ZERO fixtures, walking
 * first-user/first-run paths in order (the tests are one journey and rely on
 * file order): pristine-clone proof → emptiness pins → FIRST sign-in creates
 * the FIRST user → zero-state lists page → the B-7 cold-start circularity
 * (evidence pin + `it.fails` escape pin, R-test-8) → machinery controls.
 *
 * ZERO FIXTURES is the contract (R-test-3: seeding inside this suite is a
 * blocking review finding): every row in this database is created THROUGH
 * the API by the first user. Assertions read the DB directly; they never
 * write it.
 *
 * Shape parity with prod wiring (`src/index.ts`): every router surface
 * createApp accepts is mounted; key material comes from
 * `makeFullAuthTestEnv()` (T-S3.1) through the REAL parse paths
 * (`importPKCS8`, `createPublicKey(createPrivateKey(…))`, `parseAesKey`);
 * Google verification uses the JWKS seam (same as
 * `auth/signin-routes.db.test.ts`); the places ingest queue is the REAL
 * queue + REAL `ingestRegionCell` job with NO dataset URLs configured —
 * exactly the 2026-08-29 device rig where B-7 was caught (Law #5: the stub
 * reader can never be reached and network is never touched).
 *
 * Falsification (R-test-7): stated per test. The B-7 pins flip in B-7's fix
 * PR — see the `it.fails` doc-comment for the per-ruling flip instructions.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, importPKCS8, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import { SignInResponseSchema } from "@gogo/shared/domains/auth";
import { BookingSchema } from "@gogo/shared/domains/booking";
import { ItineraryReadSchema } from "@gogo/shared/domains/itinerary";
import { ExpenseSchema } from "@gogo/shared/domains/money";
import { PlaceSchema } from "@gogo/shared/domains/place";
import { TripListItemSchema, TripWithRoleSchema } from "@gogo/shared/domains/trip";
import { createApp } from "./app.js";
import { parseAesKey } from "./auth/crypto.js";
import type { AuthRouterDeps } from "./auth/routes.js";
import * as schema from "./db/schema/index.js";
import type { GeoParquetReader } from "./places/geoparquet-reader.js";
import { createPlacesIngestQueue, type PlacesIngestQueue } from "./places/ingest-queue.js";
import { ingestRegionCell } from "./places/region-ingest.js";
import {
  makeFullAuthTestEnv,
  TEST_APPLE_CLIENT_ID,
  TEST_AUTH_KID,
  TEST_GOOGLE_CLIENT_IDS,
} from "./test/env-builder.js";
import { UNCONFIGURED_OBJECT_STORAGE } from "./storage/object-storage.js";
import { createSuiteDb, type SuiteDb } from "./test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place: src/test/global-setup.ts (T-S3.3 shared container).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const PROVIDER_KID = "provider-kid-fresh";
const RAW_NONCE = "raw-nonce-fresh-install";
const FIRST_EMAIL = "first-user@example.com";

const PaginatedTrips = paginatedSchema(TripListItemSchema);
const PaginatedPlaces = paginatedSchema(PlaceSchema);
const PaginatedBookings = paginatedSchema(BookingSchema);
const PaginatedExpenses = paginatedSchema(ExpenseSchema);

/** Lisbon — the coordinates a spine place pick would have supplied. */
const LISBON = { lat: 38.722252, lng: -9.139337 };

describe.skipIf(!dockerAvailable)("T-S3.3 fresh install (empty DB, zero fixtures)", () => {
  let suiteDb: SuiteDb;
  let app: ReturnType<typeof createApp>;
  let ingestQueue: PlacesIngestQueue;
  let providerKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let accessToken: string;
  let firstUserId: string;
  const coverageTasks: Promise<void>[] = [];
  const warnings: string[] = [];

  beforeAll(async () => {
    suiteDb = await createSuiteDb("fresh_install");
    const db = suiteDb.db;

    // ---- auth deps: T-S3.1 env-builder material through the REAL parse
    // paths, provider verification through the JWKS seam ------------------
    const env = await makeFullAuthTestEnv();
    const provider = await generateKeyPair("RS256", { extractable: true });
    providerKey = provider.privateKey;
    const jwk = { ...(await exportJWK(provider.publicKey)), kid: PROVIDER_KID, alg: "RS256" };
    const jwks = createLocalJWKSet({ keys: [jwk] });

    const auth: AuthRouterDeps = {
      db,
      verifier: {
        appleJwks: jwks,
        googleJwks: jwks,
        appleAudience: TEST_APPLE_CLIENT_ID,
        googleAudiences: TEST_GOOGLE_CLIENT_IDS.split(","),
      },
      signer: {
        privateKey: await importPKCS8(env.es256PrivateKeyPem, "ES256"),
        kid: TEST_AUTH_KID,
      },
      accessVerify: {
        publicKey: createPublicKey(createPrivateKey(env.es256PrivateKeyPem)),
      },
      appleExchange: {
        exchange: () => Promise.reject(new Error("unused — fresh install signs in with Google")),
      },
      appleCredentialsKey: parseAesKey(env.appleCredentialsKeyBase64),
      logger: { warn: (message: string) => void warnings.push(message) },
    };

    // ---- places ingest: the REAL queue + REAL job, NO dataset URLs — the
    // exact fresh-install rig (B-7 evidence: PLACES_*_PARQUET_URL unset).
    // The reader throws if ever touched: with zero configured datasets the
    // job must record `failed` without reading anything (Law #5). ----------
    const untouchableReader: GeoParquetReader = {
      readBatches() {
        throw new Error("fresh-install: reader must never run (no dataset URLs configured)");
      },
    };
    ingestQueue = createPlacesIngestQueue({
      ingestCell: (cell) => ingestRegionCell({ db, reader: untouchableReader, datasets: {} }, cell),
      logger: { warn: (message: string) => void warnings.push(message) },
    });

    // ---- the FULL authed shape: every surface `createApp` accepts, wired
    // the way `src/index.ts` wires it (fakes only at the DI seams that would
    // otherwise touch the network — Law #5) --------------------------------
    app = createApp({
      auth,
      users: {
        db,
        // Faithful to a fresh install: object storage has no provider
        // (index.ts boots with the same stand-in and warns).
        storage: UNCONFIGURED_OBJECT_STORAGE,
        cashtagChecker: { check: () => Promise.resolve("ok" as const) },
        appleRevoker: { revoke: () => Promise.resolve() },
        appleCredentialsKey: parseAesKey(env.appleCredentialsKeyBase64),
      },
      trips: { db, placesIngest: ingestQueue },
      places: {
        db,
        placesIngest: ingestQueue,
        trackCoverageTask: (task) => void coverageTasks.push(task),
      },
      bookings: { db },
      itinerary: { db },
      travelLegs: { db, dirtyDays: { markDaysDirty: () => undefined } },
      expenses: { db },
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await ingestQueue?.idle();
    await suiteDb?.drop();
  });

  // ---- helpers (API-only writes; direct-DB reads) ---------------------------

  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  const postJson = (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body) });

  async function mintGoogleIdToken(sub: string, email: string): Promise<string> {
    return new SignJWT({ sub, email, email_verified: true, nonce: RAW_NONCE })
      .setProtectedHeader({ alg: "RS256", kid: PROVIDER_KID })
      .setIssuedAt()
      .setExpirationTime("10m")
      .setIssuer("accounts.google.com")
      .setAudience(TEST_GOOGLE_CLIENT_IDS.split(",")[0]!)
      .sign(providerKey);
  }

  /** Wait for a search's post-response coverage probe AND the ingest queue. */
  async function settleIngest(): Promise<void> {
    await Promise.all(coverageTasks.splice(0));
    await ingestQueue.idle();
  }

  const countRows = async (table: "users" | "places" | "place_ingest_regions") => {
    const [row] = await suiteDb.client<
      { n: string }[]
    >`select count(*) as n from ${suiteDb.client(table)}`;
    return Number(row?.n);
  };

  // ---- the first-run walk (file order = the journey) ------------------------

  it("pristine clone carries the migrations: 0001's transport-grace constraint is present", async () => {
    // Template proof: migration 0001 rewrote bookings_time_order_ck with the
    // 12h flight/train grace disjunct; 0000's version had none. A template
    // migrated only through 0000 (or not at all) goes RED here. (Postgres
    // normalizes `interval '12 hours'` to `'12:00:00'::interval`.)
    const [constraint] = await suiteDb.client<
      { def: string }[]
    >`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'bookings_time_order_ck'`;
    expect(constraint).toBeDefined();
    expect(constraint?.def).toContain("'12:00:00'::interval");

    // The clone also carries the drizzle journal (idempotent re-migration —
    // db/constraints.test.ts pins the behavior; here we pin the substrate).
    const [journal] = await suiteDb.client<
      { n: string }[]
    >`select count(*) as n from drizzle.__drizzle_migrations`;
    expect(Number(journal?.n)).toBeGreaterThanOrEqual(2);
  });

  it("a fresh install is EMPTY: zero users, zero places, zero ingest regions", async () => {
    // The zero-fixture contract, pinned. Controls that prove these count
    // queries CAN see rows: users flips 0→1 at first sign-in (next test),
    // place_ingest_regions in the anchored-search control, places in the
    // custom-place control.
    expect(await countRows("users")).toBe(0);
    expect(await countRows("places")).toBe(0);
    expect(await countRows("place_ingest_regions")).toBe(0);
  });

  it("first sign-in creates the FIRST user on the empty database (Google, JWKS seam)", async () => {
    const res = await postJson("/api/auth/google", {
      id_token: await mintGoogleIdToken("google-first-user", FIRST_EMAIL),
      raw_nonce: RAW_NONCE,
      device: { platform: "ios" },
    });
    expect(res.status).toBe(200);
    const body = SignInResponseSchema.parse(await res.json());
    expect(body.is_new_user).toBe(true);
    expect(body.user.email).toBe(FIRST_EMAIL);

    firstUserId = body.user.id;
    accessToken = body.tokens.access_token;

    // 0 → 1: first-run viability AND the control arm for the emptiness pin.
    expect(await countRows("users")).toBe(1);
    // The account is fully provisioned, not a bare row: entitlements exist.
    const [ent] = await suiteDb.db
      .select({ plan: schema.entitlements.plan })
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, firstUserId));
    expect(ent?.plan).toBe("free");
  });

  it("zero-state trips list pages correctly for the first user", async () => {
    const res = await request("/api/trips");
    expect(res.status).toBe(200);
    const page = PaginatedTrips.parse(await res.json());
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("[B-7 evidence] text-only destination searches 200/empty and leave the spine AND the ingest ledger untouched", async () => {
    // The deadlock's server half, pinned exactly as observed on device
    // 2026-08-29 (~7 searches, all 200, places 0 rows, regions 0 rows — not
    // even `failed`): a text-only query anchors no geographic cell, so the
    // search-miss trigger never fires. GREEN here means B-7 is still open;
    // B-7's fix PR retires this pin when it flips the escape pin below.
    for (const q of ["lisbon", "tokyo", "paris"]) {
      const res = await request(`/api/places/search?q=${q}`);
      expect(res.status).toBe(200);
      const page = PaginatedPlaces.parse(await res.json());
      expect(page.items).toEqual([]);
    }
    await settleIngest();
    expect(await countRows("places")).toBe(0);
    expect(await countRows("place_ingest_regions")).toBe(0);
  });

  it.fails(
    "[B-7] a first user can escape the cold-start deadlock: text-only search self-seeds (ruling B) OR text-only trip create is accepted (ruling A)",
    async () => {
      // R-test-8 pin, ruling-independent by disjunction — EITHER of Sean's
      // candidate rulings breaks the circularity and flips this to `it`:
      //   ruling A (text-only destination): the coordinate-less POST /trips
      //     below starts returning 201 → arm A true.
      //   ruling B (self-seeding first search): the q-only search below
      //     starts returning results or recording an ingest region → arm B
      //     true.
      // Flip instruction (B-7 fix PR): change `it.fails` to `it`, keep BOTH
      // arms (the disjunction stays valid — the un-ruled arm simply stays
      // false), and retire the evidence pin above.
      const search = await request("/api/places/search?q=lisbon");
      expect(search.status).toBe(200);
      const page = PaginatedPlaces.parse(await search.json());
      await settleIngest();
      const armB = page.items.length > 0 || (await countRows("place_ingest_regions")) > 0;

      const create = await postJson("/api/trips", {
        name: "First Trip",
        destination_name: "Lisbon, Portugal",
        start_date: "2026-09-01",
        end_date: "2026-09-08",
      });
      const armA = create.status === 201;

      expect(armA || armB).toBe(true);
    },
  );

  it("control arm: an ANCHORED search reaches the ingest ledger — regions recorded `failed` (no dataset URLs)", async () => {
    // Proves the B-7 emptiness above is about text-only anchoring, not dead
    // machinery: `near=` yields cells → the search-miss trigger enqueues →
    // the REAL job runs → with no PLACES_*_PARQUET_URL it records `failed`
    // (rig parity), never touching the reader or the spine.
    const res = await request(`/api/places/search?near=${LISBON.lat},${LISBON.lng}`);
    expect(res.status).toBe(200);
    await settleIngest();

    const regions = await suiteDb.db
      .select({ status: schema.placeIngestRegions.status, error: schema.placeIngestRegions.error })
      .from(schema.placeIngestRegions);
    expect(regions.length).toBeGreaterThan(0);
    for (const region of regions) {
      expect(region.status).toBe("failed");
      expect(region.error).toMatch(/not configured/);
    }
    // Failed ingest seeds nothing — the spine is still empty.
    expect(await countRows("places")).toBe(0);
  });

  it("the raw API can create the first trip once coordinates exist, and its zero-state sub-lists page correctly", async () => {
    // NOT an escape from B-7: the API accepts coordinates, but the mobile
    // flow can only obtain them from a spine pick (new.tsx blocks submit
    // without one) — this asymmetry IS the deadlock's shape. Here it stands
    // in for the post-fix world so first-run zero states of every
    // trip-scoped surface get walked on the truly-empty database.
    const created = await postJson("/api/trips", {
      name: "First Trip",
      destination_name: "Lisbon, Portugal",
      destination_lat: LISBON.lat,
      destination_lng: LISBON.lng,
      start_date: "2026-09-01",
      end_date: "2026-09-08",
    });
    expect(created.status).toBe(201);
    const trip = TripWithRoleSchema.parse(await created.json());
    await settleIngest(); // destination trigger — same failed-record path

    const bookings = await request(`/api/trips/${trip.id}/bookings`);
    expect(bookings.status).toBe(200);
    expect(PaginatedBookings.parse(await bookings.json()).items).toEqual([]);

    const expenses = await request(`/api/trips/${trip.id}/expenses`);
    expect(expenses.status).toBe(200);
    expect(PaginatedExpenses.parse(await expenses.json()).items).toEqual([]);

    const itinerary = await request(`/api/trips/${trip.id}/itinerary`);
    expect(itinerary.status).toBe(200);
    const read = ItineraryReadSchema.parse(await itinerary.json());
    expect(read.items).toEqual([]);
    expect(read.legs).toEqual([]);
  });

  it("control arm: a custom place lands in `places` — the emptiness reads see real rows", async () => {
    // Also documents the QA workaround's mechanism (seed-qa-places.mjs uses
    // creator-scoped custom places) without endorsing it as the fix.
    const res = await postJson("/api/places", {
      name: "Casa do Bacalhau",
      lat: LISBON.lat,
      lng: LISBON.lng,
    });
    expect(res.status).toBe(201);
    PlaceSchema.parse(await res.json());
    expect(await countRows("places")).toBe(1);
  });
});
