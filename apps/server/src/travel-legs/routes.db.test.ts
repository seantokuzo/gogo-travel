/**
 * T-7.3 refresh-legs endpoint suite (IB-3): POST
 * `/trips/:tripId/itinerary/refresh-legs` end-to-end over a real Postgres,
 * behind the real app-wide `requireAuth` + `requireTripMember` gates —
 * §3.4's checklist (dedup enqueue, rate limit, authz) PLUS the R-ib-19
 * headline: booking mutations complete promptly while the ENTIRE leg
 * pipeline is wedged (hung recompute — the T-6.3 "poisoned transport" pin
 * pattern).
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. Suites run file-parallel on per-suite clones of the shared
 * container (T-S3.3 — `--no-file-parallelism` retired).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TripWithRoleSchema } from "@gogo/shared/domains/trip";
import type { TripMemberRole } from "@gogo/shared/enums";
import { RATE_LIMITS } from "../config.js";
import { createApp } from "../app.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { expectIndistinguishable404s, NONEXISTENT_UUID } from "../http/idor-404.test-util.js";
import {
  createDirtyDayMarker,
  type DirtyDayMark,
  type DirtyDayMarker,
} from "../bookings/dirty-days.js";
import { createTravelLegWorker, type LegBatch } from "./worker.js";
import type { TravelLegsRouterDeps } from "./routes.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place now: src/test/global-setup.ts (T-S3.3 shared container; the
// `--no-file-parallelism` workaround is retired — QUEUE P1).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

/** Manual scheduler — debounce windows fire only when the test says so. */
function fakeScheduler() {
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  return {
    scheduler: {
      schedule(fn: () => void): unknown {
        const id = nextId++;
        tasks.set(id, fn);
        return id;
      },
      cancel(handle: unknown): void {
        tasks.delete(handle as number);
      },
    },
    fireAll(): void {
      const pending = [...tasks.values()];
      tasks.clear();
      for (const fn of pending) fn();
    },
    get count(): number {
      return tasks.size;
    },
  };
}

describe.skipIf(!dockerAvailable)("T-7.3 refresh-legs routes (integration)", () => {
  let suiteDb: SuiteDb;
  let db: PostgresJsDatabase<typeof schema>;
  let authDeps: AuthRouterDeps;
  let signer: AccessTokenSigner;

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("travel_legs_routes");
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
      appleCredentialsKey: Buffer.alloc(32, 7),
      logger: { warn: () => undefined },
    };
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  /** An app with this suite's travel-legs deps (and optional mutation markers). */
  function buildApp(
    travelLegs: TravelLegsRouterDeps,
    bookingsMarker?: DirtyDayMarker,
    itineraryMarker?: DirtyDayMarker,
  ) {
    return createApp({
      auth: authDeps,
      trips: { db },
      bookings: { db, dirtyDays: bookingsMarker ?? createDirtyDayMarker() },
      itinerary: { db, dirtyDays: itineraryMarker ?? createDirtyDayMarker() },
      travelLegs,
    });
  }

  const request = (
    app: ReturnType<typeof createApp>,
    path: string,
    token?: string,
    init?: RequestInit,
  ) =>
    app.request(path, {
      method: "POST",
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  const refresh = (app: ReturnType<typeof createApp>, tripId: string, token?: string) =>
    request(app, `/api/trips/${tripId}/itinerary/refresh-legs`, token);

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `legs-routes-${uniq()}@example.com`,
      displayName: "Legs Route Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  async function createTripVia(app: ReturnType<typeof createApp>, token: string) {
    const res = await request(app, "/api/trips", token, {
      body: JSON.stringify({
        name: `Trip ${uniq()}`,
        destination_name: "Tokyo, Japan",
        destination_lat: 35.6895,
        destination_lng: 139.6917,
        start_date: "2026-09-01",
        end_date: "2026-09-10",
      }),
    });
    expect(res.status).toBe(201);
    return TripWithRoleSchema.parse(await res.json());
  }

  async function addMember(tripId: string, userId: string, role: TripMemberRole) {
    await db.insert(schema.tripMembers).values({ tripId, userId, role });
  }

  async function seedItem(
    tripId: string,
    userId: string,
    input: { day: string; sortOrder: number; endDay?: string },
  ) {
    await db.insert(schema.itineraryItems).values({
      tripId,
      kind: "custom",
      title: `Custom ${uniq()}`,
      day: input.day,
      endDay: input.endDay ?? null,
      sortOrder: input.sortOrder,
      createdBy: userId,
    });
  }

  it("202 { enqueued: true } and marks every item chain day (day + end_day)", async () => {
    const marked: DirtyDayMark[][] = [];
    const app = buildApp({
      db,
      dirtyDays: { markDaysDirty: (marks) => void marked.push([...marks]) },
    });
    const owner = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);
    await seedItem(trip.id, owner.userId, { day: "2026-09-02", sortOrder: 1024 });
    await seedItem(trip.id, owner.userId, {
      day: "2026-09-03",
      endDay: "2026-09-05",
      sortOrder: 1024,
    });
    await seedItem(trip.id, owner.userId, { day: "2026-09-02", sortOrder: 2048 }); // dup day

    const res = await refresh(app, trip.id, owner.accessToken);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: true });

    expect(marked).toHaveLength(1);
    const days = marked[0]?.map((m) => m.day).sort();
    // Deduped: two items on 09-02 mark once; the spanning item marks BOTH
    // its chain days (§3.6) and none between.
    expect(days).toEqual(["2026-09-02", "2026-09-03", "2026-09-05"]);
    expect(marked[0]?.every((m) => m.tripId === trip.id)).toBe(true);
  });

  it("itemless trip: still 202, zero marks (legal no-op)", async () => {
    const marked: DirtyDayMark[][] = [];
    const app = buildApp({
      db,
      dirtyDays: { markDaysDirty: (marks) => void marked.push([...marks]) },
    });
    const owner = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);

    const res = await refresh(app, trip.id, owner.accessToken);
    expect(res.status).toBe(202);
    // The seam helper drops empty batches before the marker sees them.
    expect(marked).toHaveLength(0);
  });

  it("repeated refreshes COALESCE into one pending recompute per trip (§3.4 dedup)", async () => {
    const fake = fakeScheduler();
    const batches: LegBatch[] = [];
    const worker = createTravelLegWorker({
      recompute: (batch) => {
        batches.push({ tripId: batch.tripId, days: [...batch.days].sort() });
        return Promise.resolve();
      },
      scheduler: fake.scheduler,
    });
    const app = buildApp({ db, dirtyDays: createDirtyDayMarker(worker) });
    const owner = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);
    await seedItem(trip.id, owner.userId, { day: "2026-09-02", sortOrder: 1024 });

    expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(202);
    expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(202);
    expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(202);

    expect(fake.count).toBe(1); // ONE debounce window, however many refreshes
    fake.fireAll();
    await worker.idle();
    expect(batches).toEqual([{ tripId: trip.id, days: ["2026-09-02"] }]);
  });

  it("rate limit: per-trip fixed window, 429 + Retry-After, other trips unaffected (R-ib-23)", async () => {
    let nowMs = 1_700_000_000_000;
    const app = buildApp({
      db,
      dirtyDays: createDirtyDayMarker(),
      rateLimit: { store: new InMemoryRateLimitStore(), now: () => nowMs },
    });
    const owner = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);
    const otherTrip = await createTripVia(app, owner.accessToken);

    for (let i = 0; i < RATE_LIMITS.refreshLegs.limit; i += 1) {
      expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(202);
    }
    const limited = await refresh(app, trip.id, owner.accessToken);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);

    // Per-TRIP key: a different trip has its own budget.
    expect((await refresh(app, otherTrip.id, owner.accessToken)).status).toBe(202);

    // Window elapses ⇒ budget returns.
    nowMs += RATE_LIMITS.refreshLegs.windowMs + 1;
    expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(202);
  });

  it("rate-limit posture: exhausted window + NON-member → byte-identical 404, never 429", async () => {
    // Locks gate-BEFORE-limiter against middleware reshuffles: a 429 to a
    // non-member would be an existence oracle (R-ib-24 — invisible ≡ absent).
    const nowMs = 1_700_000_000_000;
    const app = buildApp({
      db,
      dirtyDays: createDirtyDayMarker(),
      rateLimit: { store: new InMemoryRateLimitStore(), now: () => nowMs },
    });
    const owner = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);

    for (let i = 0; i < RATE_LIMITS.refreshLegs.limit; i += 1) {
      expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(202);
    }
    expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(429); // exhausted

    // Same trip, same exhausted window, NON-member: still the one 404 door.
    await expectIndistinguishable404s([
      await refresh(app, trip.id, stranger.accessToken),
      await refresh(app, NONEXISTENT_UUID, stranger.accessToken),
      await refresh(app, "not-a-uuid", stranger.accessToken),
    ]);
  });

  it("authz: byte-identical 404s (non-member / nonexistent / malformed); viewer allowed; 401 bare", async () => {
    const app = buildApp({ db, dirtyDays: createDirtyDayMarker() });
    const owner = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);
    await addMember(trip.id, viewer.userId, "viewer");

    await expectIndistinguishable404s([
      await refresh(app, trip.id, stranger.accessToken),
      await refresh(app, NONEXISTENT_UUID, stranger.accessToken),
      await refresh(app, "not-a-uuid", stranger.accessToken),
    ]);

    // Any role may refresh — derived data only (§3.4).
    expect((await refresh(app, trip.id, viewer.accessToken)).status).toBe(202);
    expect((await refresh(app, trip.id)).status).toBe(401);
  });

  it("R-ib-19: booking mutations complete while the leg pipeline is WEDGED (poisoned-pipeline pin)", async () => {
    // A recompute that never settles + a worker that will drain it: once the
    // window fires, the serial drain is wedged for the rest of the test.
    const fake = fakeScheduler();
    let recomputeCalls = 0;
    const worker = createTravelLegWorker({
      recompute: () => {
        recomputeCalls += 1;
        return new Promise<never>(() => undefined); // eternal hang
      },
      scheduler: fake.scheduler,
    });
    const marker = createDirtyDayMarker(worker);
    const app = buildApp({ db, dirtyDays: marker }, marker);
    const owner = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);

    const timedBooking = {
      category: "activity",
      title: "Teamlab tickets",
      status: "planned",
      details: {
        category: "activity",
        starts_at: "2026-09-02T10:00:00+09:00",
        ends_at: "2026-09-02T12:00:00+09:00",
      },
    };

    // Mutation 1 marks days; fire the window so the drain wedges on the hang.
    const first = await request(app, `/api/trips/${trip.id}/bookings`, owner.accessToken, {
      body: JSON.stringify(timedBooking),
    });
    expect(first.status).toBe(201);
    fake.fireAll();
    expect(recomputeCalls).toBe(1);

    // Pipeline is now WEDGED. Every user path still completes:
    const second = await request(app, `/api/trips/${trip.id}/bookings`, owner.accessToken, {
      body: JSON.stringify({ ...timedBooking, title: "Second booking" }),
    });
    expect(second.status).toBe(201);
    expect((await refresh(app, trip.id, owner.accessToken)).status).toBe(202);
    // And the wedge never grew into the request path: still exactly one call.
    expect(recomputeCalls).toBe(1);
  });

  it("WIRING ASSERTION: itinerary item mutations reach the LIVE worker's marker (T-7.2 × T-7.3)", async () => {
    // The prod handoff (index.ts → `buildItineraryDeps(travelLegs.marker)`)
    // is pinned statically in marker-wiring.test.ts; THIS pins the behavior
    // that handoff buys: an item create's post-commit marks land in the live
    // worker and the debounce window drains into a real recompute for
    // exactly that trip/day — never the silent dormant no-op.
    const fake = fakeScheduler();
    const batches: LegBatch[] = [];
    const worker = createTravelLegWorker({
      recompute: (batch) => {
        batches.push(batch);
        return Promise.resolve();
      },
      scheduler: fake.scheduler,
    });
    const marker = createDirtyDayMarker(worker);
    const app = buildApp({ db, dirtyDays: marker }, marker, marker);
    const owner = await seedUserWithToken();
    const trip = await createTripVia(app, owner.accessToken);

    const res = await request(app, `/api/trips/${trip.id}/itinerary/items`, owner.accessToken, {
      body: JSON.stringify({ kind: "custom", title: "Ramen crawl", day: "2026-09-02" }),
    });
    expect(res.status).toBe(201);

    // Marks sit in the debounce bucket until the window fires (§3.5 step 1)…
    expect(batches).toEqual([]);
    fake.fireAll();
    await worker.idle();
    // …then the LIVE worker recomputes the marked trip/day.
    expect(batches).toEqual([{ tripId: trip.id, days: ["2026-09-02"] }]);
  });
});
