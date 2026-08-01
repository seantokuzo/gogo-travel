/**
 * T-7.2 itinerary integration suite (IB-2): composite read, item
 * create/patch/delete, day-order PUT — end-to-end over a real Postgres,
 * behind the real app-wide `requireAuth` + `requireTripMember` gates. Covers
 * every §3.4 "Tests required" bullet for the five routes PLUS booking-item
 * protection probes (R-ib-16), the R-ib-9 unschedule matrix (planned →
 * idea; booked → 409; multi-item bookings leave together), the LWW/day-order
 * matrix (ignored ids, foreign-trip 400, concurrent PUT serialization), the
 * F-038 IDOR harness on trip AND item ids, viewer-403 on every mutation
 * (R-ib-24), the place-visibility gate on item place_id writes (Law #3 /
 * R-places-8 — the shared predicate's consumption evidence), and the
 * dirty-day seam contract (post-commit marks; an aborted mutation never
 * marks).
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
import { eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BookingSchema, type Booking } from "@gogo/shared/domains/booking";
import {
  DayOrderResultSchema,
  ItineraryItemSchema,
  ItineraryReadSchema,
  type ItineraryItem,
} from "@gogo/shared/domains/itinerary";
import { TripWithRoleSchema } from "@gogo/shared/domains/trip";
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
import type { DirtyDayMark } from "../bookings/dirty-days.js";

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
      "║  DOCKER UNAVAILABLE — T-7.2 ITINERARY SUITE SKIPPED               ║\n" +
      "║  Composite read, item CRUD, day-order PUT, booking-item           ║\n" +
      "║  protection, the R-ib-9 unschedule matrix, the F-038 IDOR         ║\n" +
      "║  harness, viewer-403, place visibility, and the dirty-day seam    ║\n" +
      "║  (itinerary-bookings spec §3.4, R-ib-13..18/24) were NOT          ║\n" +
      "║  verified. Start Docker and re-run `pnpm --filter @gogo/server    ║\n" +
      "║  test` before treating this green.                                ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-7.2 itinerary suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-7.2 itinerary suite could " +
        "not verify itinerary-bookings spec §3.4 (R-ib-13..18/24). " +
        "A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

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

describe.skipIf(!dockerAvailable)("T-7.2 itinerary routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
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
    const recording = createRecordingMarker();
    dirtyCalls = recording.calls;
    // Bookings mounts too: booking-kind item scenarios are seeded through the
    // real booking service (§3.1 single write path — never raw item inserts).
    app = createApp({
      auth: authDeps,
      trips: { db },
      bookings: { db, dirtyDays: recording.marker },
      itinerary: { db, dirtyDays: recording.marker },
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `itinerary-${uniq()}@example.com`,
      displayName: "Itinerary Tester",
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

  const getItinerary = (tripId: string, token: string, query = "") =>
    request(`/api/trips/${tripId}/itinerary${query}`, token);
  const postItem = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/itinerary/items`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const patchItem = (tripId: string, itemId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/itinerary/items/${itemId}`, token, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  const deleteItemReq = (tripId: string, itemId: string, token: string) =>
    request(`/api/trips/${tripId}/itinerary/items/${itemId}`, token, { method: "DELETE" });
  const putDayOrder = (tripId: string, day: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/itinerary/days/${day}/order`, token, {
      method: "PUT",
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

  /** A custom place owned by `createdBy` (visibility per R-places-8). */
  async function seedCustomPlace(createdBy: string) {
    const [row] = await db
      .insert(schema.places)
      .values({
        source: "custom",
        sourceId: null,
        name: `Custom ${uniq()}`,
        lat: "35.659500",
        lng: "139.700500",
        createdBy,
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  /** An open-data spine place — globally visible (R-places-8). */
  async function seedSpinePlace() {
    const [row] = await db
      .insert(schema.places)
      .values({
        source: "overture",
        sourceId: `ovt-${uniq()}`,
        name: `Spine ${uniq()}`,
        lat: "35.659500",
        lng: "139.700500",
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  /** Create an item through the API; returns the parsed wire item. */
  async function createItemVia(
    tripId: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<ItineraryItem> {
    const res = await postItem(tripId, token, body);
    expect(res.status).toBe(201);
    return ItineraryItemSchema.parse(await res.json());
  }

  /** Create a booking through the real bookings API (§3.1 single write path). */
  async function createBookingVia(
    tripId: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<Booking> {
    const res = await request(`/api/trips/${tripId}/bookings`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return BookingSchema.parse(await res.json());
  }

  /** Schedule a timeless booking (R-ib-8) and return its item row id. */
  async function scheduleBookingVia(
    tripId: string,
    bookingId: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await request(`/api/trips/${tripId}/bookings/${bookingId}/schedule`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as { items: { id: string }[] };
    expect(parsed.items).toHaveLength(1);
    return parsed.items[0]!.id;
  }

  const dbItem = async (itemId: string) => {
    const [row] = await db
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.id, itemId));
    return row;
  };

  const dbBookingItems = (bookingId: string) =>
    db
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.bookingId, bookingId))
      .orderBy(schema.itineraryItems.day, schema.itineraryItems.sortOrder);

  /** Seed a travel leg directly — a FIXTURE for the read path. The app-layer
   * single-writer rule (R-ib-22) binds the app, not test seeding. */
  async function seedLeg(
    tripId: string,
    fromItemId: string,
    toItemId: string,
    mode: "driving" | "walking" | "cycling" | "transit" = "walking",
  ) {
    const [row] = await db
      .insert(schema.travelLegs)
      .values({
        tripId,
        fromItemId,
        toItemId,
        mode,
        durationSeconds: 600,
        distanceMeters: 800,
        provider: "mapbox",
        computedAt: new Date("2026-07-31T00:00:00Z"),
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  /** Day-sorted copy of a marks batch — exact-set pins, order-independent. */
  const sortedMarks = (marks: readonly DirtyDayMark[] | undefined) =>
    [...(marks ?? [])].sort((a, b) => a.day.localeCompare(b.day));

  // ===========================================================================
  // GET /trips/:tripId/itinerary (§3.4; R-ib-13, R-ib-24)
  // ===========================================================================

  it("GET: items ordered (day, sort_order); legs limited to in-range endpoint pairs; explicit range filters both", async () => {
    const { owner, viewer, trip } = await seedCollabTrip();
    const d2a = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Morning walk",
      day: "2026-09-02",
    });
    const d2b = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Lunch",
      day: "2026-09-02",
    });
    const d3a = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Museum",
      day: "2026-09-03",
    });
    const d3b = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Dinner",
      day: "2026-09-03",
    });
    const inRangeLeg = await seedLeg(trip.id, d2a.id, d2b.id, "walking");
    const outOfRangeLeg = await seedLeg(trip.id, d3a.id, d3b.id, "walking");

    // Viewer read (any role, R-ib-24) over the full default range.
    const full = ItineraryReadSchema.parse(
      await (await getItinerary(trip.id, viewer.accessToken)).json(),
    );
    expect(full.items.map((i) => i.id)).toEqual([d2a.id, d2b.id, d3a.id, d3b.id]);
    expect(full.legs.map((l) => l.id).sort()).toEqual([inRangeLeg.id, outOfRangeLeg.id].sort());

    // Range [09-02, 09-02]: day-3 items AND the day-3 leg drop out.
    const ranged = ItineraryReadSchema.parse(
      await (
        await getItinerary(trip.id, viewer.accessToken, "?from=2026-09-02&to=2026-09-02")
      ).json(),
    );
    expect(ranged.items.map((i) => i.id)).toEqual([d2a.id, d2b.id]);
    expect(ranged.legs).toHaveLength(1);
    expect(ranged.legs[0]).toMatchObject({
      from_item_id: d2a.id,
      to_item_id: d2b.id,
      mode: "walking",
      provider: "mapbox",
      duration_seconds: 600,
      distance_meters: 800,
    });
  });

  it("GET: default range is trip dates ∪ item-day extremes — pre/post-trip items covered (§3.4)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const preTrip = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Pre-trip flight prep",
      day: "2026-08-25",
    });
    const postTrip = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Post-trip errand",
      day: "2026-09-15",
    });

    const read = ItineraryReadSchema.parse(
      await (await getItinerary(trip.id, owner.accessToken)).json(),
    );
    expect(read.items.map((i) => i.id)).toEqual([preTrip.id, postTrip.id]);
  });

  it("GET: a spanning item intersecting the range is returned (its span participates in every covered day)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const spanning = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Long stay block",
      day: "2026-09-01",
      end_day: "2026-09-05",
    });

    const read = ItineraryReadSchema.parse(
      await (
        await getItinerary(trip.id, owner.accessToken, "?from=2026-09-03&to=2026-09-03")
      ).json(),
    );
    expect(read.items.map((i) => i.id)).toEqual([spanning.id]);
  });

  it("GET: to < from is the documented 400", async () => {
    const { owner, trip } = await seedCollabTrip();
    const res = await getItinerary(trip.id, owner.accessToken, "?from=2026-09-05&to=2026-09-01");
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
  });

  // ===========================================================================
  // POST /trips/:tripId/itinerary/items (§3.4; R-ib-14/15/17/19/24)
  // ===========================================================================

  it("POST: happy path both kinds; server-assigned gapped sort_order appends (+1024)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const place = await seedSpinePlace();

    const first = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Breakfast",
      notes: "Try the eggs",
      day: "2026-09-02",
      start_time: "08:00",
      end_time: "09:00",
    });
    expect(first).toMatchObject({
      kind: "custom",
      title: "Breakfast",
      notes: "Try the eggs",
      day: "2026-09-02",
      start_time: "08:00",
      end_time: "09:00",
      sort_order: 1024,
      booking_id: null,
      place_id: null,
    });

    const second = await createItemVia(trip.id, editor.accessToken, {
      kind: "place_visit",
      place_id: place.id,
      day: "2026-09-02",
    });
    expect(second).toMatchObject({
      kind: "place_visit",
      place_id: place.id,
      title: null,
      sort_order: 2048,
    });
  });

  it("POST: after_item_id positions at the midpoint; unknown/off-day anchors 400", async () => {
    const { editor, trip } = await seedCollabTrip();
    const a = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "A",
      day: "2026-09-04",
    });
    await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "B",
      day: "2026-09-04",
    });

    const between = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Between",
      day: "2026-09-04",
      after_item_id: a.id,
    });
    expect(between.sort_order).toBe(1536); // midpoint of 1024 and 2048

    const offDay = await postItem(trip.id, editor.accessToken, {
      kind: "custom",
      title: "x",
      day: "2026-09-05",
      after_item_id: a.id, // anchor lives on 09-04
    });
    expect(offDay.status).toBe(400);
    const unknown = await postItem(trip.id, editor.accessToken, {
      kind: "custom",
      title: "x",
      day: "2026-09-04",
      after_item_id: NONEXISTENT_UUID,
    });
    expect(unknown.status).toBe(400);
  });

  it("POST: kind 'booking' rejected; kind/field mismatches rejected; structural time violations rejected (R-ib-14/17)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const place = await seedSpinePlace();
    const cases: Record<string, unknown>[] = [
      { kind: "booking", day: "2026-09-02" },
      { kind: "place_visit", day: "2026-09-02" }, // no place_id
      { kind: "custom", day: "2026-09-02" }, // no title
      { kind: "place_visit", place_id: place.id, title: "nope", day: "2026-09-02" },
      { kind: "custom", title: "x", day: "2026-09-02", end_day: "2026-09-01" },
      { kind: "custom", title: "x", day: "2026-09-02", start_time: "15:00", end_time: "11:00" },
    ];
    for (const body of cases) {
      const res = await postItem(trip.id, editor.accessToken, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("POST: overlapping times are accepted — never rejected (R-ib-17); multi-day spans exempt from the time order rule", async () => {
    const { editor, trip } = await seedCollabTrip();
    await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "One",
      day: "2026-09-06",
      start_time: "10:00",
      end_time: "12:00",
    });
    const overlapping = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Two (overlaps One)",
      day: "2026-09-06",
      start_time: "11:00",
      end_time: "13:00",
    });
    expect(overlapping.start_time).toBe("11:00");

    const spanning = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Overnight",
      day: "2026-09-06",
      end_day: "2026-09-07",
      start_time: "22:00",
      end_time: "06:00", // earlier wall time on a LATER day — legal
    });
    expect(spanning.end_day).toBe("2026-09-07");
  });

  it("POST: custom-kind items may carry a place_id — the visibility gate applies (R-ib-20 location resolution)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const own = await seedCustomPlace(editor.userId);
    const item = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "My secret spot",
      place_id: own.id,
      day: "2026-09-02",
    });
    expect(item.place_id).toBe(own.id);

    const stranger = await seedUserWithToken();
    const invisible = await seedCustomPlace(stranger.userId);
    const res = await postItem(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Not yours",
      place_id: invisible.id,
      day: "2026-09-02",
    });
    expect(res.status).toBe(404);
  });

  it("POST: an invisible place_id is BYTE-IDENTICAL to a nonexistent one (Law #3 — invisible ≡ absent)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();
    const invisible = await seedCustomPlace(stranger.userId);

    await expectIndistinguishable404s([
      await postItem(trip.id, editor.accessToken, {
        kind: "place_visit",
        place_id: invisible.id, // exists, not visible
        day: "2026-09-02",
      }),
      await postItem(trip.id, editor.accessToken, {
        kind: "place_visit",
        place_id: NONEXISTENT_UUID, // does not exist
        day: "2026-09-02",
      }),
    ]);
  });

  it("POST: dirty marks — single-day create marks its day; spanning create marks both chain days; a failed create never marks", async () => {
    const { editor, trip } = await seedCollabTrip();
    dirtyCalls.length = 0;
    await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Point",
      day: "2026-09-02",
    });
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([{ tripId: trip.id, day: "2026-09-02" }]);

    await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Span",
      day: "2026-09-03",
      end_day: "2026-09-05",
    });
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([
      { tripId: trip.id, day: "2026-09-03" },
      { tripId: trip.id, day: "2026-09-05" },
    ]);

    dirtyCalls.length = 0;
    const failed = await postItem(trip.id, editor.accessToken, { kind: "custom", day: "x" });
    expect(failed.status).toBe(400);
    expect(dirtyCalls).toHaveLength(0);
  });

  it("POST: viewer 403 (R-ib-24 server-enforced)", async () => {
    const { viewer, trip } = await seedCollabTrip();
    const res = await postItem(trip.id, viewer.accessToken, {
      kind: "custom",
      title: "nope",
      day: "2026-09-02",
    });
    expect(res.status).toBe(403);
  });

  // ===========================================================================
  // PATCH /trips/:tripId/itinerary/items/:itemId (§3.4; R-ib-16/17/18/19/24)
  // ===========================================================================

  it("PATCH: day/time edits on a TIMED booking's item 400 toward the booking; notes/sort_order stay editable (R-ib-16)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "activity",
      title: "teamLab",
      status: "planned",
      details: {
        category: "activity",
        starts_at: "2026-09-03T10:00:00+09:00",
        ends_at: "2026-09-03T12:00:00+09:00",
      },
    });
    const items = await dbBookingItems(booking.id);
    expect(items).toHaveLength(1);
    const itemId = items[0]!.id;

    for (const body of [
      { day: "2026-09-04" },
      { end_day: "2026-09-05" },
      { start_time: "09:00" },
      { end_time: null },
    ]) {
      const res = await patchItem(trip.id, itemId, editor.accessToken, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    }

    // notes and sort_order are ALWAYS editable — including sort_order: 0
    // (falsy pin: the key-presence check must not treat 0 as absent).
    dirtyCalls.length = 0;
    const notesRes = await patchItem(trip.id, itemId, editor.accessToken, { notes: "gate 4" });
    expect(notesRes.status).toBe(200);
    expect(ItineraryItemSchema.parse(await notesRes.json()).notes).toBe("gate 4");
    expect(dirtyCalls).toHaveLength(0); // notes cannot change a located sequence

    const orderRes = await patchItem(trip.id, itemId, editor.accessToken, { sort_order: 0 });
    expect(orderRes.status).toBe(200);
    expect(ItineraryItemSchema.parse(await orderRes.json()).sort_order).toBe(0);
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([{ tripId: trip.id, day: "2026-09-03" }]);
  });

  it("PATCH: a TIMELESS booking's scheduled item owns its day/times — edits succeed, booking untouched (R-ib-16/I-3)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "other",
      title: "Someday onsen",
    });
    const itemId = await scheduleBookingVia(trip.id, booking.id, editor.accessToken, {
      day: "2026-09-03",
      start_time: "10:00",
    });

    dirtyCalls.length = 0;
    const res = await patchItem(trip.id, itemId, editor.accessToken, {
      day: "2026-09-05",
      start_time: "16:00",
      end_time: "17:30",
    });
    expect(res.status).toBe(200);
    const item = ItineraryItemSchema.parse(await res.json());
    expect(item).toMatchObject({ day: "2026-09-05", start_time: "16:00", end_time: "17:30" });

    // Day move marks BOTH days (R-ib-19: old and new located sequences).
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([
      { tripId: trip.id, day: "2026-09-03" },
      { tripId: trip.id, day: "2026-09-05" },
    ]);

    // Booking stays planned + timeless (the item owns its times, I-3).
    const [parent] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking.id));
    expect(parent).toMatchObject({ status: "planned", startsAt: null });
  });

  it("PATCH: title is custom-only; place_id is place_visit-only (§3.4 field rules)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const place = await seedSpinePlace();
    const visit = await createItemVia(trip.id, editor.accessToken, {
      kind: "place_visit",
      place_id: place.id,
      day: "2026-09-02",
    });
    const custom = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Editable",
      day: "2026-09-02",
    });

    expect((await patchItem(trip.id, visit.id, editor.accessToken, { title: "x" })).status).toBe(
      400,
    );
    expect(
      (await patchItem(trip.id, custom.id, editor.accessToken, { place_id: place.id })).status,
    ).toBe(400);

    const renamed = await patchItem(trip.id, custom.id, editor.accessToken, { title: "Renamed" });
    expect(ItineraryItemSchema.parse(await renamed.json()).title).toBe("Renamed");

    const other = await seedSpinePlace();
    dirtyCalls.length = 0;
    const moved = await patchItem(trip.id, visit.id, editor.accessToken, { place_id: other.id });
    expect(ItineraryItemSchema.parse(await moved.json()).place_id).toBe(other.id);
    // Item place change dirties the day (R-ib-19).
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([{ tripId: trip.id, day: "2026-09-02" }]);
  });

  it("PATCH: place_id visibility gate — invisible ≡ nonexistent ≡ absent item, all BYTE-IDENTICAL 404s", async () => {
    const { editor, trip } = await seedCollabTrip();
    const place = await seedSpinePlace();
    const visit = await createItemVia(trip.id, editor.accessToken, {
      kind: "place_visit",
      place_id: place.id,
      day: "2026-09-02",
    });
    const stranger = await seedUserWithToken();
    const invisible = await seedCustomPlace(stranger.userId);

    await expectIndistinguishable404s([
      await patchItem(trip.id, visit.id, editor.accessToken, { place_id: invisible.id }),
      await patchItem(trip.id, visit.id, editor.accessToken, { place_id: NONEXISTENT_UUID }),
      await patchItem(trip.id, NONEXISTENT_UUID, editor.accessToken, { place_id: place.id }),
    ]);
  });

  it("PATCH: merged-row structural checks fire only when a placement field is written (R-ib-17)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const item = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Timed",
      day: "2026-09-02",
      start_time: "15:00",
      end_time: "17:00",
    });

    // Merged inversion: new end_time precedes the STORED start_time.
    const inverted = await patchItem(trip.id, item.id, editor.accessToken, {
      end_time: "11:00",
    });
    expect(inverted.status).toBe(400);

    // Same body is legal once the item spans days (multi-day exemption).
    const spanning = await patchItem(trip.id, item.id, editor.accessToken, {
      end_day: "2026-09-03",
      end_time: "11:00",
    });
    expect(spanning.status).toBe(200);

    // Merged end_day < stored day (no `day` in body) is caught too.
    const invertedSpan = await patchItem(trip.id, item.id, editor.accessToken, {
      end_day: "2026-09-01",
    });
    expect(invertedSpan.status).toBe(400);

    // start_time: null clears (falsy/null pin — a nullable clear is a write).
    const cleared = await patchItem(trip.id, item.id, editor.accessToken, {
      start_time: null,
      notes: null,
    });
    expect(cleared.status).toBe(200);
    const clearedItem = ItineraryItemSchema.parse(await cleared.json());
    expect(clearedItem.start_time).toBeNull();
    expect(clearedItem.notes).toBeNull();
  });

  it("PATCH: viewer 403 (R-ib-24)", async () => {
    const { owner, viewer, trip } = await seedCollabTrip();
    const item = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Read-only",
      day: "2026-09-02",
    });
    expect(
      (await patchItem(trip.id, item.id, viewer.accessToken, { title: "nope" })).status,
    ).toBe(403);
  });

  // ===========================================================================
  // DELETE /trips/:tripId/itinerary/items/:itemId (§3.4; R-ib-9/19/24)
  // ===========================================================================

  it("DELETE: custom/place_visit items delete cleanly; dirty marks cover the item's chain days; second delete 404", async () => {
    const { editor, trip } = await seedCollabTrip();
    const spanning = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Spanning",
      day: "2026-09-02",
      end_day: "2026-09-04",
    });

    dirtyCalls.length = 0;
    const res = await deleteItemReq(trip.id, spanning.id, editor.accessToken);
    expect(res.status).toBe(204);
    expect(await dbItem(spanning.id)).toBeUndefined();
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([
      { tripId: trip.id, day: "2026-09-02" },
      { tripId: trip.id, day: "2026-09-04" },
    ]);

    expect((await deleteItemReq(trip.id, spanning.id, editor.accessToken)).status).toBe(404);
  });

  it("DELETE: a planned booking's item reverts the booking to idea in ONE transaction — ALL its items leave (R-ib-9, I-1)", async () => {
    const { editor, trip } = await seedCollabTrip();
    // car_rental with dropoff ⇒ TWO derived items (§3.3 table).
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "car_rental",
      title: "Rental",
      status: "planned",
      details: {
        category: "car_rental",
        pickup_at: "2026-09-02T10:00:00+09:00",
        dropoff_at: "2026-09-04T18:00:00+09:00",
      },
    });
    const items = await dbBookingItems(booking.id);
    expect(items).toHaveLength(2);

    dirtyCalls.length = 0;
    const res = await deleteItemReq(trip.id, items[0]!.id, editor.accessToken);
    expect(res.status).toBe(204);

    // Zero items remain (idea pins zero, I-1/R-ib-6) and the status reverted.
    expect(await dbBookingItems(booking.id)).toHaveLength(0);
    const [parent] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking.id));
    expect(parent?.status).toBe("idea");

    // Both derived items' days marked.
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([
      { tripId: trip.id, day: "2026-09-02" },
      { tripId: trip.id, day: "2026-09-04" },
    ]);
  });

  it("DELETE: the R-ib-8 unschedule loop — scheduled timeless booking's item delete reverts planned → idea", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "other",
      title: "Idea to schedule",
    });
    expect(booking.status).toBe("idea");
    const itemId = await scheduleBookingVia(trip.id, booking.id, editor.accessToken, {
      day: "2026-09-04",
    });

    const res = await deleteItemReq(trip.id, itemId, editor.accessToken);
    expect(res.status).toBe(204);
    const [parent] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking.id));
    expect(parent?.status).toBe("idea");
    expect(await dbBookingItems(booking.id)).toHaveLength(0);
  });

  it("DELETE: a BOOKED booking's item 409s — item and status untouched (R-ib-9)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "activity",
      title: "Paid tickets",
      status: "booked",
      details: { category: "activity", starts_at: "2026-09-03T10:00:00+09:00" },
    });
    const items = await dbBookingItems(booking.id);
    expect(items).toHaveLength(1);

    dirtyCalls.length = 0;
    const res = await deleteItemReq(trip.id, items[0]!.id, editor.accessToken);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("CONFLICT");
    expect(await dbBookingItems(booking.id)).toHaveLength(1);
    const [parent] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking.id));
    expect(parent?.status).toBe("booked");
    expect(dirtyCalls).toHaveLength(0); // failed mutation never marks
  });

  it("DELETE: viewer 403 (R-ib-24)", async () => {
    const { owner, viewer, trip } = await seedCollabTrip();
    const item = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "Keep",
      day: "2026-09-02",
    });
    expect((await deleteItemReq(trip.id, item.id, viewer.accessToken)).status).toBe(403);
  });

  // ===========================================================================
  // PUT /trips/:tripId/itinerary/days/:day/order (§3.4; R-ib-15/16/18/19/24)
  // ===========================================================================

  it("PUT order: assigns 1024-gapped values by position; response is the day's post-state; unlisted items survive", async () => {
    const { editor, trip } = await seedCollabTrip();
    const a = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "A",
      day: "2026-09-02",
    });
    const b = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "B",
      day: "2026-09-02",
    });
    const c = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "C",
      day: "2026-09-02",
    });

    dirtyCalls.length = 0;
    // Reorder ONLY c and a — b is a concurrent creator's row in LWW terms.
    const res = await putDayOrder(trip.id, "2026-09-02", editor.accessToken, {
      item_ids: [c.id, a.id],
    });
    expect(res.status).toBe(200);
    const result = DayOrderResultSchema.parse(await res.json());

    const byId = new Map(result.items.map((i) => [i.id, i]));
    expect(byId.get(c.id)?.sort_order).toBe(1024);
    expect(byId.get(a.id)?.sort_order).toBe(2048);
    // b untouched (never destroyed, keeps its original 2048): ties order
    // arbitrarily until the next full reorder — the documented posture.
    expect(byId.get(b.id)?.sort_order).toBe(2048);
    expect(result.items).toHaveLength(3);
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([{ tripId: trip.id, day: "2026-09-02" }]);

    // Full reorder re-indexes everything.
    const full = DayOrderResultSchema.parse(
      await (
        await putDayOrder(trip.id, "2026-09-02", editor.accessToken, {
          item_ids: [b.id, c.id, a.id],
        })
      ).json(),
    );
    expect(full.items.map((i) => [i.id, i.sort_order])).toEqual([
      [b.id, 1024],
      [c.id, 2048],
      [a.id, 3072],
    ]);
  });

  it("PUT order: cross-day pull works for custom/place_visit/timeless-booking items; marks source + target days (R-ib-15/19)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const place = await seedSpinePlace();
    const custom = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Pulled custom",
      day: "2026-09-04",
    });
    const visit = await createItemVia(trip.id, editor.accessToken, {
      kind: "place_visit",
      place_id: place.id,
      day: "2026-09-05",
    });
    const timeless = await createBookingVia(trip.id, editor.accessToken, {
      category: "other",
      title: "Timeless",
    });
    const bookingItemId = await scheduleBookingVia(trip.id, timeless.id, editor.accessToken, {
      day: "2026-09-06",
    });

    dirtyCalls.length = 0;
    const res = await putDayOrder(trip.id, "2026-09-02", editor.accessToken, {
      item_ids: [custom.id, visit.id, bookingItemId],
    });
    expect(res.status).toBe(200);
    const result = DayOrderResultSchema.parse(await res.json());
    expect(result.items.map((i) => [i.id, i.day, i.sort_order])).toEqual([
      [custom.id, "2026-09-02", 1024],
      [visit.id, "2026-09-02", 2048],
      [bookingItemId, "2026-09-02", 3072],
    ]);
    expect(sortedMarks(dirtyCalls.at(-1))).toEqual([
      { tripId: trip.id, day: "2026-09-02" },
      { tripId: trip.id, day: "2026-09-04" },
      { tripId: trip.id, day: "2026-09-05" },
      { tripId: trip.id, day: "2026-09-06" },
    ]);
  });

  it("PUT order: a TIMED booking's item cannot be pulled across days (400) but reorders freely on its own day (R-ib-16)", async () => {
    const { editor, trip } = await seedCollabTrip();
    const booking = await createBookingVia(trip.id, editor.accessToken, {
      category: "activity",
      title: "Fixed-time",
      status: "planned",
      details: { category: "activity", starts_at: "2026-09-03T10:00:00+09:00" },
    });
    const items = await dbBookingItems(booking.id);
    const timedItemId = items[0]!.id;
    const neighbor = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Neighbor",
      day: "2026-09-03",
    });

    const pulled = await putDayOrder(trip.id, "2026-09-04", editor.accessToken, {
      item_ids: [timedItemId],
    });
    expect(pulled.status).toBe(400);
    expect(((await pulled.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    const sameDay = await putDayOrder(trip.id, "2026-09-03", editor.accessToken, {
      item_ids: [neighbor.id, timedItemId],
    });
    expect(sameDay.status).toBe(200);
    const result = DayOrderResultSchema.parse(await sameDay.json());
    expect(result.items.map((i) => [i.id, i.sort_order])).toEqual([
      [neighbor.id, 1024],
      [timedItemId, 2048],
    ]);
  });

  it("PUT order: deleted-elsewhere ids silently ignored (LWW — survivors compact); foreign-trip ids 400; duplicates 400; malformed day 400", async () => {
    const { editor, trip } = await seedCollabTrip();
    const a = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "A",
      day: "2026-09-02",
    });
    const b = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "B",
      day: "2026-09-02",
    });

    const withGhost = await putDayOrder(trip.id, "2026-09-02", editor.accessToken, {
      item_ids: [b.id, NONEXISTENT_UUID, a.id],
    });
    expect(withGhost.status).toBe(200);
    const result = DayOrderResultSchema.parse(await withGhost.json());
    expect(result.items.map((i) => [i.id, i.sort_order])).toEqual([
      [b.id, 1024],
      [a.id, 2048], // ghost ignored ⇒ positions compact
    ]);

    const other = await seedCollabTrip();
    const foreign = await createItemVia(other.trip.id, other.editor.accessToken, {
      kind: "custom",
      title: "Foreign",
      day: "2026-09-02",
    });
    const crossTrip = await putDayOrder(trip.id, "2026-09-02", editor.accessToken, {
      item_ids: [a.id, foreign.id],
    });
    expect(crossTrip.status).toBe(400);
    expect(((await crossTrip.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    // The foreign row was not touched.
    expect((await dbItem(foreign.id))?.day).toBe("2026-09-02");
    expect((await dbItem(foreign.id))?.tripId).toBe(other.trip.id);

    expect(
      (
        await putDayOrder(trip.id, "2026-09-02", editor.accessToken, {
          item_ids: [a.id, a.id],
        })
      ).status,
    ).toBe(400);
    expect(
      (await putDayOrder(trip.id, "2026-9-2", editor.accessToken, { item_ids: [] })).status,
    ).toBe(400);
  });

  it("PUT order: a pulled spanning item keeps end_day; a pull that would invert the span 400s", async () => {
    const { editor, trip } = await seedCollabTrip();
    const spanning = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "Span",
      day: "2026-09-02",
      end_day: "2026-09-03",
    });

    const inverted = await putDayOrder(trip.id, "2026-09-05", editor.accessToken, {
      item_ids: [spanning.id],
    });
    expect(inverted.status).toBe(400);

    const legal = await putDayOrder(trip.id, "2026-09-03", editor.accessToken, {
      item_ids: [spanning.id],
    });
    expect(legal.status).toBe(200);
    expect((await dbItem(spanning.id))?.endDay).toBe("2026-09-03");
  });

  it("PUT order: concurrent PUTs serialize — last write wins whole, no partial interleave (R-ib-15/18)", async () => {
    const { editor, owner, trip } = await seedCollabTrip();
    const a = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "A",
      day: "2026-09-08",
    });
    const b = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "B",
      day: "2026-09-08",
    });
    const c = await createItemVia(trip.id, editor.accessToken, {
      kind: "custom",
      title: "C",
      day: "2026-09-08",
    });

    const orderOne = [a.id, b.id, c.id];
    const orderTwo = [c.id, b.id, a.id];
    const [resOne, resTwo] = await Promise.all([
      putDayOrder(trip.id, "2026-09-08", editor.accessToken, { item_ids: orderOne }),
      putDayOrder(trip.id, "2026-09-08", owner.accessToken, { item_ids: orderTwo }),
    ]);
    expect(resOne.status).toBe(200);
    expect(resTwo.status).toBe(200);

    const rows = await db
      .select({ id: schema.itineraryItems.id, sortOrder: schema.itineraryItems.sortOrder })
      .from(schema.itineraryItems)
      .where(inArray(schema.itineraryItems.id, orderOne))
      .orderBy(schema.itineraryItems.sortOrder, schema.itineraryItems.id);
    const finalOrder = rows.map((r) => r.id);
    const finalSorts = rows.map((r) => r.sortOrder);
    // One submission won IN FULL: exact 1024-gapped assignment of one order,
    // never a mix of the two.
    expect(finalSorts).toEqual([1024, 2048, 3072]);
    expect([JSON.stringify(orderOne), JSON.stringify(orderTwo)]).toContain(
      JSON.stringify(finalOrder),
    );
  });

  it("PUT order: viewer 403 (R-ib-24)", async () => {
    const { owner, viewer, trip } = await seedCollabTrip();
    const item = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "X",
      day: "2026-09-02",
    });
    expect(
      (
        await putDayOrder(trip.id, "2026-09-02", viewer.accessToken, { item_ids: [item.id] })
      ).status,
    ).toBe(403);
  });

  // ===========================================================================
  // F-038 IDOR harness (R-ib-24): trip AND item ids, byte-identical 404s
  // ===========================================================================

  it("F-038: stranger, nonexistent, and malformed TRIP ids are BYTE-IDENTICAL 404s on every route", async () => {
    const { owner, trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();
    const item = await createItemVia(trip.id, owner.accessToken, {
      kind: "custom",
      title: "target",
      day: "2026-09-02",
    });
    const createBody = { kind: "custom", title: "x", day: "2026-09-02" };
    const orderBody = { item_ids: [item.id] };

    await expectIndistinguishable404s([
      await getItinerary(trip.id, stranger.accessToken),
      await getItinerary(NONEXISTENT_UUID, stranger.accessToken),
      await getItinerary("not-a-uuid", stranger.accessToken),
    ]);
    await expectIndistinguishable404s([
      await postItem(trip.id, stranger.accessToken, createBody),
      await postItem(NONEXISTENT_UUID, stranger.accessToken, createBody),
    ]);
    await expectIndistinguishable404s([
      await patchItem(trip.id, item.id, stranger.accessToken, { notes: "x" }),
      await patchItem(NONEXISTENT_UUID, item.id, stranger.accessToken, { notes: "x" }),
    ]);
    await expectIndistinguishable404s([
      await deleteItemReq(trip.id, item.id, stranger.accessToken),
      await deleteItemReq(NONEXISTENT_UUID, item.id, stranger.accessToken),
    ]);
    await expectIndistinguishable404s([
      await putDayOrder(trip.id, "2026-09-02", stranger.accessToken, orderBody),
      await putDayOrder(NONEXISTENT_UUID, "2026-09-02", stranger.accessToken, orderBody),
    ]);
  });

  it("F-038: wrong-trip, nonexistent, and malformed ITEM ids are BYTE-IDENTICAL 404s for a proven member", async () => {
    const { owner, trip } = await seedCollabTrip();
    const other = await seedCollabTrip(); // an item the caller can't see
    const foreign = await createItemVia(other.trip.id, other.owner.accessToken, {
      kind: "custom",
      title: "foreign",
      day: "2026-09-02",
    });

    await expectIndistinguishable404s([
      await patchItem(trip.id, foreign.id, owner.accessToken, { notes: "x" }), // exists, other trip
      await patchItem(trip.id, NONEXISTENT_UUID, owner.accessToken, { notes: "x" }), // absent
      await patchItem(trip.id, "not-a-uuid", owner.accessToken, { notes: "x" }), // malformed, same door
    ]);
    await expectIndistinguishable404s([
      await deleteItemReq(trip.id, foreign.id, owner.accessToken),
      await deleteItemReq(trip.id, NONEXISTENT_UUID, owner.accessToken),
      await deleteItemReq(trip.id, "not-a-uuid", owner.accessToken),
    ]);
    // The wrong-trip row survived both probes.
    expect(await dbItem(foreign.id)).toBeDefined();
  });
});
