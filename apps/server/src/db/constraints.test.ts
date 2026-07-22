/**
 * DB-1 constraint/invariant suite (schema spec §4) — runs the initial
 * migration against an ephemeral testcontainers Postgres and verifies the
 * structural halves of R-db-1 … R-db-22.
 *
 * Driver: postgres-js (ADR-004 test harness). Transaction tests exercise a
 * transaction-capable driver on purpose — prod uses the Neon WebSocket Pool
 * which is also transaction-capable (landmine #1: neon-http is NOT).
 *
 * Requires Docker. In CI (`process.env.CI`) a Docker-less run is a HARD
 * FAILURE — a skip must never be mistaken for a verified DB-1. Locally (no
 * CI) the suite skips with a loud banner so you can still run the rest of the
 * gate; the turbo `test` task disables its cache (turbo.json) so a local skip
 * can never be replayed as a cached green.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BookingDetails } from "@gogo/shared/domains/booking";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserWithEntitlements } from "./create-user.js";
import * as schema from "./schema/index.js";

const dockerAvailable = await (async () => {
  try {
    await promisify(execFile)("docker", ["info"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

if (!dockerAvailable) {
  console.warn(
    "\n" +
      "╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  DOCKER UNAVAILABLE — DB-1 CONSTRAINT SUITE SKIPPED               ║\n" +
      "║  The schema/migration invariants (R-db-1…R-db-22) were NOT        ║\n" +
      "║  verified. Start Docker and re-run `pnpm --filter @gogo/server    ║\n" +
      "║  test` before treating this branch as green.                      ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

// CI must verify DB-1 for real. A Docker-less CI run is a HARD FAILURE, never
// a skip — otherwise a green run is indistinguishable from "never ran". The
// turbo `test` task also disables caching (turbo.json cache:false) so a local
// skip can't be replayed as a cached pass. Locally (no CI) we skip with the
// loud banner above and let the rest of the gate run.
if (!dockerAvailable && process.env.CI) {
  it("DB-1 constraint suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the DB-1 constraint suite could " +
        "not verify R-db-1…R-db-22. A skip here is NOT a pass. Provision Docker " +
        "or a Postgres service container and re-run.",
    );
  });
}

// Container boot (+ first-time image pull) is slow; DB roundtrips are not.
const BOOT_TIMEOUT_MS = 240_000;

describe.skipIf(!dockerAvailable)("DB-1 schema constraint suite", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    // 60s startup budget — concurrent DB suites can exceed the default 10s
    // port-bind wait in the full gate (T-5.2 round-1 flake).
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(60_000)
      .start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    // R-db-12 baseline: the initial migration applies cleanly to a blank DB.
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(db, { migrationsFolder });
    // R-db-12 idempotence: a second migrate() over an already-migrated DB is a
    // no-op, never an error (a broken hash-journal would throw here).
    await migrate(db, { migrationsFolder });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---------------------------------------------------------------------
  // Seed helpers
  // ---------------------------------------------------------------------
  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  /**
   * drizzle-orm wraps driver errors in DrizzleQueryError ("Failed query: …")
   * with the Postgres error on `.cause` — walk the cause chain so assertions
   * can match on constraint names.
   */
  async function expectPgError(promise: Promise<unknown>, pattern: RegExp) {
    const error = await promise.then(
      () => {
        throw new Error(`expected query to reject with ${String(pattern)}`);
      },
      (e: unknown) => e,
    );
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(" | ")).toMatch(pattern);
  }

  async function seedUser() {
    const { user } = await createUserWithEntitlements(db, {
      email: `u-${uniq()}@example.com`,
      displayName: "Test User",
      appleSub: `apple-${uniq()}`,
    });
    return user;
  }

  async function seedTrip(ownerId: string) {
    const [trip] = await db
      .insert(schema.trips)
      .values({
        name: "Test trip",
        destinationName: "Tokyo, Japan",
        destinationLat: "35.676200",
        destinationLng: "139.650300",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        createdBy: ownerId,
      })
      .returning();
    if (!trip) throw new Error("no trip row");
    await db.insert(schema.tripMembers).values({ tripId: trip.id, userId: ownerId, role: "owner" });
    return trip;
  }

  async function seedPlace(overrides: Partial<typeof schema.places.$inferInsert> = {}) {
    const [place] = await db
      .insert(schema.places)
      .values({
        source: "overture",
        sourceId: `ov-${uniq()}`,
        name: "Sensō-ji",
        lat: "35.714800",
        lng: "139.796700",
        ...overrides,
      })
      .returning();
    if (!place) throw new Error("no place row");
    return place;
  }

  async function seedBooking(
    tripId: string,
    createdBy: string,
    overrides: Partial<typeof schema.bookings.$inferInsert> = {},
  ) {
    const [booking] = await db
      .insert(schema.bookings)
      .values({ tripId, category: "lodging", title: "Park Hyatt Tokyo", createdBy, ...overrides })
      .returning();
    if (!booking) throw new Error("no booking row");
    return booking;
  }

  async function seedItineraryItem(
    tripId: string,
    createdBy: string,
    overrides: Partial<typeof schema.itineraryItems.$inferInsert> = {},
  ) {
    const [item] = await db
      .insert(schema.itineraryItems)
      .values({
        tripId,
        kind: "custom",
        title: "Walk Shibuya",
        day: "2026-08-02",
        createdBy,
        ...overrides,
      })
      .returning();
    if (!item) throw new Error("no itinerary item row");
    return item;
  }

  async function seedExpense(
    tripId: string,
    paidBy: string,
    overrides: Partial<typeof schema.expenses.$inferInsert> = {},
  ) {
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        tripId,
        description: "Dinner",
        category: "food",
        paidBy,
        amountCents: 12_000,
        currency: "JPY",
        createdBy: paidBy,
        ...overrides,
      })
      .returning();
    if (!expense) throw new Error("no expense row");
    return expense;
  }

  async function seedCapture(userId: string) {
    const [capture] = await db
      .insert(schema.captureInbox)
      .values({ userId, source: "email", rawRef: `raw/${uniq()}` })
      .returning();
    if (!capture) throw new Error("no capture row");
    return capture;
  }

  // ---------------------------------------------------------------------
  // Migration baseline
  // ---------------------------------------------------------------------
  describe("migration baseline (R-db-12)", () => {
    it("creates all 30 tables (27 schema-spec + 3 auth-spec)", async () => {
      const rows = await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      expect(rows.map((r) => r.table_name)).toEqual(
        [
          "ai_cache",
          "ai_usage",
          "apple_credentials",
          "auth_sessions",
          "bookings",
          "budgets",
          "capture_inbox",
          "capture_senders",
          "documents",
          "entitlements",
          "expense_shares",
          "expenses",
          "invites",
          "itinerary_items",
          "packing_lists",
          "photos",
          "place_ingest_regions",
          "places",
          "push_tokens",
          "recaps",
          "refresh_tokens",
          "saved_places",
          "settlement_requests",
          "settlements",
          "tour_guide_bundles",
          "travel_legs",
          "trip_members",
          "trips",
          "users",
          "weather_cache",
        ].sort(),
      );
    });

    it("enables pg_trgm (places type-ahead GIN index)", async () => {
      const rows = await db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // R-db-1 — money law
  // ---------------------------------------------------------------------
  describe("R-db-1 money law", () => {
    it("has zero float/money-typed columns anywhere", async () => {
      const rows = await db.execute(sql`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('real', 'double precision', 'money')
      `);
      expect(rows).toEqual([]);
    });

    it("stores every *_cents column as bigint", async () => {
      const offenders = await db.execute(sql`
        SELECT table_name, column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%\\_cents' AND udt_name <> 'int8'
      `);
      expect(offenders).toEqual([]);

      const centsColumns = await db.execute(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%\\_cents'
      `);
      // Sanity: the scan actually saw the money columns.
      expect(centsColumns.length).toBeGreaterThanOrEqual(9);
    });

    it("restricts numeric columns to coordinates and fx_rate (never money)", async () => {
      const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'numeric'
      `);
      const allowed = new Set([
        "lat",
        "lng",
        "destination_lat",
        "destination_lng",
        "min_lat",
        "min_lng",
        "max_lat",
        "max_lng",
        "fx_rate",
      ]);
      for (const row of rows) {
        expect(allowed, `${row.table_name}.${row.column_name} is numeric`).toContain(
          row.column_name,
        );
      }
    });
  });

  // ---------------------------------------------------------------------
  // §1 timestamp convention — timestamptz everywhere
  // ---------------------------------------------------------------------
  describe("timestamp convention (schema spec §1)", () => {
    it("has zero `timestamp without time zone` columns (all timestamptz)", async () => {
      const rows = await db.execute(sql`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
      `);
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // R-db-3 — photos default-private
  // ---------------------------------------------------------------------
  describe("R-db-3 photos privacy default", () => {
    it("defaults visibility to 'private' when omitted", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const [photo] = await db
        .insert(schema.photos)
        .values({ tripId: trip.id, userId: user.id, storageKey: `photos/${uniq()}.jpg` })
        .returning();
      expect(photo?.visibility).toBe("private");
    });

    it("rejects an explicit NULL visibility (NOT NULL enforced)", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await expectPgError(
        db.execute(sql`
          INSERT INTO photos (trip_id, user_id, storage_key, visibility)
          VALUES (${trip.id}, ${user.id}, ${`photos/${uniq()}.jpg`}, NULL)
        `),
        /not-null constraint/,
      );
    });
  });

  // ---------------------------------------------------------------------
  // Unique / partial-unique rejections
  // ---------------------------------------------------------------------
  describe("unique constraints", () => {
    it("R-db-8: rejects a second owner per trip, allows more editors/viewers", async () => {
      const owner = await seedUser();
      const trip = await seedTrip(owner.id);
      const second = await seedUser();
      await expectPgError(
        db.insert(schema.tripMembers).values({ tripId: trip.id, userId: second.id, role: "owner" }),
        /uq_trip_single_owner/,
      );

      const editor = await seedUser();
      const viewer = await seedUser();
      await db.insert(schema.tripMembers).values([
        { tripId: trip.id, userId: editor.id, role: "editor" },
        { tripId: trip.id, userId: viewer.id, role: "viewer" },
      ]);
    });

    it("R-db-6: rejects duplicate (source, source_id); custom places are exempt", async () => {
      const sourceId = `ov-${uniq()}`;
      await seedPlace({ sourceId });
      await expectPgError(seedPlace({ sourceId }), /places_source_source_id_uq/);

      const creator = await seedUser();
      await seedPlace({ source: "custom", sourceId: null, createdBy: creator.id });
      await seedPlace({ source: "custom", sourceId: null, createdBy: creator.id });
    });

    it("rejects a second booking landing the same capture; NULL captures unlimited", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const capture = await seedCapture(user.id);
      await seedBooking(trip.id, user.id, { captureId: capture.id });
      await expectPgError(
        seedBooking(trip.id, user.id, { captureId: capture.id }),
        /bookings_capture_id_uq/,
      );
      await seedBooking(trip.id, user.id);
      await seedBooking(trip.id, user.id);
    });

    it("rejects duplicate saved place and duplicate tour-guide bundle per (trip, place)", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const place = await seedPlace();
      await db.insert(schema.savedPlaces).values({ tripId: trip.id, placeId: place.id });
      await expectPgError(
        db.insert(schema.savedPlaces).values({ tripId: trip.id, placeId: place.id }),
        /saved_places_trip_place_uq/,
      );

      await db.insert(schema.tourGuideBundles).values({ tripId: trip.id, placeId: place.id });
      await expectPgError(
        db.insert(schema.tourGuideBundles).values({ tripId: trip.id, placeId: place.id }),
        /tour_guide_bundles_trip_place_uq/,
      );
    });

    it("R-db-15: rejects a duplicate leg, allows the same pair in another mode", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const a = await seedItineraryItem(trip.id, user.id);
      const b = await seedItineraryItem(trip.id, user.id);
      const leg = {
        tripId: trip.id,
        fromItemId: a.id,
        toItemId: b.id,
        durationSeconds: 600,
        distanceMeters: 900,
        provider: "mapbox",
        computedAt: new Date(),
      };
      await db.insert(schema.travelLegs).values({ ...leg, mode: "walking" });
      await expectPgError(
        db.insert(schema.travelLegs).values({ ...leg, mode: "walking" }),
        /travel_legs_from_to_mode_uq/,
      );
      await db.insert(schema.travelLegs).values({ ...leg, mode: "transit" });
    });

    it("rejects case-insensitive duplicate emails (lower(email) unique)", async () => {
      const local = `dup-${uniq()}`;
      await createUserWithEntitlements(db, {
        email: `${local}@Example.com`,
        displayName: "One",
        appleSub: `apple-${uniq()}`,
      });
      await expectPgError(
        createUserWithEntitlements(db, {
          email: `${local}@example.com`,
          displayName: "Two",
          appleSub: `apple-${uniq()}`,
        }),
        /users_email_lower_uq/,
      );
    });

    it("R-db-19 seam: rejects a second recap for the same trip", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await db.insert(schema.recaps).values({ tripId: trip.id });
      await expectPgError(
        db.insert(schema.recaps).values({ tripId: trip.id }),
        /recaps_trip_id_uq/,
      );
    });

    it("rejects a second shared packing list per trip (partial: user_id IS NULL)", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await db.insert(schema.packingLists).values({ tripId: trip.id });
      await expectPgError(
        db.insert(schema.packingLists).values({ tripId: trip.id }),
        /packing_lists_shared_trip_uq/,
      );
      // Personal-list seam stays open: a user-scoped list coexists.
      await db.insert(schema.packingLists).values({ tripId: trip.id, userId: user.id });
    });

    it("rejects a duplicate apple_sub and a duplicate google_sub (auth identity)", async () => {
      const appleSub = `apple-${uniq()}`;
      await createUserWithEntitlements(db, {
        email: `apple-a-${uniq()}@example.com`,
        displayName: "Apple A",
        appleSub,
      });
      await expectPgError(
        createUserWithEntitlements(db, {
          email: `apple-b-${uniq()}@example.com`,
          displayName: "Apple B",
          appleSub,
        }),
        /users_apple_sub_unique/,
      );

      const googleSub = `google-${uniq()}`;
      await createUserWithEntitlements(db, {
        email: `google-a-${uniq()}@example.com`,
        displayName: "Google A",
        googleSub,
      });
      await expectPgError(
        createUserWithEntitlements(db, {
          email: `google-b-${uniq()}@example.com`,
          displayName: "Google B",
          googleSub,
        }),
        /users_google_sub_unique/,
      );
    });

    it("rejects a duplicate invite token", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const token = `t-${uniq()}`;
      const base = {
        tripId: trip.id,
        role: "editor" as const,
        createdBy: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      };
      await db.insert(schema.invites).values({ ...base, token });
      await expectPgError(
        db.insert(schema.invites).values({ ...base, token }),
        /invites_token_unique/,
      );
    });

    it("rejects a duplicate refresh-token hash", async () => {
      const user = await seedUser();
      const [session] = await db
        .insert(schema.authSessions)
        .values({ userId: user.id, platform: "ios" })
        .returning();
      const tokenHash = `hash-${uniq()}`;
      const expiresAt = new Date(Date.now() + 3600_000);
      await db
        .insert(schema.refreshTokens)
        .values({ sessionId: session!.id, tokenHash, expiresAt });
      await expectPgError(
        db.insert(schema.refreshTokens).values({ sessionId: session!.id, tokenHash, expiresAt }),
        /refresh_tokens_token_hash_unique/,
      );
    });

    it("rejects a duplicate photo storage_key", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const storageKey = `photos/${uniq()}.jpg`;
      await db.insert(schema.photos).values({ tripId: trip.id, userId: user.id, storageKey });
      await expectPgError(
        db.insert(schema.photos).values({ tripId: trip.id, userId: user.id, storageKey }),
        /photos_storage_key_unique/,
      );
    });

    it("rejects a duplicate budget per (trip, category)", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await db
        .insert(schema.budgets)
        .values({ tripId: trip.id, category: "food", currency: "USD" });
      await expectPgError(
        db.insert(schema.budgets).values({ tripId: trip.id, category: "food", currency: "USD" }),
        /budgets_trip_category_uq/,
      );
    });
  });

  // ---------------------------------------------------------------------
  // CHECK rejections
  // ---------------------------------------------------------------------
  describe("CHECK constraints", () => {
    it("rejects non-positive expense amounts", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await expectPgError(
        seedExpense(trip.id, user.id, { amountCents: 0 }),
        /expenses_amount_positive_ck/,
      );
      await expectPgError(
        seedExpense(trip.id, user.id, { amountCents: -100 }),
        /expenses_amount_positive_ck/,
      );
    });

    it("rejects negative share/budget/booking/trip cents", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const expense = await seedExpense(trip.id, user.id);
      await expectPgError(
        db
          .insert(schema.expenseShares)
          .values({ expenseId: expense.id, userId: user.id, shareCents: -1 }),
        /expense_shares_nonnegative_ck/,
      );
      await expectPgError(
        db
          .insert(schema.budgets)
          .values({ tripId: trip.id, category: "food", capCents: -1, currency: "USD" }),
        /budgets_cap_nonnegative_ck/,
      );
      await expectPgError(
        seedBooking(trip.id, user.id, { priceCents: -1, currency: "USD" }),
        /bookings_price_nonnegative_ck/,
      );
      await expectPgError(
        db.execute(sql`UPDATE trips SET budget_cap_cents = -1 WHERE id = ${trip.id}`),
        /trips_budget_cap_nonnegative_ck/,
      );
    });

    it("R-db-13: rejects non-uppercase currencies and a price without a currency", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await expectPgError(
        seedExpense(trip.id, user.id, { currency: "usd" }),
        /expenses_currency_upper_ck/,
      );
      await expectPgError(
        db.execute(sql`UPDATE trips SET base_currency = 'usd' WHERE id = ${trip.id}`),
        /trips_base_currency_upper_ck/,
      );
      await expectPgError(
        seedBooking(trip.id, user.id, { priceCents: 10_000 }),
        /bookings_price_currency_ck/,
      );
    });

    it("rejects trips whose dates are inverted", async () => {
      const user = await seedUser();
      await expectPgError(
        db.insert(schema.trips).values({
          name: "Backwards",
          destinationName: "Nope",
          destinationLat: "0.000000",
          destinationLng: "0.000000",
          startDate: "2026-08-10",
          endDate: "2026-08-01",
          createdBy: user.id,
        }),
        /trips_dates_ck/,
      );
    });

    it("R-db-6: rejects custom places with a source_id, imports without one, and orphan customs", async () => {
      const creator = await seedUser();
      await expectPgError(
        seedPlace({ source: "custom", sourceId: `bad-${uniq()}`, createdBy: creator.id }),
        /places_custom_source_id_ck/,
      );
      await expectPgError(
        seedPlace({ source: "overture", sourceId: null }),
        /places_custom_source_id_ck/,
      );
      await expectPgError(
        seedPlace({ source: "custom", sourceId: null, createdBy: null }),
        /places_custom_created_by_ck/,
      );
    });

    it("rejects itinerary kind/column mismatches", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const place = await seedPlace();
      const booking = await seedBooking(trip.id, user.id);
      await expectPgError(
        seedItineraryItem(trip.id, user.id, { kind: "booking", bookingId: null }),
        /itinerary_items_booking_kind_ck/,
      );
      await expectPgError(
        seedItineraryItem(trip.id, user.id, { kind: "place_visit", placeId: null }),
        /itinerary_items_place_visit_kind_ck/,
      );
      await expectPgError(
        seedItineraryItem(trip.id, user.id, { kind: "custom", title: null }),
        /itinerary_items_custom_title_ck/,
      );
      await expectPgError(
        seedItineraryItem(trip.id, user.id, {
          kind: "place_visit",
          placeId: place.id,
          bookingId: booking.id,
        }),
        /itinerary_items_booking_only_ck/,
      );
      await expectPgError(
        seedItineraryItem(trip.id, user.id, { day: "2026-08-05", endDay: "2026-08-04" }),
        /itinerary_items_end_day_ck/,
      );
    });

    it("rejects self-legs and negative durations/distances", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const a = await seedItineraryItem(trip.id, user.id);
      const b = await seedItineraryItem(trip.id, user.id);
      const leg = {
        tripId: trip.id,
        fromItemId: a.id,
        toItemId: b.id,
        mode: "driving" as const,
        durationSeconds: 60,
        distanceMeters: 400,
        provider: "mapbox",
        computedAt: new Date(),
      };
      await expectPgError(
        db.insert(schema.travelLegs).values({ ...leg, toItemId: a.id }),
        /travel_legs_not_self_ck/,
      );
      await expectPgError(
        db.insert(schema.travelLegs).values({ ...leg, durationSeconds: -1 }),
        /travel_legs_duration_nonnegative_ck/,
      );
      await expectPgError(
        db.insert(schema.travelLegs).values({ ...leg, distanceMeters: -1 }),
        /travel_legs_distance_nonnegative_ck/,
      );
    });

    it("rejects 'ready' bundles and recaps without content", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const place = await seedPlace();
      await expectPgError(
        db
          .insert(schema.tourGuideBundles)
          .values({ tripId: trip.id, placeId: place.id, status: "ready" }),
        /tour_guide_bundles_ready_content_ck/,
      );
      await expectPgError(
        db.insert(schema.recaps).values({ tripId: trip.id, status: "ready" }),
        /recaps_ready_content_ck/,
      );
    });

    it("rejects self-settlements and self-requests", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await expectPgError(
        db.insert(schema.settlements).values({
          tripId: trip.id,
          fromUserId: user.id,
          toUserId: user.id,
          amountCents: 1_000,
          currency: "USD",
          method: "venmo",
          createdBy: user.id,
        }),
        /settlements_not_self_ck/,
      );
      await expectPgError(
        db.insert(schema.settlementRequests).values({
          tripId: trip.id,
          fromUserId: user.id,
          toUserId: user.id,
          amountCents: 1_000,
          currency: "USD",
        }),
        /settlement_requests_not_self_ck/,
      );
    });

    it("rejects live accounts with no provider identity; allows scrubbed rows", async () => {
      await expectPgError(
        db
          .insert(schema.users)
          .values({ email: `no-sub-${uniq()}@example.com`, displayName: "Ghost" }),
        /users_identity_or_scrubbed_ck/,
      );
      // Scrubbed soft-deleted rows legitimately have no identity (R-db-16).
      const [scrubbed] = await db
        .insert(schema.users)
        .values({
          email: `deleted:${randomUUID()}`,
          displayName: "Deleted user",
          deletedAt: new Date(),
        })
        .returning();
      expect(scrubbed).toBeDefined();
    });

    it("rejects invites with role 'owner' or a non-positive max_uses", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const base = {
        tripId: trip.id,
        createdBy: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      };
      await expectPgError(
        db.insert(schema.invites).values({ ...base, token: `t-${uniq()}`, role: "owner" }),
        /invites_role_not_owner_ck/,
      );
      await expectPgError(
        db
          .insert(schema.invites)
          .values({ ...base, token: `t-${uniq()}`, role: "editor", maxUses: 0 }),
        /invites_max_uses_positive_ck/,
      );
    });

    it("R-db-20/R-db-21: rejects unpaired fx and unpaired soft-delete columns", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      await expectPgError(
        seedExpense(trip.id, user.id, { fxRate: "0.00670000", baseAmountCents: null }),
        /expenses_fx_pair_ck/,
      );
      await expectPgError(
        seedExpense(trip.id, user.id, { deletedAt: new Date() }),
        /expenses_deleted_pair_ck/,
      );
    });

    it("rejects non-lowercase capture sender emails and zero-day document reminders", async () => {
      const user = await seedUser();
      await expectPgError(
        db.insert(schema.captureSenders).values({
          userId: user.id,
          email: `Upper-${uniq()}@Example.com`,
          verificationToken: `v-${uniq()}`,
        }),
        /capture_senders_email_lower_ck/,
      );
      await expectPgError(
        db.insert(schema.documents).values({
          userId: user.id,
          kind: "passport",
          title: "Passport",
          remindDaysBefore: 0,
        }),
        /documents_remind_days_positive_ck/,
      );
    });
  });

  // ---------------------------------------------------------------------
  // Referential-integrity matrix (§3.6 spot-checks)
  // ---------------------------------------------------------------------
  describe("delete-behavior matrix (§3.6)", () => {
    it("trip delete cascades the trip's world; user-owned rows detach (SET NULL)", async () => {
      const owner = await seedUser();
      const trip = await seedTrip(owner.id);
      const place = await seedPlace();
      await seedBooking(trip.id, owner.id);
      const item = await seedItineraryItem(trip.id, owner.id);
      const item2 = await seedItineraryItem(trip.id, owner.id);
      await db.insert(schema.travelLegs).values({
        tripId: trip.id,
        fromItemId: item.id,
        toItemId: item2.id,
        mode: "walking",
        durationSeconds: 300,
        distanceMeters: 250,
        provider: "mapbox",
        computedAt: new Date(),
      });
      const expense = await seedExpense(trip.id, owner.id);
      await db
        .insert(schema.expenseShares)
        .values({ expenseId: expense.id, userId: owner.id, shareCents: 12_000 });
      await db.insert(schema.savedPlaces).values({ tripId: trip.id, placeId: place.id });
      await db
        .insert(schema.budgets)
        .values({ tripId: trip.id, category: "food", currency: "USD" });
      await db
        .insert(schema.photos)
        .values({ tripId: trip.id, userId: owner.id, storageKey: `photos/${uniq()}.jpg` });
      await db.insert(schema.tourGuideBundles).values({ tripId: trip.id, placeId: place.id });
      await db.insert(schema.recaps).values({ tripId: trip.id });
      await db.insert(schema.packingLists).values({ tripId: trip.id });
      const capture = await seedCapture(owner.id);
      await db
        .update(schema.captureInbox)
        .set({ tripId: trip.id })
        .where(eq(schema.captureInbox.id, capture.id));
      const [doc] = await db
        .insert(schema.documents)
        .values({ userId: owner.id, tripId: trip.id, kind: "visa", title: "Japan visa" })
        .returning();
      // A second member so invites / settlements / requests can be seeded
      // (settlements & requests are not-self, needing two distinct users).
      const other = await seedUser();
      await db
        .insert(schema.tripMembers)
        .values({ tripId: trip.id, userId: other.id, role: "editor" });
      await db.insert(schema.invites).values({
        tripId: trip.id,
        token: `t-${uniq()}`,
        role: "editor",
        createdBy: owner.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      });
      await db.insert(schema.settlements).values({
        tripId: trip.id,
        fromUserId: owner.id,
        toUserId: other.id,
        amountCents: 5_000,
        currency: "USD",
        method: "venmo",
        createdBy: owner.id,
      });
      await db.insert(schema.settlementRequests).values({
        tripId: trip.id,
        fromUserId: other.id,
        toUserId: owner.id,
        amountCents: 5_000,
        currency: "USD",
      });

      await db.delete(schema.trips).where(eq(schema.trips.id, trip.id));

      const tripScoped = [
        schema.tripMembers.tripId,
        schema.bookings.tripId,
        schema.itineraryItems.tripId,
        schema.travelLegs.tripId,
        schema.expenses.tripId,
        schema.savedPlaces.tripId,
        schema.budgets.tripId,
        schema.photos.tripId,
        schema.tourGuideBundles.tripId,
        schema.recaps.tripId,
        schema.packingLists.tripId,
        schema.invites.tripId,
        schema.settlements.tripId,
        schema.settlementRequests.tripId,
      ];
      for (const column of tripScoped) {
        const rows = await db.execute(
          sql`SELECT 1 FROM ${column.table} WHERE ${column} = ${trip.id}`,
        );
        expect(rows, `${column.name} rows should cascade`).toHaveLength(0);
      }
      // Shares cascade via their expense.
      const shares = await db
        .select()
        .from(schema.expenseShares)
        .where(eq(schema.expenseShares.expenseId, expense.id));
      expect(shares).toHaveLength(0);

      // capture_inbox and documents survive with trip_id = NULL.
      const [captureAfter] = await db
        .select()
        .from(schema.captureInbox)
        .where(eq(schema.captureInbox.id, capture.id));
      expect(captureAfter?.tripId).toBeNull();
      const [docAfter] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.id, doc!.id));
      expect(docAfter?.tripId).toBeNull();
      // The place spine is untouched.
      const [placeAfter] = await db
        .select()
        .from(schema.places)
        .where(eq(schema.places.id, place.id));
      expect(placeAfter).toBeDefined();
    });

    it("booking delete cascades its itinerary item but SET-NULLs its expense", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const booking = await seedBooking(trip.id, user.id);
      const item = await seedItineraryItem(trip.id, user.id, {
        kind: "booking",
        bookingId: booking.id,
        title: null,
      });
      const expense = await seedExpense(trip.id, user.id, { bookingId: booking.id });

      await db.delete(schema.bookings).where(eq(schema.bookings.id, booking.id));

      const items = await db
        .select()
        .from(schema.itineraryItems)
        .where(eq(schema.itineraryItems.id, item.id));
      expect(items).toHaveLength(0);
      const [expenseAfter] = await db
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.id, expense.id));
      expect(expenseAfter).toBeDefined();
      expect(expenseAfter?.bookingId).toBeNull();
    });

    it("R-db-16: user hard-delete is RESTRICTed while financial history exists", async () => {
      const owner = await seedUser();
      const payer = await seedUser();
      const trip = await seedTrip(owner.id);
      await db
        .insert(schema.tripMembers)
        .values({ tripId: trip.id, userId: payer.id, role: "editor" });
      await seedExpense(trip.id, payer.id);
      await expectPgError(
        db.delete(schema.users).where(eq(schema.users.id, payer.id)),
        /violates foreign key constraint/,
      );
    });

    it("user delete cascades pure per-user rows when no shared history exists", async () => {
      const user = await seedUser();
      await db
        .insert(schema.pushTokens)
        .values({ userId: user.id, token: `ExponentPushToken[${uniq()}]`, platform: "ios" });
      const [session] = await db
        .insert(schema.authSessions)
        .values({ userId: user.id, platform: "ios" })
        .returning();
      await db.insert(schema.refreshTokens).values({
        sessionId: session!.id,
        tokenHash: `hash-${uniq()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await db.delete(schema.users).where(eq(schema.users.id, user.id));

      const ent = await db
        .select()
        .from(schema.entitlements)
        .where(eq(schema.entitlements.userId, user.id));
      expect(ent).toHaveLength(0);
      const sessions = await db
        .select()
        .from(schema.authSessions)
        .where(eq(schema.authSessions.userId, user.id));
      expect(sessions).toHaveLength(0);
      // refresh_tokens cascade through auth_sessions.
      const tokens = await db
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.sessionId, session!.id));
      expect(tokens).toHaveLength(0);
    });

    it("place delete is RESTRICTed by pins, then SET-NULLs optional references", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const place = await seedPlace();
      const [saved] = await db
        .insert(schema.savedPlaces)
        .values({ tripId: trip.id, placeId: place.id })
        .returning();
      await expectPgError(
        db.delete(schema.places).where(eq(schema.places.id, place.id)),
        /violates foreign key constraint/,
      );

      await db.delete(schema.savedPlaces).where(eq(schema.savedPlaces.id, saved!.id));
      const booking = await seedBooking(trip.id, user.id, { placeId: place.id });
      const [photo] = await db
        .insert(schema.photos)
        .values({
          tripId: trip.id,
          userId: user.id,
          storageKey: `photos/${uniq()}.jpg`,
          placeId: place.id,
        })
        .returning();

      await db.delete(schema.places).where(eq(schema.places.id, place.id));

      const [bookingAfter] = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, booking.id));
      expect(bookingAfter?.placeId).toBeNull();
      const [photoAfter] = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.id, photo!.id));
      expect(photoAfter?.placeId).toBeNull();
    });

    it("capture delete SET-NULLs the booking that landed from it", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const capture = await seedCapture(user.id);
      const booking = await seedBooking(trip.id, user.id, { captureId: capture.id });
      await db.delete(schema.captureInbox).where(eq(schema.captureInbox.id, capture.id));
      const [after] = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, booking.id));
      expect(after).toBeDefined();
      expect(after?.captureId).toBeNull();
    });

    it("itinerary-item delete cascades legs and SET-NULLs photo pins", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const a = await seedItineraryItem(trip.id, user.id);
      const b = await seedItineraryItem(trip.id, user.id);
      await db.insert(schema.travelLegs).values({
        tripId: trip.id,
        fromItemId: a.id,
        toItemId: b.id,
        mode: "cycling",
        durationSeconds: 120,
        distanceMeters: 500,
        provider: "mapbox",
        computedAt: new Date(),
      });
      const [photo] = await db
        .insert(schema.photos)
        .values({
          tripId: trip.id,
          userId: user.id,
          storageKey: `photos/${uniq()}.jpg`,
          itineraryItemId: a.id,
        })
        .returning();

      await db.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, a.id));

      const legs = await db
        .select()
        .from(schema.travelLegs)
        .where(eq(schema.travelLegs.fromItemId, a.id));
      expect(legs).toHaveLength(0);
      const [photoAfter] = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.id, photo!.id));
      expect(photoAfter?.itineraryItemId).toBeNull();
    });

    it("settlement delete SET-NULLs the settlement_request that referenced it", async () => {
      const owner = await seedUser();
      const other = await seedUser();
      const trip = await seedTrip(owner.id);
      await db
        .insert(schema.tripMembers)
        .values({ tripId: trip.id, userId: other.id, role: "editor" });
      const [settlement] = await db
        .insert(schema.settlements)
        .values({
          tripId: trip.id,
          fromUserId: owner.id,
          toUserId: other.id,
          amountCents: 5_000,
          currency: "USD",
          method: "venmo",
          createdBy: owner.id,
        })
        .returning();
      const [request] = await db
        .insert(schema.settlementRequests)
        .values({
          tripId: trip.id,
          fromUserId: other.id,
          toUserId: owner.id,
          amountCents: 5_000,
          currency: "USD",
          settlementId: settlement!.id,
        })
        .returning();

      await db.delete(schema.settlements).where(eq(schema.settlements.id, settlement!.id));

      const [after] = await db
        .select()
        .from(schema.settlementRequests)
        .where(eq(schema.settlementRequests.id, request!.id));
      expect(after).toBeDefined();
      expect(after?.settlementId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // R-db-5 — entitlement seam
  // ---------------------------------------------------------------------
  describe("R-db-5 entitlement seam", () => {
    it("createUserWithEntitlements writes users + entitlements (plan 'free') atomically", async () => {
      const { user, entitlements } = await createUserWithEntitlements(db, {
        email: `seam-${uniq()}@example.com`,
        displayName: "Seam",
        googleSub: `google-${uniq()}`,
      });
      expect(entitlements.userId).toBe(user.id);
      expect(entitlements.plan).toBe("free");
      expect(entitlements.overrides).toEqual({});
    });

    it("rolls the users row back when the transaction fails midway", async () => {
      const email = `rollback-${uniq()}@example.com`;
      await expectPgError(
        db.transaction(async (tx) => {
          await tx
            .insert(schema.users)
            .values({ email, displayName: "Doomed", appleSub: `apple-${uniq()}` });
          // FK violation: entitlements for a user that doesn't exist.
          await tx.insert(schema.entitlements).values({ userId: randomUUID() });
        }),
        /violates foreign key constraint/,
      );

      const rows = await db.select().from(schema.users).where(eq(schema.users.email, email));
      expect(rows).toHaveLength(0);
    });

    it("rolls the users row back when createUserWithEntitlements' own entitlements write fails", async () => {
      // Regression guard: fault-inject the helper ITSELF (the test above hand-
      // rolls its own transaction and would still pass if the helper's
      // db.transaction wrapper — the exact thing R-db-5 protects — were removed).
      // A CHECK (false) NOT VALID rejects any NEW entitlements insert without
      // touching existing rows, so the helper's second write blows up mid-tx.
      await db.execute(
        sql`ALTER TABLE entitlements ADD CONSTRAINT tmp_fail CHECK (false) NOT VALID`,
      );
      const email = `helper-rollback-${uniq()}@example.com`;
      try {
        await expectPgError(
          createUserWithEntitlements(db, {
            email,
            displayName: "Doomed",
            appleSub: `apple-${uniq()}`,
          }),
          /tmp_fail/,
        );
        const rows = await db.select().from(schema.users).where(eq(schema.users.email, email));
        expect(rows).toHaveLength(0);
      } finally {
        await db.execute(sql`ALTER TABLE entitlements DROP CONSTRAINT tmp_fail`);
      }
    });
  });

  // ---------------------------------------------------------------------
  // ai_usage upsert-increment
  // ---------------------------------------------------------------------
  describe("ai_usage upsert-increment (R-db-5 structural support)", () => {
    it("round-trips a single upsert-increment on PK (user_id, feature, day)", async () => {
      const user = await seedUser();
      const key = { userId: user.id, feature: "recommendations" as const, day: "2026-07-10" };
      const increment = (input: number, output: number) =>
        db
          .insert(schema.aiUsage)
          .values({ ...key, calls: 1, inputTokens: input, outputTokens: output })
          .onConflictDoUpdate({
            target: [schema.aiUsage.userId, schema.aiUsage.feature, schema.aiUsage.day],
            set: {
              calls: sql`${schema.aiUsage.calls} + 1`,
              inputTokens: sql`${schema.aiUsage.inputTokens} + ${input}`,
              outputTokens: sql`${schema.aiUsage.outputTokens} + ${output}`,
              // EXEMPLAR (correctness landmine): Drizzle's `$onUpdate` does NOT
              // fire through `onConflictDoUpdate`, so every upsert set-clause
              // must bump `updated_at` by hand or the row's timestamp freezes at
              // first insert. See schema/_shared.ts.
              updatedAt: sql`now()`,
            },
          });

      await increment(100, 40);
      await increment(25, 10);

      const [row] = await db
        .select()
        .from(schema.aiUsage)
        .where(
          and(
            eq(schema.aiUsage.userId, key.userId),
            eq(schema.aiUsage.feature, key.feature),
            eq(schema.aiUsage.day, key.day),
          ),
        );
      expect(row).toBeDefined();
      expect(row?.calls).toBe(2);
      expect(row?.inputTokens).toBe(125);
      expect(row?.outputTokens).toBe(50);
    });
  });

  // ---------------------------------------------------------------------
  // JSONB $type persistence
  // ---------------------------------------------------------------------
  describe("JSONB round-trip (R-db-11 $type columns)", () => {
    it("writes a real BookingDetails payload to bookings.details and reads it back intact", async () => {
      const user = await seedUser();
      const trip = await seedTrip(user.id);
      const details: BookingDetails = {
        category: "lodging",
        property_name: "Park Hyatt Tokyo",
        address: "3-7-1-2 Nishishinjuku, Shinjuku-ku",
        check_in: "2026-08-01T15:00:00+09:00",
        check_out: "2026-08-05T11:00:00+09:00",
        guests: 2,
        room_type: "Park Deluxe King",
        provider: "direct",
        notes: "High floor requested",
      };
      const booking = await seedBooking(trip.id, user.id, { details });
      const [row] = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, booking.id));
      expect(row?.details).toEqual(details);
    });
  });
});
