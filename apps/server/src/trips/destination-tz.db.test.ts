/**
 * B-30 destination-zone "today" — integration suite over a real Postgres,
 * through the real app (`requireAuth` + `requireTripMember` gates) with a
 * MUTABLE injected clock (`routes.db.test.ts` freezes one instant; every
 * case here needs to choose its own).
 *
 * The headline repro (Sean, device QA): a Kyoto trip with start = end = the
 * destination's today, created after 17:00 PDT (= after UTC midnight is NOT
 * needed — Tokyo is UTC+9, so from 15:00 UTC the Tokyo date is already
 * tomorrow's) landed `planning` under the old UTC rule. It must land
 * `active`, and the wire must carry the zone the status was judged in.
 *
 * Matrix: east boundary · west boundary · exact-midnight flip · per-trip
 * reconcile in list/get/PATCH (several zones, one clock) · zone derivation at
 * create · explicit zone wins · PATCH re-derive on moved coordinates /
 * explicit-in-body / untouched on unrelated PATCH · coordless custom +
 * explicit zone · booking-zone fallback (earliest, arrives→departs, skip
 * unusable, category filter, never written back) · UTC default · invalid
 * explicit zone → 400 (Intl + shape) · legacy NULL row resolves lazily ·
 * DB CHECK cap · reconcile never bumps updated_at.
 *
 * Falsification per group is stated inline; every one was exercised (PR body).
 * Driver: postgres-js on the shared testcontainers Postgres — a Docker-less CI
 * run is a HARD FAILURE; a local Docker-less run skips with a loud banner.
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, generateKeyPair } from "jose";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import {
  TripListItemSchema,
  TripSchema,
  TripWithRoleSchema,
  type TripWithRole,
} from "@gogo/shared/domains/trip";
import { createApp } from "../app.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import { isCheckViolationOf } from "../db/pg-errors.js";
import * as schema from "../db/schema/index.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import type { ErrorEnvelope } from "../http/idor-404.test-util.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";

const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

const KYOTO = { name: "Kyoto, Japan", lat: 35.0116, lng: 135.7681 }; // Asia/Tokyo, UTC+9
const LOS_ANGELES = { name: "Los Angeles, CA", lat: 34.0522, lng: -118.2437 }; // America/Los_Angeles
const LISBON = { name: "Lisbon, Portugal", lat: 38.722252, lng: -9.139337 }; // Europe/Lisbon

const PaginatedTripList = paginatedSchema(TripListItemSchema);

describe.skipIf(!dockerAvailable)("B-30 destination-zone today (integration)", () => {
  let suiteDb: SuiteDb;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let signer: AccessTokenSigner;
  /** The injected server clock — every case sets the instant it needs. */
  let clock = new Date("2026-07-25T12:00:00.000Z");

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("trips_destination_tz");
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
    app = createApp({ auth: authDeps, trips: { db, now: () => clock } });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  // ---- helpers ---------------------------------------------------------------

  async function seedUser() {
    const { user } = await createUserWithEntitlements(db, {
      email: `tz-${uniq()}@example.com`,
      displayName: "Zone Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, token: issued.accessToken };
  }

  const request = (path: string, token: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`,
      },
    });
  const postTrip = (token: string, body: unknown) =>
    request("/api/trips", token, { method: "POST", body: JSON.stringify(body) });
  const getTrip = (tripId: string, token: string) => request(`/api/trips/${tripId}`, token);
  const listTrips = (token: string) => request("/api/trips", token);
  const patchTrip = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}`, token, { method: "PATCH", body: JSON.stringify(body) });

  type Place = { name: string; lat: number | null; lng: number | null };
  const tripBody = (
    place: Place,
    dates: { start: string; end: string },
    extra: Record<string, unknown> = {},
  ) => ({
    name: `Trip ${uniq()}`,
    destination_name: place.name,
    destination_lat: place.lat,
    destination_lng: place.lng,
    start_date: dates.start,
    end_date: dates.end,
    ...extra,
  });

  async function createTrip(
    token: string,
    place: Place,
    dates: { start: string; end: string },
    extra: Record<string, unknown> = {},
  ): Promise<TripWithRole> {
    const res = await postTrip(token, tripBody(place, dates, extra));
    expect(res.status).toBe(201);
    return TripWithRoleSchema.parse(await res.json());
  }

  const dbTrip = async (tripId: string) => {
    const [row] = await db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    if (!row) throw new Error("trip row missing");
    return row;
  };

  /** A trip row inserted straight into the DB (legacy / drifted shapes the API can no longer mint). */
  async function seedTripRow(
    userId: string,
    values: Partial<typeof schema.trips.$inferInsert> & { startDate: string; endDate: string },
  ) {
    const [row] = await db
      .insert(schema.trips)
      .values({
        name: `Seeded ${uniq()}`,
        destinationName: "Seeded",
        createdBy: userId,
        ...values,
      })
      .returning();
    if (!row) throw new Error("seed insert returned no row");
    await db.insert(schema.tripMembers).values({ tripId: row.id, userId, role: "owner" });
    return row;
  }

  async function seedFlight(
    tripId: string,
    userId: string,
    opts: {
      startsAt: string | null;
      arrivesTz?: string;
      departsTz?: string;
      category?: "flight" | "train" | "lodging";
    },
  ) {
    await db.insert(schema.bookings).values({
      tripId,
      createdBy: userId,
      category: opts.category ?? "flight",
      title: `Booking ${uniq()}`,
      details: {
        category: opts.category ?? "flight",
        ...(opts.arrivesTz === undefined ? {} : { arrives_tz: opts.arrivesTz }),
        ...(opts.departsTz === undefined ? {} : { departs_tz: opts.departsTz }),
      } as never, // raw jsonb: the zone fields are all this suite reads
      startsAt: opts.startsAt === null ? null : new Date(opts.startsAt),
    });
  }

  // ===========================================================================
  // The headline: east of UTC (Sean's device repro)
  // ===========================================================================

  it("[B-30 repro] a Kyoto trip with start = end = the DESTINATION's today, created after UTC's date lags Tokyo's, is born 'active' — the wire carries Asia/Tokyo", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z"); // 13:00 PDT Aug 1 · UTC Aug 1 · Tokyo 05:00 Aug 2
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-08-02", end: "2026-08-02" });

    expect(trip.destination_tz).toBe("Asia/Tokyo");
    expect(trip.status).toBe("active"); // the UTC rule said 'planning' (UTC today Aug 1 < Aug 2)
    const row = await dbTrip(trip.id);
    expect(row.status).toBe("active");
    expect(row.destinationTz).toBe("Asia/Tokyo"); // derived at create and STORED
    // Falsification: make `tripToday` return the UTC date (status.ts) → status 'planning', red.
  });

  it("[east boundary] flips at Tokyo midnight (15:00Z), not a millisecond earlier — via GET, with the stored status converging and updated_at untouched", async () => {
    clock = new Date("2026-08-01T14:59:59.999Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-08-02", end: "2026-08-02" });
    expect(trip.status).toBe("planning"); // Tokyo is still Aug 1
    const before = await dbTrip(trip.id);

    clock = new Date("2026-08-01T15:00:00.000Z"); // Tokyo midnight → Aug 2
    const read = TripWithRoleSchema.parse(await (await getTrip(trip.id, owner.token)).json());
    expect(read.status).toBe("active");
    const after = await dbTrip(trip.id);
    expect(after.status).toBe("active"); // stored value converged
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString()); // reconcile never bumps
  });

  // ===========================================================================
  // West of UTC
  // ===========================================================================

  it("[west boundary] a Los Angeles trip ending 'today' is still active after UTC has rolled over, and goes past at LA midnight", async () => {
    clock = new Date("2026-08-02T03:00:00.000Z"); // UTC Aug 2 · 20:00 PDT Aug 1
    const owner = await seedUser();
    const trip = await createTrip(owner.token, LOS_ANGELES, {
      start: "2026-07-30",
      end: "2026-08-01",
    });
    expect(trip.destination_tz).toBe("America/Los_Angeles");
    expect(trip.status).toBe("active"); // the UTC rule said 'past' (UTC today Aug 2 > Aug 1)

    clock = new Date("2026-08-02T06:59:59.999Z");
    expect(
      TripWithRoleSchema.parse(await (await getTrip(trip.id, owner.token)).json()).status,
    ).toBe("active");
    clock = new Date("2026-08-02T07:00:00.000Z"); // LA midnight → Aug 2
    expect(
      TripWithRoleSchema.parse(await (await getTrip(trip.id, owner.token)).json()).status,
    ).toBe("past");
    expect((await dbTrip(trip.id)).status).toBe("past");
  });

  // ===========================================================================
  // Per-trip reconcile (one clock, several zones)
  // ===========================================================================

  it("[list] one page, one clock, three zones: each row is reconciled at ITS OWN today — and no updated_at moves", async () => {
    clock = new Date("2026-08-02T03:00:00.000Z"); // Tokyo Aug 2 12:00 · UTC Aug 2 · LA Aug 1 20:00
    const owner = await seedUser();
    const dates = { startDate: "2026-08-02", endDate: "2026-08-02" };
    const seed = (tz: string) => seedTripRow(owner.userId, { ...dates, destinationTz: tz });
    const tokyo = await seed("Asia/Tokyo");
    const utc = await seed("UTC");
    const la = await seed("America/Los_Angeles"); // all three stored 'planning' (the column default)

    const page = PaginatedTripList.parse(await (await listTrips(owner.token)).json());
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(tokyo.id)?.status).toBe("active");
    expect(byId.get(utc.id)?.status).toBe("active");
    expect(byId.get(la.id)?.status).toBe("planning"); // LA is still Aug 1
    expect(byId.get(tokyo.id)?.destination_tz).toBe("Asia/Tokyo");
    expect(byId.get(la.id)?.destination_tz).toBe("America/Los_Angeles");

    expect((await dbTrip(tokyo.id)).status).toBe("active");
    expect((await dbTrip(utc.id)).status).toBe("active");
    expect((await dbTrip(la.id)).status).toBe("planning");
    for (const seeded of [tokyo, utc, la]) {
      expect((await dbTrip(seeded.id)).updatedAt.toISOString()).toBe(
        seeded.updatedAt.toISOString(),
      );
    }
    // Falsification: evaluate the whole page at one `today` (the first row's, or UTC) → the
    // three expectations cannot all hold; reds on Tokyo or LA.
  });

  it("[get] a legacy NULL-stored zone with coordinates resolves lazily from them (Tokyo) — and is never written back", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const legacy = await seedTripRow(owner.userId, {
      destinationName: KYOTO.name,
      destinationLat: String(KYOTO.lat),
      destinationLng: String(KYOTO.lng),
      destinationTz: null,
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    });
    const read = TripWithRoleSchema.parse(await (await getTrip(legacy.id, owner.token)).json());
    expect(read.destination_tz).toBe("Asia/Tokyo");
    expect(read.status).toBe("active"); // Tokyo-today Aug 2
    expect((await dbTrip(legacy.id)).destinationTz).toBeNull(); // steps 2-lazy / 3 / 4 never write
  });

  // ===========================================================================
  // Create: explicit zone, derivation, coordless custom
  // ===========================================================================

  it("[create] an explicit zone beats the coordinate derivation and is stored as given", async () => {
    clock = new Date("2026-08-01T14:30:00.000Z"); // UTC Aug 1 · Tokyo 23:30 Aug 1 · Auckland (UTC+12) 02:30 Aug 2
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      KYOTO,
      { start: "2026-08-02", end: "2026-08-02" },
      { destination_tz: "Pacific/Auckland" },
    );
    expect(trip.destination_tz).toBe("Pacific/Auckland");
    // Auckland says Aug 2 → active; the Kyoto-derived Tokyo zone (Aug 1) and UTC (Aug 1) both say planning.
    expect(trip.status).toBe("active");
    expect((await dbTrip(trip.id)).destinationTz).toBe("Pacific/Auckland");
  });

  it("[create] a coordinate-less custom destination with an explicit zone (the mobile form's device zone) stores it and judges status in it", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Grandma's cabin", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
      { destination_tz: "Asia/Tokyo" },
    );
    expect(trip.destination_lat).toBeNull();
    expect(trip.destination_tz).toBe("Asia/Tokyo");
    expect(trip.status).toBe("active");
    expect((await dbTrip(trip.id)).destinationTz).toBe("Asia/Tokyo");
  });

  it("[create] coordless + no explicit zone + no bookings → effective UTC; the column stays NULL (a default is never persisted)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Somewhere", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
    );
    expect(trip.destination_tz).toBe("UTC");
    expect(trip.status).toBe("planning"); // UTC today Aug 1
    expect((await dbTrip(trip.id)).destinationTz).toBeNull();
  });

  // ===========================================================================
  // Booking-zone fallback (chain step 3)
  // ===========================================================================

  it("[booking fallback] a coordless trip takes the EARLIEST flight's arrives_tz — judged and served at read time, never written back", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Somewhere", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
    );
    expect(trip.destination_tz).toBe("UTC"); // nothing to go on yet
    expect(trip.status).toBe("planning");

    // The LATER flight is inserted FIRST so insertion order cannot explain the pick.
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-20T08:00:00Z",
      arrivesTz: "Europe/Paris",
    });
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Asia/Tokyo",
    });

    const read = TripWithRoleSchema.parse(await (await getTrip(trip.id, owner.token)).json());
    expect(read.destination_tz).toBe("Asia/Tokyo");
    expect(read.status).toBe("active"); // judged at Tokyo's today, same zone as the wire
    const row = await dbTrip(trip.id);
    expect(row.destinationTz).toBeNull();
    expect(row.status).toBe("active"); // stored status converged to the booking-zone verdict
    // Falsification: drop the bookings loop in `resolveDestinationTz` (or the query) →
    // "UTC" / 'planning', red.
  });

  it("[booking fallback] arrives_tz is preferred; an unusable one falls to departs_tz; a booking with neither is skipped for the next", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const dates = { startDate: "2026-08-02", endDate: "2026-08-02" };
    const zoneOf = async (tripId: string) =>
      TripSchema.parse(await (await getTrip(tripId, owner.token)).json()).destination_tz;

    const departsFallback = await seedTripRow(owner.userId, dates);
    await seedFlight(departsFallback.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Not/AZone",
      departsTz: "America/Chicago",
    });
    expect(await zoneOf(departsFallback.id)).toBe("America/Chicago");

    const skipsUnusable = await seedTripRow(owner.userId, dates);
    await seedFlight(skipsUnusable.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Not/AZone",
      departsTz: "+05:00", // offset-style: not an IANA zone
    });
    await seedFlight(skipsUnusable.id, owner.userId, {
      startsAt: "2026-08-03T01:00:00Z",
      arrivesTz: "Europe/Paris",
    });
    expect(await zoneOf(skipsUnusable.id)).toBe("Europe/Paris");
  });

  it("[booking fallback] only flight/train bookings count — a lodging booking carrying a zone-shaped field is ignored → UTC", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const row = await seedTripRow(owner.userId, { startDate: "2026-08-02", endDate: "2026-08-02" });
    await seedFlight(row.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Asia/Tokyo",
      category: "lodging",
    });
    const read = TripSchema.parse(await (await getTrip(row.id, owner.token)).json());
    expect(read.destination_tz).toBe("UTC");
  });

  it("[booking fallback] a trip WITH coordinates never consults bookings — the derived zone wins over a contradicting flight", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-08-02", end: "2026-08-02" });
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Europe/Paris",
    });
    const read = TripSchema.parse(await (await getTrip(trip.id, owner.token)).json());
    expect(read.destination_tz).toBe("Asia/Tokyo");
  });

  // ===========================================================================
  // PATCH
  // ===========================================================================

  it("[patch] changing dates re-judges status at the destination's today (response carries the zone)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-09-01", end: "2026-09-05" });
    expect(trip.status).toBe("planning");

    const res = await patchTrip(trip.id, owner.token, {
      start_date: "2026-08-02",
      end_date: "2026-08-02",
    });
    expect(res.status).toBe(200);
    const patched = TripSchema.parse(await res.json());
    expect(patched.destination_tz).toBe("Asia/Tokyo");
    expect(patched.status).toBe("active"); // Tokyo today Aug 2
    expect((await dbTrip(trip.id)).status).toBe("active");
  });

  it("[patch] moving the coordinates (no explicit zone) RE-DERIVES the zone and re-judges status under it", async () => {
    clock = new Date("2026-08-02T03:00:00.000Z"); // Tokyo Aug 2 · LA Aug 1
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-08-02", end: "2026-08-02" });
    expect(trip.status).toBe("active"); // Tokyo today Aug 2

    const res = await patchTrip(trip.id, owner.token, {
      destination_name: LOS_ANGELES.name,
      destination_lat: LOS_ANGELES.lat,
      destination_lng: LOS_ANGELES.lng,
    });
    expect(res.status).toBe(200);
    const patched = TripSchema.parse(await res.json());
    expect(patched.destination_tz).toBe("America/Los_Angeles");
    expect(patched.status).toBe("planning"); // LA today Aug 1 < Aug 2
    const row = await dbTrip(trip.id);
    expect(row.destinationTz).toBe("America/Los_Angeles");
    expect(row.status).toBe("planning");
    // Falsification: skip the `coordsMoved` re-derivation branch in routes.ts → zone stays Asia/Tokyo, red.
  });

  it("[patch] an explicit zone in the SAME body as moved coordinates wins over the derivation", async () => {
    clock = new Date("2026-08-02T03:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-08-02", end: "2026-08-02" });
    const patched = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_lat: LOS_ANGELES.lat,
          destination_lng: LOS_ANGELES.lng,
          destination_tz: "Asia/Tokyo",
        })
      ).json(),
    );
    expect(patched.destination_tz).toBe("Asia/Tokyo");
    expect((await dbTrip(trip.id)).destinationTz).toBe("Asia/Tokyo");
  });

  it("[patch] destination_tz alone is a real write: stored, status re-judged, updated_at bumped", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, LISBON, { start: "2026-08-02", end: "2026-08-02" });
    expect(trip.destination_tz).toBe("Europe/Lisbon");
    expect(trip.status).toBe("planning"); // Lisbon (UTC+1) 21:00 Aug 1
    const before = await dbTrip(trip.id);

    const patched = TripSchema.parse(
      await (await patchTrip(trip.id, owner.token, { destination_tz: "Asia/Tokyo" })).json(),
    );
    expect(patched.destination_tz).toBe("Asia/Tokyo");
    expect(patched.status).toBe("active");
    const after = await dbTrip(trip.id);
    expect(after.destinationTz).toBe("Asia/Tokyo");
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("[patch] an unrelated PATCH (name) leaves a user-set zone alone even when it differs from the coordinates' derivation", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      KYOTO,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland" },
    );
    const patched = TripSchema.parse(
      await (await patchTrip(trip.id, owner.token, { name: "Renamed" })).json(),
    );
    expect(patched.destination_tz).toBe("Pacific/Auckland");
    expect((await dbTrip(trip.id)).destinationTz).toBe("Pacific/Auckland");
  });

  it("[patch] resubmitting IDENTICAL coordinates is not a move: a user-set zone survives (value-diff, not key-presence)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      KYOTO,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland" },
    );
    const patched = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_lat: KYOTO.lat,
          destination_lng: KYOTO.lng,
        })
      ).json(),
    );
    expect(patched.destination_tz).toBe("Pacific/Auckland");
  });

  it("[patch] a coordless trip's explicit zone survives a null→null resubmit (the settings form re-save)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Cabin", lat: null, lng: null },
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland" },
    );
    const patched = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_name: "Cabin (renamed)",
          destination_lat: null,
          destination_lng: null,
        })
      ).json(),
    );
    expect(patched.destination_tz).toBe("Pacific/Auckland");
    expect((await dbTrip(trip.id)).destinationTz).toBe("Pacific/Auckland");
  });

  it("[patch] real→null coordinates (no explicit zone) CLEARS the stored zone — the old zone described the old place; effective falls to UTC", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-08-02", end: "2026-08-02" });
    expect(trip.status).toBe("active");

    const patched = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_name: "Somewhere custom",
          destination_lat: null,
          destination_lng: null,
        })
      ).json(),
    );
    expect(patched.destination_tz).toBe("UTC");
    expect(patched.status).toBe("planning"); // UTC today Aug 1 < Aug 2
    expect((await dbTrip(trip.id)).destinationTz).toBeNull();
  });

  it("[patch] a write-less body answers the effective zone too (and still converges drift)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const seeded = await seedTripRow(owner.userId, {
      destinationTz: "Asia/Tokyo",
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    }); // stored 'planning', effective 'active'
    const patched = TripSchema.parse(await (await patchTrip(seeded.id, owner.token, {})).json());
    expect(patched.destination_tz).toBe("Asia/Tokyo");
    expect(patched.status).toBe("active");
    expect((await dbTrip(seeded.id)).updatedAt.toISOString()).toBe(seeded.updatedAt.toISOString());
  });

  // ===========================================================================
  // Invalid explicit zones → 400, nothing written
  // ===========================================================================

  it("[validation] POST: an explicit zone the runtime's Intl rejects → 400 VALIDATION_FAILED, no row", async () => {
    const owner = await seedUser();
    const res = await postTrip(
      owner.token,
      tripBody(
        KYOTO,
        { start: "2026-09-01", end: "2026-09-05" },
        { destination_tz: "Mars/Phobos" },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toEqual({ destination_tz: "unknown time zone" });
    const rows = await db
      .select({ id: schema.trips.id })
      .from(schema.trips)
      .where(eq(schema.trips.createdBy, owner.userId));
    expect(rows).toEqual([]);
    // Falsification: delete the `isValidTimeZone` gate in the POST handler → 201 with a junk zone stored.
  });

  it("[validation] POST: shape-invalid zones (offset-style, empty, over the 64-char cap, wrong type) → 400 at the schema", async () => {
    const owner = await seedUser();
    for (const bad of ["+09:00", "", "Asia/Tokyo; drop", `A${"b".repeat(64)}`, 9, null]) {
      const res = await postTrip(
        owner.token,
        tripBody(KYOTO, { start: "2026-09-01", end: "2026-09-05" }, { destination_tz: bad }),
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("[validation] PATCH: an unknown zone → 400 and the row is untouched", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-09-01", end: "2026-09-05" });
    const before = await dbTrip(trip.id);

    const res = await patchTrip(trip.id, owner.token, { destination_tz: "Mars/Phobos", name: "x" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    const after = await dbTrip(trip.id);
    expect(after.destinationTz).toBe("Asia/Tokyo");
    expect(after.name).toBe(before.name); // the valid sibling field did not slip through
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it("[validation] a 64-char IANA-shaped id passes the SCHEMA but the engine still has the last word (400, not a stored junk zone)", async () => {
    const owner = await seedUser();
    const res = await postTrip(
      owner.token,
      tripBody(
        KYOTO,
        { start: "2026-09-01", end: "2026-09-05" },
        { destination_tz: `A${"b".repeat(63)}` },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.details).toEqual({
      destination_tz: "unknown time zone",
    });
  });

  // ===========================================================================
  // DB CHECK (migration 0007)
  // ===========================================================================

  it("[migration 0007] trips_destination_tz_ck: 1..64 chars or NULL — 64 inserts, 65 and empty are 23514", async () => {
    const owner = await seedUser();
    const base = {
      name: "Check",
      destinationName: "Check",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      createdBy: owner.userId,
    };
    await db.insert(schema.trips).values({ ...base, destinationTz: "A".repeat(64) });
    await db.insert(schema.trips).values({ ...base, destinationTz: null });
    for (const bad of ["A".repeat(65), ""]) {
      await expect(
        db.insert(schema.trips).values({ ...base, destinationTz: bad }),
      ).rejects.toSatisfy((err: unknown) => isCheckViolationOf(err, "trips_destination_tz_ck"));
    }
    // The raw catalog row exists exactly as the migration declares it.
    const [constraint] = await client<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'trips_destination_tz_ck'`;
    // Postgres normalizes BETWEEN into the two comparisons.
    expect(constraint?.def).toContain("length(destination_tz) >= 1");
    expect(constraint?.def).toContain("length(destination_tz) <= 64");
  });
});
