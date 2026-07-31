/**
 * T-7.1 bookings integration suite (IB-1): GET/POST list+create,
 * GET/PATCH/DELETE detail, POST schedule — end-to-end over a real Postgres,
 * behind the real app-wide `requireAuth` + `requireTripMember` gates. Covers
 * every §3.4 "Tests required" bullet for the six endpoints PLUS the full
 * §3.2 transition matrix (all 12 ordered pairs + same-status no-op), the
 * §3.1 invariants' side effects (I-1..I-4), the I-3 → I-2 precedence rule,
 * the F-038 IDOR harness on trip AND booking ids, R-ib-7's expense-link
 * survival, and the dirty-day seam contract (post-commit marks; a throwing
 * marker never fails a request; an aborted transaction never marks).
 *
 * Headline adversarial assertions: auto-item atomicity via a REAL forced
 * item-insert failure (DB trigger) rolling back the booking row (R-ib-5
 * "in the same transaction"); item-ID stability across I-2 resyncs (legs
 * and client caches key on item ids); the three-part NULLS-LAST keyset
 * cursor walked across the timed→timeless boundary.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. No network beyond the local container (Law #5). Run the server DB
 * suites with `--no-file-parallelism` (Testcontainers contention, QUEUE P1).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import {
  BookingSchema,
  BookingWithItemsSchema,
  type Booking,
  type BookingWithItems,
} from "@gogo/shared/domains/booking";
import { TripWithRoleSchema } from "@gogo/shared/domains/trip";
import type { BookingStatus, TripMemberRole } from "@gogo/shared/enums";
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
import type { DirtyDayMark } from "./dirty-days.js";

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
      "║  DOCKER UNAVAILABLE — T-7.1 BOOKINGS SUITE SKIPPED                ║\n" +
      "║  Booking CRUD + schedule, the §3.2 transition matrix, §3.1        ║\n" +
      "║  invariants I-1..I-4, the F-038 IDOR harness, auto-item           ║\n" +
      "║  atomicity, and the dirty-day seam (itinerary-bookings spec       ║\n" +
      "║  §3.1–§3.4, R-ib-1..12/18/24) were NOT verified. Start Docker     ║\n" +
      "║  and re-run `pnpm --filter @gogo/server test` before treating     ║\n" +
      "║  this green.                                                      ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-7.1 bookings suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-7.1 bookings suite could " +
        "not verify itinerary-bookings spec §3.1–§3.4 (R-ib-1..12/18/24). " +
        "A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

const PaginatedBookingsSchema = paginatedSchema(BookingSchema);

/** Recording dirty-day marker: every post-commit call, in order. */
function createRecordingMarker() {
  const calls: DirtyDayMark[][] = [];
  return {
    calls,
    marker: {
      markDaysDirty(marks: readonly DirtyDayMark[]) {
        calls.push([...marks]);
      },
    },
  };
}

describe.skipIf(!dockerAvailable)("T-7.1 bookings routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let authDeps: AuthRouterDeps;
  let signer: AccessTokenSigner;
  let dirtyCalls: DirtyDayMark[][];

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
    const recording = createRecordingMarker();
    dirtyCalls = recording.calls;
    app = createApp({
      auth: authDeps,
      trips: { db },
      bookings: { db, dirtyDays: recording.marker },
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `bookings-${uniq()}@example.com`,
      displayName: "Booking Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
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

  const listBookings = (tripId: string, token: string, query = "") =>
    request(`/api/trips/${tripId}/bookings${query}`, token);
  const postBooking = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/bookings`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const getBooking = (tripId: string, bookingId: string, token: string) =>
    request(`/api/trips/${tripId}/bookings/${bookingId}`, token);
  const patchBooking = (tripId: string, bookingId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/bookings/${bookingId}`, token, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  const deleteBooking = (tripId: string, bookingId: string, token: string) =>
    request(`/api/trips/${tripId}/bookings/${bookingId}`, token, { method: "DELETE" });
  const scheduleBooking = (tripId: string, bookingId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/bookings/${bookingId}/schedule`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });

  async function createTripVia(token: string) {
    const res = await request("/api/trips", token, {
      method: "POST",
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

  /** Create a booking through the API; returns the parsed wire booking. */
  async function createBookingVia(
    tripId: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<Booking> {
    const res = await postBooking(tripId, token, body);
    expect(res.status).toBe(201);
    return BookingSchema.parse(await res.json());
  }

  const FLIGHT_DETAILS = {
    category: "flight",
    flight_number: "UA 837",
    departs_at: "2026-09-01T11:05:00-07:00",
    arrives_at: "2026-09-02T14:25:00+09:00",
  };

  const dbItems = (bookingId: string) =>
    db
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.bookingId, bookingId))
      .orderBy(schema.itineraryItems.day, schema.itineraryItems.sortOrder);

  const dbBooking = async (bookingId: string) => {
    const [row] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    return row;
  };

  // ===========================================================================
  // POST /trips/:tripId/bookings (§3.4; R-ib-1/4/5/11/12/24)
  // ===========================================================================

  it("POST: happy path per all 8 categories — valid details parse, unknown keys stripped", async () => {
    const { owner, trip } = await seedCollabTrip();
    const detailsByCategory: Record<string, Record<string, unknown>> = {
      lodging: { category: "lodging", property_name: "Park Hyatt", junk_key: 1 },
      flight: { category: "flight", flight_number: "UA 837", junk_key: 1 },
      train: { category: "train", train_number: "Nozomi 21", junk_key: 1 },
      car_rental: { category: "car_rental", company: "Toyota", junk_key: 1 },
      moped_rental: { category: "moped_rental", company: "Kyoto Scooters", junk_key: 1 },
      activity: { category: "activity", venue_name: "teamLab", junk_key: 1 },
      restaurant: { category: "restaurant", party_size: 2, junk_key: 1 },
      other: { category: "other", description: "Onsen", junk_key: 1 },
    };
    for (const [category, details] of Object.entries(detailsByCategory)) {
      const booking = await createBookingVia(trip.id, owner.accessToken, {
        category,
        title: `A ${category}`,
        details,
      });
      expect(booking.category).toBe(category);
      expect(booking.status).toBe("idea");
      expect(booking.source).toBe("manual");
      // R-shared-10: the junk key never reaches the row.
      expect(booking.details).not.toHaveProperty("junk_key");
    }
  });

  it("POST: mismatched category/details 400; client 'email' source 400; unpaired price 400; cancelled status 400", async () => {
    const { editor, trip } = await seedCollabTrip();
    const cases: Record<string, unknown>[] = [
      { category: "flight", title: "x", details: { category: "lodging" } },
      { category: "flight", title: "x", source: "email" },
      { category: "flight", title: "x", source: "share" },
      { category: "flight", title: "x", price_cents: 100 },
      { category: "flight", title: "x", status: "cancelled" },
    ];
    for (const body of cases) {
      const res = await postBooking(trip.id, editor.accessToken, body);
      expect(res.status).toBe(400);
      const envelope = (await res.json()) as ErrorEnvelope;
      expect(envelope.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("POST: timed 'planned' create derives instants AND auto-creates its item in one write (R-ib-4/R-ib-5); dirty day marked post-commit", async () => {
    const { editor, trip } = await seedCollabTrip();
    dirtyCalls.length = 0;
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "flight",
      title: "UA 837",
      status: "planned",
      details: FLIGHT_DETAILS,
    });
    // R-ib-4: UTC instants denormalized from local-with-offset details.
    expect(booking.starts_at).toBe("2026-09-01T18:05:00.000Z");
    expect(booking.ends_at).toBe("2026-09-02T05:25:00.000Z");

    // R-ib-5: the derived item exists — departure wall-date + wall-times,
    // cross-midnight arrival sets end_day (§3.3/§3.6).
    const items = await dbItems(booking.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "booking",
      day: "2026-09-01",
      endDay: "2026-09-02",
    });
    expect(items[0]?.startTime?.slice(0, 5)).toBe("11:05");
    expect(items[0]?.endTime?.slice(0, 5)).toBe("14:25");

    // I-5: both chain days marked, post-commit.
    expect(dirtyCalls.at(-1)).toEqual(
      expect.arrayContaining([
        { tripId: trip.id, day: "2026-09-01" },
        { tripId: trip.id, day: "2026-09-02" },
      ]),
    );
  });

  it("POST: car_rental with dropoff derives TWO point items; lodging derives ONE spanning item (§3.3 table)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const car = await createBookingVia(trip.id, editor.accessToken, {
      category: "car_rental",
      title: "Rental",
      status: "booked",
      details: {
        category: "car_rental",
        pickup_at: "2026-09-02T10:00:00+09:00",
        dropoff_at: "2026-09-04T18:00:00+09:00",
      },
    });
    const carItems = await dbItems(car.id);
    expect(carItems.map((i) => ({ day: i.day, endDay: i.endDay }))).toEqual([
      { day: "2026-09-02", endDay: null },
      { day: "2026-09-04", endDay: null },
    ]);

    const stay = await createBookingVia(trip.id, editor.accessToken, {
      category: "lodging",
      title: "Park Hyatt",
      status: "booked",
      details: {
        category: "lodging",
        check_in: "2026-09-01T15:00:00+09:00",
        check_out: "2026-09-05T11:00:00+09:00",
      },
    });
    const stayItems = await dbItems(stay.id);
    expect(stayItems).toHaveLength(1);
    expect(stayItems[0]).toMatchObject({ day: "2026-09-01", endDay: "2026-09-05" });
  });

  it("POST: 'idea' create (even with known times) creates NO items (I-1); no dirty marks", async () => {
    const { editor, trip } = await seedCollabTrip();
    dirtyCalls.length = 0;
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "flight",
      title: "Maybe this one",
      details: FLIGHT_DETAILS,
    });
    expect(booking.status).toBe("idea");
    expect(booking.starts_at).toBe("2026-09-01T18:05:00.000Z"); // instants still derived
    expect(await dbItems(booking.id)).toHaveLength(0);
    expect(dirtyCalls).toHaveLength(0); // nothing changed calendar placement
  });

  it("POST: auto-item creation is ATOMIC — a forced item-insert failure rolls back the booking row (R-ib-5)", async () => {
    const { editor, trip } = await seedCollabTrip();
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION t71_reject_marker_day() RETURNS trigger AS $$
      BEGIN
        IF NEW.day = DATE '1999-01-01' THEN
          RAISE EXCEPTION 'forced failure (T-7.1 atomicity probe)';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
    await db.execute(
      sql`CREATE TRIGGER t71_reject_marker_day BEFORE INSERT ON itinerary_items FOR EACH ROW EXECUTE FUNCTION t71_reject_marker_day()`,
    );
    try {
      dirtyCalls.length = 0;
      const res = await postBooking(trip.id, editor.accessToken, {
        category: "flight",
        title: "Doomed",
        status: "planned",
        details: { category: "flight", departs_at: "1999-01-01T10:00:00+09:00" },
      });
      expect(res.status).toBe(500);
      // The booking row rolled back with the failed item insert.
      const rows = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.tripId, trip.id));
      expect(rows.filter((r) => r.title === "Doomed")).toHaveLength(0);
      // An aborted transaction never marks (dirty-days contract).
      expect(dirtyCalls).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER t71_reject_marker_day ON itinerary_items`);
      await db.execute(sql`DROP FUNCTION t71_reject_marker_day`);
    }
  });

  it("POST: viewer 403 (R-ib-24 server-enforced)", async () => {
    const { viewer, trip } = await seedCollabTrip();
    const res = await postBooking(trip.id, viewer.accessToken, {
      category: "other",
      title: "nope",
    });
    expect(res.status).toBe(403);
  });

  // ===========================================================================
  // GET /trips/:tripId/bookings (§3.4; R-ib-10/24)
  // ===========================================================================

  it("GET list: status/category filters; default excludes cancelled; explicit status=cancelled returns them; viewer can read", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    const idea = await createBookingVia(trip.id, owner.accessToken, {
      category: "activity",
      title: "Idea A",
    });
    const booked = await createBookingVia(trip.id, owner.accessToken, {
      category: "lodging",
      title: "Stay",
      status: "booked",
    });
    const toCancel = await createBookingVia(trip.id, owner.accessToken, {
      category: "restaurant",
      title: "Dinner",
      status: "planned",
    });
    const cancelRes = await patchBooking(trip.id, toCancel.id, editor.accessToken, {
      status: "cancelled",
    });
    expect(cancelRes.status).toBe(200);

    // Default: all except cancelled.
    const all = PaginatedBookingsSchema.parse(
      await (await listBookings(trip.id, viewer.accessToken)).json(),
    );
    const ids = all.items.map((b) => b.id);
    expect(ids).toContain(idea.id);
    expect(ids).toContain(booked.id);
    expect(ids).not.toContain(toCancel.id);

    // Explicit status filter (repeatable) + category filter.
    const filtered = PaginatedBookingsSchema.parse(
      await (await listBookings(trip.id, viewer.accessToken, "?status=booked")).json(),
    );
    expect(filtered.items.map((b) => b.id)).toEqual([booked.id]);

    const cancelled = PaginatedBookingsSchema.parse(
      await (await listBookings(trip.id, viewer.accessToken, "?status=cancelled")).json(),
    );
    expect(cancelled.items.map((b) => b.id)).toEqual([toCancel.id]);

    const byCategory = PaginatedBookingsSchema.parse(
      await (await listBookings(trip.id, viewer.accessToken, "?category=lodging")).json(),
    );
    expect(byCategory.items.map((b) => b.id)).toEqual([booked.id]);
  });

  it("GET list: unscheduled=true returns exactly the zero-item bookings (R-ib-10)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const timedBooked = await createBookingVia(trip.id, owner.accessToken, {
      category: "flight",
      title: "On calendar",
      status: "booked",
      details: FLIGHT_DETAILS,
    });
    const timelessPlanned = await createBookingVia(trip.id, owner.accessToken, {
      category: "activity",
      title: "Timeless planned",
      status: "planned",
    });
    const idea = await createBookingVia(trip.id, owner.accessToken, {
      category: "other",
      title: "Idea",
    });

    const unscheduled = PaginatedBookingsSchema.parse(
      await (await listBookings(trip.id, owner.accessToken, "?unscheduled=true")).json(),
    );
    const ids = unscheduled.items.map((b) => b.id);
    expect(ids).toContain(timelessPlanned.id);
    expect(ids).toContain(idea.id);
    expect(ids).not.toContain(timedBooked.id);
  });

  it("GET list: ordering is starts_at ASC NULLS LAST / updated_at DESC; the cursor walks the timed→timeless boundary losslessly", async () => {
    const { owner, trip } = await seedCollabTrip();
    // 3 timed (Sep 3, 1, 5) + 2 timeless — expected order: 1st, 3rd, 5th,
    // then the timeless pair freshest-updated first.
    const mk = (title: string, departs?: string) =>
      createBookingVia(trip.id, owner.accessToken, {
        category: "flight",
        title,
        status: "planned",
        ...(departs
          ? { details: { category: "flight", departs_at: departs } }
          : {}),
      });
    const sep3 = await mk("Sep 3", "2026-09-03T10:00:00+09:00");
    const sep1 = await mk("Sep 1", "2026-09-01T10:00:00+09:00");
    const sep5 = await mk("Sep 5", "2026-09-05T10:00:00+09:00");
    const timelessOld = await mk("Timeless old");
    const timelessNew = await mk("Timeless new");

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const qs = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = PaginatedBookingsSchema.parse(
        await (await listBookings(trip.id, owner.accessToken, qs)).json(),
      );
      walked.push(...body.items.map((b) => b.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(walked).toEqual([sep1.id, sep3.id, sep5.id, timelessNew.id, timelessOld.id]);

    // Malformed cursor falls back to page 1 (opaque token, no 400 door).
    const malformed = PaginatedBookingsSchema.parse(
      await (await listBookings(trip.id, owner.accessToken, "?limit=2&cursor=%21junk")).json(),
    );
    expect(malformed.items.map((b) => b.id)).toEqual([sep1.id, sep3.id]);
  });

  // ===========================================================================
  // GET /trips/:tripId/bookings/:bookingId (§3.4; R-ib-24)
  // ===========================================================================

  it("GET detail: BookingWithItems — items for scheduled, empty for ideas", async () => {
    const { owner, viewer, trip } = await seedCollabTrip();
    const timed = await createBookingVia(trip.id, owner.accessToken, {
      category: "flight",
      title: "UA 837",
      status: "booked",
      details: FLIGHT_DETAILS,
    });
    const idea = await createBookingVia(trip.id, owner.accessToken, {
      category: "other",
      title: "Idea",
    });

    const timedBody = BookingWithItemsSchema.parse(
      await (await getBooking(trip.id, timed.id, viewer.accessToken)).json(),
    );
    expect(timedBody.items).toHaveLength(1);
    expect(timedBody.items[0]).toMatchObject({
      kind: "booking",
      booking_id: timed.id,
      day: "2026-09-01",
      start_time: "11:05",
      end_time: "14:25",
    });

    const ideaBody = BookingWithItemsSchema.parse(
      await (await getBooking(trip.id, idea.id, viewer.accessToken)).json(),
    );
    expect(ideaBody.items).toEqual([]);
  });

  // ===========================================================================
  // F-038 IDOR harness (R-ib-24): trip AND booking ids, byte-identical 404s
  // ===========================================================================

  it("F-038: stranger, nonexistent, and malformed TRIP ids are BYTE-IDENTICAL 404s on every route", async () => {
    const { owner, trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();
    const booking = await createBookingVia(trip.id, owner.accessToken, {
      category: "other",
      title: "target",
    });
    const createBody = JSON.stringify({ category: "other", title: "x" });
    const patchBody = JSON.stringify({ title: "x" });
    const scheduleBody = JSON.stringify({ day: "2026-09-03" });

    await expectIndistinguishable404s([
      await listBookings(trip.id, stranger.accessToken),
      await listBookings(NONEXISTENT_UUID, stranger.accessToken),
      await listBookings("not-a-uuid", stranger.accessToken),
    ]);
    await expectIndistinguishable404s([
      await postBooking(trip.id, stranger.accessToken, JSON.parse(createBody)),
      await postBooking(NONEXISTENT_UUID, stranger.accessToken, JSON.parse(createBody)),
    ]);
    await expectIndistinguishable404s([
      await getBooking(trip.id, booking.id, stranger.accessToken),
      await getBooking(NONEXISTENT_UUID, booking.id, stranger.accessToken),
      await getBooking("not-a-uuid", booking.id, stranger.accessToken),
    ]);
    await expectIndistinguishable404s([
      await patchBooking(trip.id, booking.id, stranger.accessToken, JSON.parse(patchBody)),
      await patchBooking(NONEXISTENT_UUID, booking.id, stranger.accessToken, JSON.parse(patchBody)),
    ]);
    await expectIndistinguishable404s([
      await deleteBooking(trip.id, booking.id, stranger.accessToken),
      await deleteBooking(NONEXISTENT_UUID, booking.id, stranger.accessToken),
    ]);
    await expectIndistinguishable404s([
      await scheduleBooking(trip.id, booking.id, stranger.accessToken, JSON.parse(scheduleBody)),
      await scheduleBooking(NONEXISTENT_UUID, booking.id, stranger.accessToken, JSON.parse(scheduleBody)),
    ]);
  });

  it("F-038: wrong-trip, nonexistent, and malformed BOOKING ids are BYTE-IDENTICAL 404s for a proven member", async () => {
    const { owner, trip } = await seedCollabTrip();
    const other = await seedCollabTrip(); // a booking the caller can't see
    const foreign = await createBookingVia(other.trip.id, other.owner.accessToken, {
      category: "other",
      title: "foreign",
    });

    await expectIndistinguishable404s([
      await getBooking(trip.id, foreign.id, owner.accessToken), // exists, other trip
      await getBooking(trip.id, NONEXISTENT_UUID, owner.accessToken), // does not exist
      await getBooking(trip.id, "not-a-uuid", owner.accessToken), // malformed, same door
    ]);
    await expectIndistinguishable404s([
      await patchBooking(trip.id, foreign.id, owner.accessToken, { title: "x" }),
      await patchBooking(trip.id, NONEXISTENT_UUID, owner.accessToken, { title: "x" }),
      await patchBooking(trip.id, "not-a-uuid", owner.accessToken, { title: "x" }),
    ]);
    await expectIndistinguishable404s([
      await deleteBooking(trip.id, foreign.id, owner.accessToken),
      await deleteBooking(trip.id, NONEXISTENT_UUID, owner.accessToken),
      await deleteBooking(trip.id, "not-a-uuid", owner.accessToken),
    ]);
    await expectIndistinguishable404s([
      await scheduleBooking(trip.id, foreign.id, owner.accessToken, { day: "2026-09-03" }),
      await scheduleBooking(trip.id, NONEXISTENT_UUID, owner.accessToken, { day: "2026-09-03" }),
      await scheduleBooking(trip.id, "not-a-uuid", owner.accessToken, { day: "2026-09-03" }),
    ]);
  });

  // ===========================================================================
  // PATCH /trips/:tripId/bookings/:bookingId (§3.2/§3.4; R-ib-1..7/12/18/24)
  // ===========================================================================

  /** Seed a TIMED booking in the given status (cancelled via planned→cancelled). */
  async function seedTimedBooking(
    tripId: string,
    token: string,
    status: BookingStatus,
  ): Promise<Booking> {
    if (status === "cancelled") {
      const planned = await createBookingVia(tripId, token, {
        category: "flight",
        title: `matrix-${uniq()}`,
        status: "planned",
        details: FLIGHT_DETAILS,
      });
      const res = await patchBooking(tripId, planned.id, token, { status: "cancelled" });
      expect(res.status).toBe(200);
      return BookingSchema.parse({
        ...((await res.json()) as BookingWithItems),
        items: undefined,
      });
    }
    return createBookingVia(tripId, token, {
      category: "flight",
      title: `matrix-${uniq()}`,
      status,
      details: FLIGHT_DETAILS,
    });
  }

  it("PATCH §3.2 matrix: every LEGAL transition applies its item side effects atomically", async () => {
    const { editor, trip } = await seedCollabTrip();
    const legal: Array<[BookingStatus, BookingStatus, number]> = [
      // [from, to, expected item count after] — all bookings are TIMED
      ["idea", "planned", 1], // enters calendar (I-2)
      ["idea", "booked", 1],
      ["idea", "cancelled", 0], // stays off-calendar (I-4)
      ["planned", "idea", 0], // manual unschedule deletes items (I-1)
      ["planned", "booked", 1], // items unaffected
      ["planned", "cancelled", 0], // deletes items, keeps row (I-4)
      ["booked", "planned", 1], // "didn't actually book" — items unaffected
      ["booked", "cancelled", 0],
    ];
    for (const [from, to, itemCount] of legal) {
      const booking = await seedTimedBooking(trip.id, editor.accessToken, from);
      const res = await patchBooking(trip.id, booking.id, editor.accessToken, { status: to });
      expect(res.status, `${from} → ${to}`).toBe(200);
      const body = BookingWithItemsSchema.parse(await res.json());
      expect(body.status, `${from} → ${to}`).toBe(to);
      expect(body.items, `${from} → ${to}`).toHaveLength(itemCount);
      expect(await dbItems(booking.id), `${from} → ${to} (db)`).toHaveLength(itemCount);
      // The row survives every transition (I-4: cancel retains it).
      expect(await dbBooking(booking.id)).toBeDefined();
    }
  });

  it("PATCH §3.2 matrix: every ILLEGAL transition 400s and changes nothing; same-status is a no-op 200", async () => {
    const { editor, trip } = await seedCollabTrip();
    const illegal: Array<[BookingStatus, BookingStatus]> = [
      ["booked", "idea"], // two-step friction: demote to planned first
      ["cancelled", "idea"],
      ["cancelled", "planned"],
      ["cancelled", "booked"], // cancelled is terminal (R-ib-3)
    ];
    for (const [from, to] of illegal) {
      const booking = await seedTimedBooking(trip.id, editor.accessToken, from);
      const before = await dbBooking(booking.id);
      const res = await patchBooking(trip.id, booking.id, editor.accessToken, { status: to });
      expect(res.status, `${from} → ${to}`).toBe(400);
      const envelope = (await res.json()) as ErrorEnvelope;
      expect(envelope.error.code).toBe("VALIDATION_FAILED");
      expect((await dbBooking(booking.id))?.status).toBe(before?.status);
    }

    // Same-status: not a transition — allowed, nothing changes.
    const steady = await seedTimedBooking(trip.id, editor.accessToken, "booked");
    const res = await patchBooking(trip.id, steady.id, editor.accessToken, { status: "booked" });
    expect(res.status).toBe(200);
    expect(BookingWithItemsSchema.parse(await res.json()).items).toHaveLength(1);
  });

  it("PATCH: a booking-time change moves its item's day/times in the SAME transaction, keeping the item id (I-2)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "flight",
      title: "Movable",
      status: "planned",
      details: FLIGHT_DETAILS,
    });
    const [before] = await dbItems(booking.id);
    expect(before).toBeDefined();

    dirtyCalls.length = 0;
    const res = await patchBooking(trip.id, booking.id, editor.accessToken, {
      details: {
        category: "flight",
        flight_number: "UA 837",
        departs_at: "2026-09-04T09:30:00-07:00",
        arrives_at: "2026-09-05T12:45:00+09:00",
      },
    });
    expect(res.status).toBe(200);
    const body = BookingWithItemsSchema.parse(await res.json());
    expect(body.starts_at).toBe("2026-09-04T16:30:00.000Z");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: before?.id, // resync preserves the item id (legs/caches key on it)
      day: "2026-09-04",
      end_day: "2026-09-05",
      start_time: "09:30",
      end_time: "12:45",
    });
    // Old AND new chain days marked post-commit (I-5).
    const marked = dirtyCalls.at(-1) ?? [];
    for (const day of ["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05"]) {
      expect(marked).toContainEqual({ tripId: trip.id, day });
    }
  });

  it("PATCH: removing times leaves the scheduled item untouched — item-owned day/times (I-3 precedence)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "flight",
      title: "Times removed",
      status: "planned",
      details: FLIGHT_DETAILS,
    });
    const [before] = await dbItems(booking.id);

    const res = await patchBooking(trip.id, booking.id, editor.accessToken, {
      details: { category: "flight", flight_number: "UA 837" }, // times dropped
    });
    expect(res.status).toBe(200);
    const body = BookingWithItemsSchema.parse(await res.json());
    expect(body.starts_at).toBeNull(); // instants re-derived to NULL
    // Nothing silently vanishes: the item keeps its current day/times.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: before?.id,
      day: "2026-09-01",
      start_time: "11:05",
    });
  });

  it("PATCH: a timeless-but-scheduled booking gaining real times gets OVERWRITTEN item day/times (I-3 → I-2 precedence: the booking wins)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "activity",
      title: "Scheduled by hand",
      status: "planned",
    });
    const scheduled = await scheduleBooking(trip.id, booking.id, editor.accessToken, {
      day: "2026-09-08",
      start_time: "13:00",
    });
    expect(scheduled.status).toBe(201);
    const [userItem] = await dbItems(booking.id);
    expect(userItem?.day).toBe("2026-09-08");

    const res = await patchBooking(trip.id, booking.id, editor.accessToken, {
      details: {
        category: "activity",
        starts_at: "2026-09-06T10:00:00+09:00",
        ends_at: "2026-09-06T12:00:00+09:00",
      },
    });
    expect(res.status).toBe(200);
    const body = BookingWithItemsSchema.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: userItem?.id, // same item, day/times overwritten in the same txn
      day: "2026-09-06",
      start_time: "10:00",
      end_time: "12:00",
    });
  });

  it("PATCH: category change rejected both ways — top-level key AND details discriminant (R-ib-1/R-ib-2)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "flight",
      title: "Immutable",
    });
    const topLevel = await patchBooking(trip.id, booking.id, editor.accessToken, {
      category: "lodging",
    });
    expect(topLevel.status).toBe(400);

    const viaDetails = await patchBooking(trip.id, booking.id, editor.accessToken, {
      details: { category: "lodging", property_name: "Sneaky" },
    });
    expect(viaDetails.status).toBe(400);
    expect(((await viaDetails.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
  });

  it("PATCH: merged-row price/currency pairing enforced (R-ib-12)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "activity",
      title: "Unpriced",
    });
    // Row currency is NULL — a price alone can't merge valid.
    const bad = await patchBooking(trip.id, booking.id, editor.accessToken, {
      price_cents: 5000,
    });
    expect(bad.status).toBe(400);

    const good = await patchBooking(trip.id, booking.id, editor.accessToken, {
      price_cents: 5000,
      currency: "JPY",
    });
    expect(good.status).toBe(200);

    // Clearing the currency while a price remains is equally invalid.
    const clearCurrency = await patchBooking(trip.id, booking.id, editor.accessToken, {
      currency: null,
    });
    expect(clearCurrency.status).toBe(400);

    // Clearing both is fine.
    const clearBoth = await patchBooking(trip.id, booking.id, editor.accessToken, {
      price_cents: null,
      currency: null,
    });
    expect(clearBoth.status).toBe(200);
  });

  it("PATCH → cancelled: items deleted, booking row retained, expense reference SURVIVES (R-ib-7)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "lodging",
      title: "Cancelled stay",
      status: "booked",
      details: {
        category: "lodging",
        check_in: "2026-09-01T15:00:00+09:00",
        check_out: "2026-09-05T11:00:00+09:00",
      },
    });
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        tripId: trip.id,
        description: "Hotel deposit",
        category: "lodging",
        paidBy: owner.userId,
        amountCents: 50000,
        currency: "JPY",
        bookingId: booking.id,
        createdBy: owner.userId,
      })
      .returning();

    const res = await patchBooking(trip.id, booking.id, editor.accessToken, {
      status: "cancelled",
    });
    expect(res.status).toBe(200);
    expect(await dbItems(booking.id)).toHaveLength(0);
    expect(await dbBooking(booking.id)).toMatchObject({ status: "cancelled" });
    const [expenseAfter] = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expense!.id));
    expect(expenseAfter?.bookingId).toBe(booking.id); // reference unchanged
  });

  it("PATCH: viewer 403 (R-ib-24)", async () => {
    const { owner, viewer, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, owner.accessToken, {
      category: "other",
      title: "read-only for viewers",
    });
    const res = await patchBooking(trip.id, booking.id, viewer.accessToken, { title: "nope" });
    expect(res.status).toBe(403);
  });

  // ===========================================================================
  // DELETE /trips/:tripId/bookings/:bookingId (§3.4; R-ib-19/24)
  // ===========================================================================

  it("DELETE: cascades items, SET-NULLs the expense link, marks the item days dirty; second delete 404; viewer 403", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "flight",
      title: "Deleted",
      status: "booked",
      details: FLIGHT_DETAILS,
    });
    expect(await dbItems(booking.id)).toHaveLength(1);
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        tripId: trip.id,
        description: "Fare",
        category: "transport",
        paidBy: owner.userId,
        amountCents: 128500,
        currency: "USD",
        bookingId: booking.id,
        createdBy: owner.userId,
      })
      .returning();

    const forbidden = await deleteBooking(trip.id, booking.id, viewer.accessToken);
    expect(forbidden.status).toBe(403);

    dirtyCalls.length = 0;
    const res = await deleteBooking(trip.id, booking.id, editor.accessToken);
    expect(res.status).toBe(204);
    expect(await dbBooking(booking.id)).toBeUndefined();
    expect(await dbItems(booking.id)).toHaveLength(0); // cascade
    const [expenseAfter] = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expense!.id));
    expect(expenseAfter?.bookingId).toBeNull(); // ledger outlives the booking
    expect(dirtyCalls.at(-1)).toEqual(
      expect.arrayContaining([
        { tripId: trip.id, day: "2026-09-01" },
        { tripId: trip.id, day: "2026-09-02" },
      ]),
    );

    const again = await deleteBooking(trip.id, booking.id, editor.accessToken);
    expect(again.status).toBe(404);
  });

  // ===========================================================================
  // POST /trips/:tripId/bookings/:bookingId/schedule (§3.4; R-ib-8/18/24)
  // ===========================================================================

  it("schedule: an idea lands on the calendar — item created, status advanced idea → planned, ONE transaction (R-ib-8)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const idea = await createBookingVia(trip.id, editor.accessToken, {
      category: "restaurant",
      title: "Dinner idea",
    });
    dirtyCalls.length = 0;
    const res = await scheduleBooking(trip.id, idea.id, editor.accessToken, {
      day: "2026-09-03",
      start_time: "19:00",
    });
    expect(res.status).toBe(201);
    const body = BookingWithItemsSchema.parse(await res.json());
    expect(body.status).toBe("planned");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      kind: "booking",
      day: "2026-09-03",
      start_time: "19:00",
      end_time: null,
    });
    expect(dirtyCalls.at(-1)).toEqual([{ tripId: trip.id, day: "2026-09-03" }]);

    // A timeless PLANNED booking schedules too, status unchanged.
    const planned = await createBookingVia(trip.id, editor.accessToken, {
      category: "activity",
      title: "Timeless planned",
      status: "planned",
    });
    const planRes = await scheduleBooking(trip.id, planned.id, editor.accessToken, {
      day: "2026-09-04",
    });
    expect(planRes.status).toBe(201);
    expect(BookingWithItemsSchema.parse(await planRes.json()).status).toBe("planned");
  });

  it("schedule: timed booking 400; already-scheduled 409; cancelled 400; viewer 403", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    const timed = await createBookingVia(trip.id, editor.accessToken, {
      category: "flight",
      title: "Automatic presence",
      status: "planned",
      details: FLIGHT_DETAILS,
    });
    const timedRes = await scheduleBooking(trip.id, timed.id, editor.accessToken, {
      day: "2026-09-03",
    });
    expect(timedRes.status).toBe(400);

    const idea = await createBookingVia(trip.id, editor.accessToken, {
      category: "other",
      title: "Once only",
    });
    expect(
      (await scheduleBooking(trip.id, idea.id, editor.accessToken, { day: "2026-09-03" })).status,
    ).toBe(201);
    const again = await scheduleBooking(trip.id, idea.id, editor.accessToken, {
      day: "2026-09-04",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorEnvelope).error.code).toBe("CONFLICT");

    const doomed = await createBookingVia(trip.id, owner.accessToken, {
      category: "other",
      title: "Cancelled idea",
      status: "planned",
    });
    expect(
      (await patchBooking(trip.id, doomed.id, owner.accessToken, { status: "cancelled" })).status,
    ).toBe(200);
    const cancelledRes = await scheduleBooking(trip.id, doomed.id, owner.accessToken, {
      day: "2026-09-03",
    });
    expect(cancelledRes.status).toBe(400);

    const forViewer = await createBookingVia(trip.id, owner.accessToken, {
      category: "other",
      title: "Viewer probe",
    });
    expect(
      (await scheduleBooking(trip.id, forViewer.id, viewer.accessToken, { day: "2026-09-03" }))
        .status,
    ).toBe(403);
  });

  it("schedule: after_item_id positions by midpoint; unknown/off-day anchors 400; default appends", async () => {
    const { editor, trip } = await seedCollabTrip();
    // Two anchors on the day, sort 1024 and 2048, via two scheduled ideas.
    const mkIdea = (title: string) =>
      createBookingVia(trip.id, editor.accessToken, { category: "other", title });
    const a = await mkIdea("anchor A");
    const b = await mkIdea("anchor B");
    expect(
      (await scheduleBooking(trip.id, a.id, editor.accessToken, { day: "2026-09-07" })).status,
    ).toBe(201);
    expect(
      (await scheduleBooking(trip.id, b.id, editor.accessToken, { day: "2026-09-07" })).status,
    ).toBe(201);
    const [itemA] = await dbItems(a.id);
    const [itemB] = await dbItems(b.id);
    expect(itemA?.sortOrder).toBe(1024); // empty day seeds at the gap unit
    expect(itemB?.sortOrder).toBe(2048); // append = last + 1024

    // Between A and B via after_item_id → midpoint.
    const between = await mkIdea("between");
    const betweenRes = await scheduleBooking(trip.id, between.id, editor.accessToken, {
      day: "2026-09-07",
      after_item_id: itemA?.id,
    });
    expect(betweenRes.status).toBe(201);
    const [itemBetween] = await dbItems(between.id);
    expect(itemBetween?.sortOrder).toBe(1536);

    // Unknown anchor and off-day anchor are bad bodies.
    const probe = await mkIdea("bad anchors");
    expect(
      (
        await scheduleBooking(trip.id, probe.id, editor.accessToken, {
          day: "2026-09-07",
          after_item_id: NONEXISTENT_UUID,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await scheduleBooking(trip.id, probe.id, editor.accessToken, {
          day: "2026-09-08", // anchor lives on 09-07
          after_item_id: itemA?.id,
        })
      ).status,
    ).toBe(400);
  });

  // ===========================================================================
  // Dirty-day seam contract (I-5; dirty-days.ts)
  // ===========================================================================

  it("seam: a THROWING marker never fails the request — end-to-end (fire-and-forget contract)", async () => {
    // Same auth deps (same verify key) — only the marker differs: it throws
    // synchronously on every call. The mutation must still commit and 201.
    const throwingApp = createApp({
      auth: authDeps,
      trips: { db },
      bookings: {
        db,
        dirtyDays: {
          markDaysDirty() {
            throw new Error("seam detonated");
          },
        },
      },
    });
    const { editor, trip } = await seedCollabTrip();
    const res = await throwingApp.request(`/api/trips/${trip.id}/bookings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor.accessToken}`,
      },
      body: JSON.stringify({
        category: "other",
        title: "seam probe",
        status: "planned",
        details: { category: "other", starts_at: "2026-09-09T10:00:00+09:00" },
      }),
    });
    expect(res.status).toBe(201);
    const booking = BookingSchema.parse(await res.json());
    expect(await dbItems(booking.id)).toHaveLength(1); // the write committed
  });
});
