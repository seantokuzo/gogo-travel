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
import { todayInZone } from "@gogo/shared/time";
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
      status?: "idea" | "planned" | "booked" | "cancelled";
    },
  ) {
    await db.insert(schema.bookings).values({
      tripId,
      createdBy: userId,
      category: opts.category ?? "flight",
      ...(opts.status === undefined ? {} : { status: opts.status }),
      title: `Booking ${uniq()}`,
      details: {
        category: opts.category ?? "flight",
        ...(opts.arrivesTz === undefined ? {} : { arrives_tz: opts.arrivesTz }),
        ...(opts.departsTz === undefined ? {} : { departs_tz: opts.departsTz }),
      } as never, // raw jsonb: the zone fields are all this suite reads
      startsAt: opts.startsAt === null ? null : new Date(opts.startsAt),
    });
  }

  /**
   * The trip a "serve the STORED pair" variant gets wrong (round-1 fix-verifier Adv 1): a
   * coordless Osaka trip whose creator was in LA — stored 'device' hint America/Los_Angeles —
   * with a BOOKED KIX flight into Asia/Tokyo. EFFECTIVE = Asia/Tokyo/'booking'; the stored pair
   * (America/Los_Angeles/'device') must never reach the wire, or the client's
   * `todayInZone(now, destination_tz)` lands on LA's day while the server judged the status on
   * Tokyo's (the original B-30 disagreement, back on the list feed).
   */
  async function seedOutrankedDeviceHint(userId: string) {
    const trip = await seedTripRow(userId, {
      destinationName: "Osaka (custom)",
      destinationTz: "America/Los_Angeles",
      destinationTzSource: "device",
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    });
    await seedFlight(trip.id, userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Asia/Tokyo", // KIX
      status: "booked",
    });
    return trip;
  }

  /**
   * Whether the CLIENT, re-deriving "today" from the wire zone alone (what mobile's `isTripActive`
   * does), would call this trip active. Server and client agree iff this equals `status === "active"`.
   */
  const clientCallsActive = (item: {
    destination_tz: string;
    start_date: string;
    end_date: string;
  }) => {
    const today = todayInZone(clock, item.destination_tz);
    return today >= item.start_date && today <= item.end_date; // ISO dates order lexicographically
  };

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

  it("[list] one page, one clock, six rows: stored zones of each source, a LEGACY NULL row (derived lazily), a coordless-with-flight row (booking) and a stored device hint a BOOKING outranks — each reconciled at ITS OWN today, wire zone + source per row (the effective pair, never the stored one), no updated_at moves", async () => {
    clock = new Date("2026-08-02T03:00:00.000Z"); // Tokyo Aug 2 12:00 · UTC Aug 2 · LA Aug 1 20:00
    const owner = await seedUser();
    const dates = { startDate: "2026-08-02", endDate: "2026-08-02" };
    const seed = (tz: string, source: "user" | "derived" | "device" = "user") =>
      seedTripRow(owner.userId, { ...dates, destinationTz: tz, destinationTzSource: source });
    const tokyo = await seed("Asia/Tokyo");
    const utc = await seed("UTC");
    const la = await seed("America/Los_Angeles", "derived"); // all stored 'planning' (the column default)
    // The rows P3 ("LIST serializes the stored column") would have gotten wrong:
    const legacy = await seedTripRow(owner.userId, {
      ...dates,
      destinationName: KYOTO.name,
      destinationLat: String(KYOTO.lat),
      destinationLng: String(KYOTO.lng),
      destinationTz: null,
      destinationTzSource: null,
    }); // pre-0007 shape: NULL/NULL with coordinates -> Tokyo, derived lazily
    const flightOnly = await seedTripRow(owner.userId, { ...dates }); // coordless, NULL/NULL
    await seedFlight(flightOnly.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Asia/Tokyo",
    });
    // A STORED pair is present (LA/'device') and a booked KIX flight outranks it.
    const outranked = await seedOutrankedDeviceHint(owner.userId);

    const page = PaginatedTripList.parse(await (await listTrips(owner.token)).json());
    const byId = new Map(page.items.map((item) => [item.id, item]));
    const wire = (id: string) => {
      const item = byId.get(id);
      return [item?.destination_tz, item?.destination_tz_source, item?.status];
    };
    expect(wire(tokyo.id)).toEqual(["Asia/Tokyo", "user", "active"]);
    expect(wire(utc.id)).toEqual(["UTC", "user", "active"]);
    expect(wire(la.id)).toEqual(["America/Los_Angeles", "derived", "planning"]); // LA is still Aug 1
    expect(wire(legacy.id)).toEqual(["Asia/Tokyo", "derived", "active"]); // lazily derived, NOT "UTC"
    expect(wire(flightOnly.id)).toEqual(["Asia/Tokyo", "booking", "active"]); // booking zone, NOT "UTC"
    // The EFFECTIVE pair, not the stored America/Los_Angeles/'device' one — and status judged in Tokyo
    // (LA is still Aug 1 here, so an LA zone beside an 'active' status is the F1 disagreement).
    expect(wire(outranked.id)).toEqual(["Asia/Tokyo", "booking", "active"]);
    // The client's re-check, from the wire zone alone, must reproduce every row's server status.
    expect(page.items).toHaveLength(6);
    for (const item of page.items) {
      expect(clientCallsActive(item), `${item.id} (${item.destination_tz})`).toBe(
        item.status === "active",
      );
    }

    expect((await dbTrip(tokyo.id)).status).toBe("active");
    expect((await dbTrip(utc.id)).status).toBe("active");
    expect((await dbTrip(la.id)).status).toBe("planning");
    expect((await dbTrip(legacy.id)).status).toBe("active"); // stored status converged under the lazy zone
    expect((await dbTrip(flightOnly.id)).status).toBe("active");
    expect((await dbTrip(outranked.id)).status).toBe("active");
    for (const seeded of [tokyo, utc, la, legacy, flightOnly, outranked]) {
      expect((await dbTrip(seeded.id)).updatedAt.toISOString()).toBe(
        seeded.updatedAt.toISOString(),
      );
    }
    // The lazy zones are never written back:
    expect((await dbTrip(legacy.id)).destinationTz).toBeNull();
    expect((await dbTrip(flightOnly.id)).destinationTz).toBeNull();
    // ...and the stored hint under the booking is never rewritten either:
    expect(await storedOf(outranked.id)).toEqual(["America/Los_Angeles", "device"]);
    // Falsification: evaluate the whole page at one `today` → the rows cannot all hold;
    // serialize the STORED column (P3) → legacy / flightOnly read "UTC"/"default", red;
    // hand `toTripListItemWire` the STORED pair when one exists (fix-verifier Adv 1) → `outranked`
    // reads America/Los_Angeles/device, red (wire pair AND the client re-check).
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
    expect(trip.destination_tz_source).toBe("user");
    // Auckland says Aug 2 → active; the Kyoto-derived Tokyo zone (Aug 1) and UTC (Aug 1) both say planning.
    expect(trip.status).toBe("active");
    const row = await dbTrip(trip.id);
    expect([row.destinationTz, row.destinationTzSource]).toEqual(["Pacific/Auckland", "user"]);
  });

  it("[create] a coordinate-less custom destination with a 'device' hint (what the mobile form sends) stores it as 'device' and judges status in it", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Grandma's cabin", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
      { destination_tz: "Asia/Tokyo", destination_tz_source: "device" },
    );
    expect(trip.destination_lat).toBeNull();
    expect([trip.destination_tz, trip.destination_tz_source]).toEqual(["Asia/Tokyo", "device"]);
    expect(trip.status).toBe("active");
    const row = await dbTrip(trip.id);
    expect([row.destinationTz, row.destinationTzSource]).toEqual(["Asia/Tokyo", "device"]);
  });

  it("[create] a coordinate-less custom destination with a USER zone stores it as 'user'", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Grandma's cabin", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
      { destination_tz: "asia/tokyo", destination_tz_source: "user" },
    );
    expect([trip.destination_tz, trip.destination_tz_source]).toEqual(["Asia/Tokyo", "user"]);
    const row = await dbTrip(trip.id);
    expect([row.destinationTz, row.destinationTzSource]).toEqual(["Asia/Tokyo", "user"]);
  });

  it("[create] coordless + no explicit zone + no bookings → effective UTC; the column stays NULL (a default is never persisted)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Somewhere", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
    );
    expect([trip.destination_tz, trip.destination_tz_source]).toEqual(["UTC", "default"]);
    expect(trip.status).toBe("planning"); // UTC today Aug 1
    const row = await dbTrip(trip.id);
    expect([row.destinationTz, row.destinationTzSource]).toEqual([null, null]);
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

  it("[patch] a write-less body answers the effective zone + source too (and still converges drift)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const seeded = await seedTripRow(owner.userId, {
      destinationTz: "Asia/Tokyo",
      destinationTzSource: "user",
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    }); // stored 'planning', effective 'active'
    const patched = TripSchema.parse(await (await patchTrip(seeded.id, owner.token, {})).json());
    expect([patched.destination_tz, patched.destination_tz_source]).toEqual(["Asia/Tokyo", "user"]);
    expect(patched.status).toBe("active");
    expect((await dbTrip(seeded.id)).updatedAt.toISOString()).toBe(seeded.updatedAt.toISOString());
  });

  // The two PATCH paths P10 ("write path returns stored ?? UTC") would have broken: a rename
  // on a LEGACY NULL/NULL row must answer the EFFECTIVE zone, on both the write path and the
  // write-less path, and must not write the lazily-resolved zone back.
  const legacyKyoto = (userId: string) =>
    seedTripRow(userId, {
      destinationName: KYOTO.name,
      destinationLat: String(KYOTO.lat),
      destinationLng: String(KYOTO.lng),
      destinationTz: null,
      destinationTzSource: null,
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    });

  it("[patch] a rename on a legacy NULL-zone row (WRITE path) answers Asia/Tokyo + 'derived', judges status there, and writes no zone", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z"); // Tokyo Aug 2 · UTC Aug 1
    const owner = await seedUser();
    const legacy = await legacyKyoto(owner.userId);
    const patched = TripSchema.parse(
      await (await patchTrip(legacy.id, owner.token, { name: "Renamed" })).json(),
    );
    expect([patched.destination_tz, patched.destination_tz_source]).toEqual([
      "Asia/Tokyo",
      "derived",
    ]);
    expect(patched.status).toBe("active"); // Tokyo-today Aug 2 (the UTC rule said planning)
    const row = await dbTrip(legacy.id);
    expect(row.name).toBe("Renamed"); // it WAS a write
    expect([row.destinationTz, row.destinationTzSource]).toEqual([null, null]);
    // Falsification (P10): answer `stored ?? "UTC"` from the PATCH write path -> "UTC"/"default", red.
  });

  it("[patch] a rename on a trip whose stored 'device' hint a booking outranks (WRITE path) answers the EFFECTIVE Asia/Tokyo + 'booking' — not the stored LA/'device' pair — and judges status there", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z"); // Tokyo Aug 2 05:00 · LA Aug 1 13:00
    const owner = await seedUser();
    const trip = await seedOutrankedDeviceHint(owner.userId); // stored 'planning'; Tokyo says active
    const patched = TripSchema.parse(
      await (await patchTrip(trip.id, owner.token, { name: "Renamed" })).json(),
    );
    expect(sourcesOf(patched)).toEqual(["Asia/Tokyo", "booking"]);
    expect(patched.status).toBe("active"); // Tokyo-today Aug 2 (LA's Aug 1 says planning)
    expect(clientCallsActive(patched)).toBe(true); // the client's re-check agrees
    const row = await dbTrip(trip.id);
    expect(row.name).toBe("Renamed"); // it WAS a write
    expect(row.status).toBe("active"); // stored status converged under the booking zone
    expect([row.destinationTz, row.destinationTzSource]).toEqual(["America/Los_Angeles", "device"]);
    // Falsification (fix-verifier Adv 1): return the STORED pair from the write path
    // (`zone: storedZoneOf(row) ?? nextZone`) -> America/Los_Angeles/device, red.
  });

  it("[patch] a write-less body on that trip (WRITE-LESS path) answers the EFFECTIVE Asia/Tokyo + 'booking' and converges status without moving updated_at", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await seedOutrankedDeviceHint(owner.userId);
    const patched = TripSchema.parse(await (await patchTrip(trip.id, owner.token, {})).json());
    expect(sourcesOf(patched)).toEqual(["Asia/Tokyo", "booking"]);
    expect(patched.status).toBe("active");
    expect(clientCallsActive(patched)).toBe(true);
    const row = await dbTrip(trip.id);
    expect(row.status).toBe("active"); // drift converged
    expect(row.updatedAt.toISOString()).toBe(trip.updatedAt.toISOString()); // write-less never bumps it
    expect([row.destinationTz, row.destinationTzSource]).toEqual(["America/Los_Angeles", "device"]);
    // Falsification: return the STORED pair from the write-less path
    // (`zone: storedZoneOf(current) ?? reconciled.zone`) -> America/Los_Angeles/device, red.
  });

  it("[patch] a write-less body on a legacy NULL-zone row (WRITE-LESS path) answers Asia/Tokyo + 'derived' and converges status", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const legacy = await legacyKyoto(owner.userId);
    const patched = TripSchema.parse(await (await patchTrip(legacy.id, owner.token, {})).json());
    expect([patched.destination_tz, patched.destination_tz_source, patched.status]).toEqual([
      "Asia/Tokyo",
      "derived",
      "active",
    ]);
    const row = await dbTrip(legacy.id);
    expect(row.updatedAt.toISOString()).toBe(legacy.updatedAt.toISOString());
    expect([row.destinationTz, row.destinationTzSource]).toEqual([null, null]);
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
  // Zone allow-list (zone-canon.ts) — round-1 server F3
  // ===========================================================================

  it("[validator] an explicit zone is stored in its canonical modern spelling (lowercase asia/tokyo -> Asia/Tokyo)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Cabin", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
      { destination_tz: "asia/tokyo" },
    );
    expect(trip.destination_tz).toBe("Asia/Tokyo");
    expect((await dbTrip(trip.id)).destinationTz).toBe("Asia/Tokyo");
    const patched = TripSchema.parse(
      await (await patchTrip(trip.id, owner.token, { destination_tz: "EUROPE/PARIS" })).json(),
    );
    expect(patched.destination_tz).toBe("Europe/Paris");
    expect((await dbTrip(trip.id)).destinationTz).toBe("Europe/Paris");
  });

  it("[validator] V8-resolvable ids that Hermes' NSTimeZone lacks are REJECTED on POST and PATCH (SystemV/*, Japan, EST, Zulu)", async () => {
    const owner = await seedUser();
    const base = await createTrip(owner.token, KYOTO, { start: "2026-09-01", end: "2026-09-05" });
    for (const bad of ["SystemV/AST4", "Japan", "EST", "Zulu"]) {
      const created = await postTrip(
        owner.token,
        tripBody(KYOTO, { start: "2026-09-01", end: "2026-09-05" }, { destination_tz: bad }),
      );
      expect([bad, created.status]).toEqual([bad, 400]);
      const patched = await patchTrip(base.id, owner.token, { destination_tz: bad });
      expect([bad, patched.status]).toEqual([bad, 400]);
    }
    expect((await dbTrip(base.id)).destinationTz).toBe("Asia/Tokyo"); // untouched
  });

  it("[validator] booking-zone fallback canonicalises too: lowercase arrives_tz is served as Asia/Tokyo; SystemV/* is skipped for the next candidate", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const dates = { startDate: "2026-08-02", endDate: "2026-08-02" };
    const zoneOf = async (tripId: string) =>
      TripSchema.parse(await (await getTrip(tripId, owner.token)).json()).destination_tz;

    const lower = await seedTripRow(owner.userId, dates);
    await seedFlight(lower.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "asia/tokyo",
    });
    expect(await zoneOf(lower.id)).toBe("Asia/Tokyo");

    const systemV = await seedTripRow(owner.userId, dates);
    await seedFlight(systemV.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "SystemV/AST4",
      departsTz: "Europe/Paris",
    });
    expect(await zoneOf(systemV.id)).toBe("Europe/Paris");
  });

  // ===========================================================================
  // Zone provenance (round-1 decision): user > derived > booking > device > UTC
  // ===========================================================================

  const OSAKA = { name: "Osaka, Japan", lat: 34.6937, lng: 135.5023 }; // Asia/Tokyo
  const COORDLESS = { name: "Somewhere custom", lat: null, lng: null };
  const sourcesOf = (t: { destination_tz: string; destination_tz_source: string }) => [
    t.destination_tz,
    t.destination_tz_source,
  ];
  const storedOf = async (tripId: string) => {
    const row = await dbTrip(tripId);
    return [row.destinationTz, row.destinationTzSource];
  };

  it("[provenance F1] a coordless Osaka trip created in LA (device hint) is CORRECTED by a later KIX flight — the booking zone outranks the device hint; the stored hint is never rewritten", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z"); // LA Aug 1 13:00 · Tokyo Aug 2 05:00
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      { name: "Osaka (custom)", lat: null, lng: null },
      { start: "2026-08-02", end: "2026-08-02" },
      { destination_tz: "America/Los_Angeles", destination_tz_source: "device" },
    );
    expect(sourcesOf(trip)).toEqual(["America/Los_Angeles", "device"]);
    expect(trip.status).toBe("planning"); // LA is still Aug 1

    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Asia/Tokyo", // KIX
      status: "booked",
    });
    const read = TripWithRoleSchema.parse(await (await getTrip(trip.id, owner.token)).json());
    expect(sourcesOf(read)).toEqual(["Asia/Tokyo", "booking"]);
    expect(read.status).toBe("active"); // judged on Tokyo's day, same zone as the wire
    expect(await storedOf(trip.id)).toEqual(["America/Los_Angeles", "device"]); // never written back
    // Falsification: rank the device hint above bookings (the pre-decision "explicit" slot) -> stays LA/planning, red.
  });

  it("[provenance] a USER zone outranks a booking zone (a person's choice is never auto-corrected)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      COORDLESS,
      { start: "2026-08-02", end: "2026-08-02" },
      { destination_tz: "America/Los_Angeles", destination_tz_source: "user" },
    );
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Asia/Tokyo",
      status: "booked",
    });
    const read = TripSchema.parse(await (await getTrip(trip.id, owner.token)).json());
    expect(sourcesOf(read)).toEqual(["America/Los_Angeles", "user"]);
    expect(read.status).toBe("planning");
  });

  it("[provenance] an UNUSABLE device hint is IGNORED, never a 400: coordless -> UTC/default with nothing stored; with coordinates -> derived", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    for (const hint of ["SystemV/AST4", "Not/AZone", "GMT+05:30", ""]) {
      const coordless = await postTrip(
        owner.token,
        tripBody(
          COORDLESS,
          { start: "2026-09-01", end: "2026-09-05" },
          { destination_tz: hint, destination_tz_source: "device" },
        ),
      );
      expect([hint, coordless.status]).toEqual([hint, 201]);
      const created = TripWithRoleSchema.parse(await coordless.json());
      expect([hint, ...sourcesOf(created)]).toEqual([hint, "UTC", "default"]);
      expect([hint, ...(await storedOf(created.id))]).toEqual([hint, null, null]);
    }
    // A VALID hint with coordinates is ignored too (derived outranks device) and stores the derivation.
    const withCoords = await createTrip(
      owner.token,
      KYOTO,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "America/Los_Angeles", destination_tz_source: "device" },
    );
    expect(sourcesOf(withCoords)).toEqual(["Asia/Tokyo", "derived"]);
    expect(await storedOf(withCoords.id)).toEqual(["Asia/Tokyo", "derived"]);
    // Falsification: 400 on an unusable device hint -> the first request is 400, red.
  });

  it("[provenance] a USER zone the allow-list rejects stays a 400 even when a device hint rides elsewhere on the call", async () => {
    const owner = await seedUser();
    const res = await postTrip(
      owner.token,
      tripBody(
        COORDLESS,
        { start: "2026-09-01", end: "2026-09-05" },
        { destination_tz: "SystemV/AST4" },
      ),
    );
    expect(res.status).toBe(400);
  });

  // ---- PATCH: durability, re-derive, clear, heal, reset ------------------------

  it("[provenance F4] a USER zone is durable under coordinate edits: a nudge AND a big move leave it alone (only a reset clears it)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      KYOTO,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland", destination_tz_source: "user" },
    );
    const nudge = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_name: OSAKA.name,
          destination_lat: OSAKA.lat,
          destination_lng: OSAKA.lng,
        })
      ).json(),
    );
    expect(sourcesOf(nudge)).toEqual(["Pacific/Auckland", "user"]);
    const big = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_lat: LOS_ANGELES.lat,
          destination_lng: LOS_ANGELES.lng,
        })
      ).json(),
    );
    expect(sourcesOf(big)).toEqual(["Pacific/Auckland", "user"]);
    expect(await storedOf(trip.id)).toEqual(["Pacific/Auckland", "user"]);
    // Falsification: re-derive on a coordinates move regardless of source -> America/Los_Angeles/derived, red.
  });

  it("[provenance] a coordinates->coordless move clears a DERIVED zone but KEEPS a user zone", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const derived = await createTrip(owner.token, KYOTO, {
      start: "2026-09-01",
      end: "2026-09-05",
    });
    const user = await createTrip(
      owner.token,
      KYOTO,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland" },
    );
    const goCoordless = {
      destination_name: "Custom",
      destination_lat: null,
      destination_lng: null,
    };
    const a = TripSchema.parse(
      await (await patchTrip(derived.id, owner.token, goCoordless)).json(),
    );
    const b = TripSchema.parse(await (await patchTrip(user.id, owner.token, goCoordless)).json());
    expect(sourcesOf(a)).toEqual(["UTC", "default"]);
    expect(await storedOf(derived.id)).toEqual([null, null]);
    expect(sourcesOf(b)).toEqual(["Pacific/Auckland", "user"]);
    expect(await storedOf(user.id)).toEqual(["Pacific/Auckland", "user"]);
  });

  it("[provenance] the settings path: moving to a coordinate-less place WITH a device hint stores 'device' (a booking, if any, still outranks it)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-08-02", end: "2026-08-02" });
    const patched = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_name: "Custom",
          destination_lat: null,
          destination_lng: null,
          destination_tz: "America/Los_Angeles",
          destination_tz_source: "device",
        })
      ).json(),
    );
    expect(sourcesOf(patched)).toEqual(["America/Los_Angeles", "device"]);
    expect(patched.status).toBe("planning"); // LA Aug 1
    expect(await storedOf(trip.id)).toEqual(["America/Los_Angeles", "device"]);

    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Asia/Tokyo",
      status: "booked",
    });
    const read = TripSchema.parse(await (await getTrip(trip.id, owner.token)).json());
    expect(sourcesOf(read)).toEqual(["Asia/Tokyo", "booking"]);
  });

  it("[provenance] gaining coordinates (the settings heal) replaces a device hint with the derived zone", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(
      owner.token,
      COORDLESS,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "America/Los_Angeles", destination_tz_source: "device" },
    );
    const healed = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_name: KYOTO.name,
          destination_lat: KYOTO.lat,
          destination_lng: KYOTO.lng,
        })
      ).json(),
    );
    expect(sourcesOf(healed)).toEqual(["Asia/Tokyo", "derived"]);
    expect(await storedOf(trip.id)).toEqual(["Asia/Tokyo", "derived"]);
  });

  it("[provenance] a device hint never overwrites a user zone, and an UNUSABLE hint on PATCH is ignored (200, unchanged)", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const userTrip = await createTrip(
      owner.token,
      COORDLESS,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland" },
    );
    const deviceTrip = await createTrip(
      owner.token,
      COORDLESS,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "America/Los_Angeles", destination_tz_source: "device" },
    );
    const overwrite = await patchTrip(userTrip.id, owner.token, {
      name: "x",
      destination_tz: "America/Los_Angeles",
      destination_tz_source: "device",
    });
    expect(overwrite.status).toBe(200);
    expect(await storedOf(userTrip.id)).toEqual(["Pacific/Auckland", "user"]);
    const junk = await patchTrip(deviceTrip.id, owner.token, {
      name: "y",
      destination_tz: "SystemV/AST4",
      destination_tz_source: "device",
    });
    expect(junk.status).toBe(200);
    expect(await storedOf(deviceTrip.id)).toEqual(["America/Los_Angeles", "device"]);
  });

  it("[provenance] destination_tz: null RESETS to automatic: a user zone is cleared and the coordinates re-derive; coordless clears to NULL/NULL", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const withCoords = await createTrip(
      owner.token,
      KYOTO,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland" },
    );
    const reset = TripSchema.parse(
      await (await patchTrip(withCoords.id, owner.token, { destination_tz: null })).json(),
    );
    expect(sourcesOf(reset)).toEqual(["Asia/Tokyo", "derived"]);
    expect(await storedOf(withCoords.id)).toEqual(["Asia/Tokyo", "derived"]);

    const coordless = await createTrip(
      owner.token,
      COORDLESS,
      { start: "2026-09-01", end: "2026-09-05" },
      { destination_tz: "Pacific/Auckland" },
    );
    const cleared = TripSchema.parse(
      await (await patchTrip(coordless.id, owner.token, { destination_tz: null })).json(),
    );
    expect(sourcesOf(cleared)).toEqual(["UTC", "default"]);
    expect(await storedOf(coordless.id)).toEqual([null, null]);
    // Falsification: 400 / ignore a null destination_tz -> the zone stays Pacific/Auckland, red.
  });

  it("[provenance] a source without a zone, or null WITH a source, is a 400 (nothing written)", async () => {
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-09-01", end: "2026-09-05" });
    const before = await dbTrip(trip.id);
    for (const body of [
      { destination_tz_source: "user" },
      { destination_tz_source: "device" },
      { destination_tz: null, destination_tz_source: "user" },
      { destination_tz: "Asia/Tokyo", destination_tz_source: "derived" },
    ]) {
      const res = await patchTrip(trip.id, owner.token, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await dbTrip(trip.id)).updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  // ---- Booking rung: cancelled excluded, booked > planned > idea, earliest within ----

  it("[provenance] CANCELLED flights never supply the zone (only-cancelled -> UTC/default); a cancelled earlier flight is skipped for the live one", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const dates = { startDate: "2026-08-02", endDate: "2026-08-02" };
    const read = async (tripId: string) =>
      TripSchema.parse(await (await getTrip(tripId, owner.token)).json());

    const onlyCancelled = await seedTripRow(owner.userId, dates);
    await seedFlight(onlyCancelled.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Europe/Paris",
      status: "cancelled",
    });
    expect(sourcesOf(await read(onlyCancelled.id))).toEqual(["UTC", "default"]);

    const skipsCancelled = await seedTripRow(owner.userId, dates);
    await seedFlight(skipsCancelled.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Europe/Paris",
      status: "cancelled",
    });
    await seedFlight(skipsCancelled.id, owner.userId, {
      startsAt: "2026-08-05T01:00:00Z",
      arrivesTz: "Asia/Tokyo",
      status: "booked",
    });
    expect(sourcesOf(await read(skipsCancelled.id))).toEqual(["Asia/Tokyo", "booking"]);
    // Falsification: drop the `status <> 'cancelled'` filter -> Europe/Paris, red.
  });

  it("[provenance] booked beats planned beats idea (even when the idea is earlier); within one status the EARLIEST wins", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const dates = { startDate: "2026-08-02", endDate: "2026-08-02" };
    const trip = await seedTripRow(owner.userId, dates);
    const zone = async () =>
      TripSchema.parse(await (await getTrip(trip.id, owner.token)).json()).destination_tz;

    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "Europe/Paris",
      status: "idea",
    });
    expect(await zone()).toBe("Europe/Paris"); // the only (idea) flight
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-09T01:00:00Z",
      arrivesTz: "America/Chicago",
      status: "planned",
    });
    expect(await zone()).toBe("America/Chicago"); // planned beats the EARLIER idea
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-20T01:00:00Z",
      arrivesTz: "Asia/Tokyo",
      status: "booked",
    });
    expect(await zone()).toBe("Asia/Tokyo"); // booked beats both, though latest
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-10T01:00:00Z",
      arrivesTz: "Australia/Sydney",
      status: "booked",
    });
    expect(await zone()).toBe("Australia/Sydney"); // earliest of the booked pair
    // Falsification: order by starts_at alone -> Europe/Paris first, red.
  });

  it("[provenance] KNOWN LIMIT: the earliest booked leg can be a CONNECTION (SFO->ORD->KIX picks Chicago) — a user zone is the override", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await seedTripRow(owner.userId, {
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    });
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T01:00:00Z",
      arrivesTz: "America/Chicago",
      status: "booked",
    });
    await seedFlight(trip.id, owner.userId, {
      startsAt: "2026-08-02T05:00:00Z",
      arrivesTz: "Asia/Tokyo",
      status: "booked",
    });
    const read = TripSchema.parse(await (await getTrip(trip.id, owner.token)).json());
    expect(sourcesOf(read)).toEqual(["America/Chicago", "booking"]); // documented limit, not a goal

    const fixed = TripSchema.parse(
      await (
        await patchTrip(trip.id, owner.token, {
          destination_tz: "Asia/Tokyo",
          destination_tz_source: "user",
        })
      ).json(),
    );
    expect(sourcesOf(fixed)).toEqual(["Asia/Tokyo", "user"]);
  });

  // ===========================================================================
  // Concurrency (round-1 server F6)
  // ===========================================================================

  /**
   * Resolves with the SQL text of the first backend (other than `exceptPid`) seen waiting on a
   * heavyweight lock in THIS database — a request that has provably reached a row/transaction
   * lock and is blocked there. Event-driven (polls `pg_stat_activity` every 10 ms, bounded), not a
   * sleep: the answer is "blocked now", however slow the machine is.
   */
  async function waitForLockWaiter(exceptPid: number, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const waiting = await client<{ query: string }[]>`
        select query from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> ${exceptPid}`;
      if (waiting[0] !== undefined) return waiting[0].query;
      if (Date.now() > deadline) {
        throw new Error(
          `no backend blocked on a lock within ${timeoutMs} ms — the PATCH never waited`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("[concurrency] a PATCH touching the destination takes the trip row FOR UPDATE: it decides 'moved?' against the row AFTER a concurrent committed move, so zone and coordinates stay consistent", async () => {
    clock = new Date("2026-08-01T20:00:00.000Z");
    const owner = await seedUser();
    const trip = await createTrip(owner.token, KYOTO, { start: "2026-09-01", end: "2026-09-05" });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => {
      signalLocked = resolve;
    });
    // T1: takes the row lock and moves the destination to Los Angeles; it commits only when the
    // test releases the gate (`held`), however long the PATCH takes to arrive.
    const t1 = client.begin(async (tx) => {
      const [self] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await tx`select id from trips where id = ${trip.id} for update`;
      await tx`update trips set destination_lat = ${String(LOS_ANGELES.lat)},
        destination_lng = ${String(LOS_ANGELES.lng)}, destination_tz = 'America/Los_Angeles',
        destination_tz_source = 'derived' where id = ${trip.id}`;
      signalLocked(self?.pid ?? -1);
      await held;
    });
    // If T1 itself fails before taking the lock, surface THAT instead of hanging on the gate.
    const t1Pid = await Promise.race([
      locked,
      t1.then(() => Promise.reject(new Error("T1 finished before the test released it"))),
    ]);
    // The PATCH resubmits the ORIGINAL Kyoto coordinates. Against a STALE snapshot those equal
    // the row's coordinates -> "not moved" -> zone untouched (Los Angeles) beside Kyoto
    // coordinates. Under the lock it re-reads after T1 commits -> LA -> Kyoto is a move -> Tokyo.
    const patching = Promise.resolve(
      patchTrip(trip.id, owner.token, {
        destination_lat: KYOTO.lat,
        destination_lng: KYOTO.lng,
      }),
    ); // Hono's request() is `Response | Promise<Response>`
    void patching.catch(() => undefined); // observed below; keeps a failure path from going unhandled
    let waiterQuery = "";
    try {
      // Hold T1 open until the PATCH is OBSERVED blocked on a lock (no fixed sleep: under load a
      // timer can fire before the request is even scheduled, and a PATCH that only reads the row
      // after T1 commits would pass whatever the lock does — a vacuous pin).
      waiterQuery = await waitForLockWaiter(t1Pid);
    } finally {
      release(); // always: a throw above must not leave T1 holding the row lock
    }
    await t1;
    const res = await patching;
    expect(res.status).toBe(200);
    const row = await dbTrip(trip.id);
    expect(Number(row.destinationLat)).toBeCloseTo(KYOTO.lat, 4);
    expect([row.destinationTz, row.destinationTzSource]).toEqual(["Asia/Tokyo", "derived"]);
    // The blocked statement was the trip-row read taking FOR UPDATE — not some later write.
    expect(waiterQuery).toMatch(/from "trips"/i);
    expect(waiterQuery).toMatch(/for update/i);
    // Falsification: drop `touchesDestination` from the FOR UPDATE condition -> the PATCH reads the
    // pre-T1 row, blocks later on its UPDATE (waiter is no `for update`), and the row ends with
    // Kyoto coordinates and America/Los_Angeles, red.
  });

  // ===========================================================================
  // DB CHECKs (migration 0007)
  // ===========================================================================

  it("[migration 0007] the zone CHECKs: length 1..64 or NULL; source in (user, derived, device) or NULL; the pair moves together", async () => {
    const owner = await seedUser();
    const base = {
      name: "Check",
      destinationName: "Check",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      createdBy: owner.userId,
    };
    const insert = (values: { destinationTz: string | null; destinationTzSource: string | null }) =>
      db.insert(schema.trips).values({ ...base, ...values });
    const violated = (name: string) => (err: unknown) => isCheckViolationOf(err, name);

    await insert({ destinationTz: "A".repeat(64), destinationTzSource: "user" });
    await insert({ destinationTz: "Asia/Tokyo", destinationTzSource: "derived" });
    await insert({ destinationTz: "Asia/Tokyo", destinationTzSource: "device" });
    await insert({ destinationTz: null, destinationTzSource: null });

    for (const bad of ["A".repeat(65), ""]) {
      await expect(insert({ destinationTz: bad, destinationTzSource: "user" })).rejects.toSatisfy(
        violated("trips_destination_tz_ck"),
      );
    }
    // Only the three STORED sources: 'booking' / 'default' are read-time and never persisted.
    for (const bad of ["booking", "default", "explicit", "USER", ""]) {
      await expect(
        insert({ destinationTz: "Asia/Tokyo", destinationTzSource: bad }),
      ).rejects.toSatisfy(violated("trips_destination_tz_source_ck"));
    }
    // The pair: a zone always has a source; a source never floats without a zone.
    await expect(
      insert({ destinationTz: "Asia/Tokyo", destinationTzSource: null }),
    ).rejects.toSatisfy(violated("trips_destination_tz_source_pair_ck"));
    await expect(insert({ destinationTz: null, destinationTzSource: "user" })).rejects.toSatisfy(
      violated("trips_destination_tz_source_pair_ck"),
    );

    // The catalog rows exist exactly as the migration declares them.
    const defs = await client<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname like 'trips_destination_tz%' order by conname`;
    const def = (name: string) => defs.find((row) => row.conname === name)?.def ?? "";
    expect(def("trips_destination_tz_ck")).toContain("length(destination_tz) >= 1");
    expect(def("trips_destination_tz_ck")).toContain("length(destination_tz) <= 64");
    expect(def("trips_destination_tz_source_ck")).toContain("'user'");
    expect(def("trips_destination_tz_source_ck")).toContain("'derived'");
    expect(def("trips_destination_tz_source_ck")).toContain("'device'");
    expect(def("trips_destination_tz_source_pair_ck")).toContain("destination_tz IS NULL");
  });
});
