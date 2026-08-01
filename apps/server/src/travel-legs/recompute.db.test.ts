/**
 * T-7.3 recompute integration suite (IB-3): the §3.5 steps 2–5 contract over
 * a real Postgres — adjacency/diff/cleanup matrix, same-place zero legs,
 * booking-place resolution, spanning-item chains, transit degradation
 * (absent rows, never errors), provider-outage row retention, deterministic
 * timeout on a hung provider, the item-deletion FK race (T-7.1 handoff), and
 * the R-ib-23 staleness sweep. Provider ports are FAKES — zero live network
 * (Law #5; the T-6.4 fixture precedent).
 *
 * Timestamp discipline: every seeded row gets an EXPLICIT `updated_at` in
 * the past (and "touches" set an explicit future-of-computed value) so the
 * reuse rule's comparisons never race host-vs-container clocks.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. Run server DB suites with `--no-file-parallelism` (QUEUE P1).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TravelMode } from "@gogo/shared/enums";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { DirtyDayMark } from "../bookings/dirty-days.js";
import { createLegRecomputer, isTravelLegFkViolation, SAME_PLACE_PROVIDER } from "./recompute.js";
import { sweepStaleLegs } from "./staleness.js";
import type { RouteQuery, RouteResult, RoutingPort } from "./providers.js";
import type { TravelLegScheduler } from "./worker.js";

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
      "║  DOCKER UNAVAILABLE — T-7.3 RECOMPUTE SUITE SKIPPED               ║\n" +
      "║  The §3.5 adjacency/diff/cleanup matrix, transit degradation,     ║\n" +
      "║  provider-outage retention, the item-deletion FK race, and the    ║\n" +
      "║  R-ib-23 staleness sweep were NOT verified. Start Docker and      ║\n" +
      "║  re-run `pnpm --filter @gogo/server test` before treating this    ║\n" +
      "║  green.                                                           ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-7.3 recompute suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-7.3 recompute suite could " +
        "not verify itinerary-bookings spec §3.5 (R-ib-19..23). A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const HOUR_MS = 3_600_000;

/** Recording fake port. Default: deterministic 600 s / 1000 m per call. */
function fakePort(
  provider: string,
  modes: readonly TravelMode[],
  impl?: (query: RouteQuery, mode: TravelMode) => Promise<RouteResult | null>,
): { port: RoutingPort; calls: { mode: TravelMode; from: RouteQuery["from"] }[] } {
  const calls: { mode: TravelMode; from: RouteQuery["from"] }[] = [];
  return {
    calls,
    port: {
      provider,
      modes,
      route(query, mode) {
        calls.push({ mode, from: query.from });
        return impl
          ? impl(query, mode)
          : Promise.resolve({ durationSeconds: 600, distanceMeters: 1000 });
      },
    },
  };
}

/** Immediate manual scheduler for the deterministic-timeout test. */
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
    } satisfies TravelLegScheduler,
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

describe.skipIf(!dockerAvailable)("T-7.3 leg recompute (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let userId: string;

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
  /** Stable past stamp — seeded rows are "unchanged since long before now". */
  const PAST = new Date(Date.now() - 6 * HOUR_MS);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(60_000)
      .start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    const { user } = await createUserWithEntitlements(db, {
      email: `legs-${uniq()}@example.com`,
      displayName: "Leg Tester",
      googleSub: `google-${uniq()}`,
    });
    userId = user.id;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedTrip(dates?: { start: string; end: string }) {
    const [trip] = await db
      .insert(schema.trips)
      .values({
        name: `Legs ${uniq()}`,
        destinationName: "Tokyo",
        destinationLat: "35.689500",
        destinationLng: "139.691700",
        startDate: dates?.start ?? "2026-09-01",
        endDate: dates?.end ?? "2026-09-10",
        createdBy: userId,
      })
      .returning();
    expect(trip).toBeDefined();
    await db.insert(schema.tripMembers).values({ tripId: trip!.id, userId, role: "owner" });
    return trip!;
  }

  async function seedPlace(lat: string, lng: string) {
    const [row] = await db
      .insert(schema.places)
      .values({
        source: "overture",
        sourceId: `ovt-${uniq()}`,
        name: `Place ${uniq()}`,
        lat,
        lng,
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  async function seedItem(
    tripId: string,
    input: {
      day: string;
      sortOrder: number;
      endDay?: string;
      placeId?: string;
      bookingId?: string;
      kind?: "custom" | "place_visit" | "booking";
    },
  ) {
    const kind =
      input.kind ?? (input.bookingId ? "booking" : input.placeId ? "place_visit" : "custom");
    const [row] = await db
      .insert(schema.itineraryItems)
      .values({
        tripId,
        kind,
        bookingId: input.bookingId ?? null,
        placeId: kind === "booking" ? null : (input.placeId ?? null),
        title: kind === "custom" ? `Custom ${uniq()}` : null,
        day: input.day,
        endDay: input.endDay ?? null,
        sortOrder: input.sortOrder,
        createdBy: userId,
        updatedAt: PAST,
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  async function seedBooking(tripId: string, placeId: string | null) {
    const [row] = await db
      .insert(schema.bookings)
      .values({
        tripId,
        category: "activity",
        status: "planned",
        title: `Booking ${uniq()}`,
        details: { category: "activity" },
        placeId,
        createdBy: userId,
        updatedAt: PAST,
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  const legsOf = (tripId: string) =>
    db
      .select()
      .from(schema.travelLegs)
      .where(eq(schema.travelLegs.tripId, tripId))
      .orderBy(
        asc(schema.travelLegs.fromItemId),
        asc(schema.travelLegs.toItemId),
        asc(schema.travelLegs.mode),
      );

  const legKeys = async (tripId: string) =>
    (await legsOf(tripId)).map((l) => `${l.fromItemId}|${l.toItemId}|${l.mode}`).sort();

  function buildRecomputer(overrides?: {
    ports?: RoutingPort[];
    ttlMs?: number;
    providerTimeoutMs?: number;
    scheduler?: TravelLegScheduler;
    logger?: { warn(m: string): void };
  }) {
    const mapbox = fakePort("mapbox", ["driving", "walking", "cycling"]);
    const transitous = fakePort("transitous", ["transit"]);
    const recompute = createLegRecomputer({
      db,
      ports: overrides?.ports ?? [mapbox.port, transitous.port],
      ...(overrides?.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
      ...(overrides?.providerTimeoutMs !== undefined
        ? { providerTimeoutMs: overrides.providerTimeoutMs }
        : {}),
      ...(overrides?.scheduler ? { scheduler: overrides.scheduler } : {}),
      logger: overrides?.logger ?? { warn: () => undefined },
    });
    return { recompute, mapbox, transitous };
  }

  // ---- adjacency (§3.5 step 2, R-ib-20/22) ---------------------------------

  it("computes 4 modes per adjacent located pair, connecting across unlocated items", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    const a = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048 }); // unlocated custom
    const c = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 3072, placeId: p2.id });

    const { recompute, mapbox, transitous } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });

    const legs = await legsOf(trip.id);
    expect(legs).toHaveLength(4);
    for (const leg of legs) {
      expect(leg.fromItemId).toBe(a.id);
      expect(leg.toItemId).toBe(c.id);
      expect(leg.tripId).toBe(trip.id);
      expect(leg.durationSeconds).toBe(600);
      expect(leg.distanceMeters).toBe(1000);
      expect(leg.computedAt).toBeInstanceOf(Date);
    }
    expect(legs.map((l) => l.mode).sort()).toEqual(["cycling", "driving", "transit", "walking"]);
    expect(legs.filter((l) => l.mode === "transit").every((l) => l.provider === "transitous")).toBe(
      true,
    );
    expect(legs.filter((l) => l.mode !== "transit").every((l) => l.provider === "mapbox")).toBe(
      true,
    );
    // 1 pair × (3 mapbox + 1 transitous) calls — and coordinates flowed through.
    expect(mapbox.calls).toHaveLength(3);
    expect(transitous.calls).toHaveLength(1);
    expect(mapbox.calls[0]?.from.lat).toBeCloseTo(35.6895);
  });

  it("same-place pairs get zero legs per mode with NO provider call (§3.5 step 2)", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p1.id });

    const { recompute, mapbox, transitous } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });

    const legs = await legsOf(trip.id);
    expect(legs).toHaveLength(4);
    for (const leg of legs) {
      expect(leg.durationSeconds).toBe(0);
      expect(leg.distanceMeters).toBe(0);
      expect(leg.provider).toBe(SAME_PLACE_PROVIDER);
    }
    expect(mapbox.calls).toHaveLength(0);
    expect(transitous.calls).toHaveLength(0);
  });

  it("booking-kind items locate via the PARENT booking's place (R-ib-20 precedence)", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    const locatedBooking = await seedBooking(trip.id, p1.id);
    const placelessBooking = await seedBooking(trip.id, null);
    const bItem = await seedItem(trip.id, {
      day: "2026-09-03",
      sortOrder: 1024,
      bookingId: locatedBooking.id,
    });
    // Placeless booking's item is unlocated — transparent in the chain.
    await seedItem(trip.id, { day: "2026-09-03", sortOrder: 2048, bookingId: placelessBooking.id });
    const visit = await seedItem(trip.id, { day: "2026-09-03", sortOrder: 3072, placeId: p2.id });

    const { recompute } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-03"] });

    const legs = await legsOf(trip.id);
    expect(legs).toHaveLength(4);
    expect(legs.every((l) => l.fromItemId === bItem.id && l.toItemId === visit.id)).toBe(true);
  });

  it("a spanning item participates in BOTH chain days; one row per (pair, mode) (§3.6/R-ib-22)", async () => {
    const trip = await seedTrip();
    const hotel = await seedPlace("35.689500", "139.691700");
    const cafe = await seedPlace("35.659500", "139.700500");
    const bar = await seedPlace("35.669500", "139.710500");
    const lodgingBooking = await seedBooking(trip.id, hotel.id);
    const lodging = await seedItem(trip.id, {
      day: "2026-09-04",
      endDay: "2026-09-06",
      sortOrder: 1024,
      bookingId: lodgingBooking.id,
    });
    const d1Cafe = await seedItem(trip.id, {
      day: "2026-09-04",
      sortOrder: 2048,
      placeId: cafe.id,
    });
    const d3Bar = await seedItem(trip.id, { day: "2026-09-06", sortOrder: 2048, placeId: bar.id });
    // The in-between day holds no chain membership for the spanning item.
    const d2Solo = await seedItem(trip.id, {
      day: "2026-09-05",
      sortOrder: 1024,
      placeId: cafe.id,
    });

    const { recompute } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-04", "2026-09-05", "2026-09-06"] });

    const keys = await legKeys(trip.id);
    const expectPair = (from: string, to: string) =>
      ["cycling", "driving", "transit", "walking"].map((m) => `${from}|${to}|${m}`);
    expect(keys).toEqual(
      [
        ...expectPair(lodging.id, d1Cafe.id), // check-in day chain
        ...expectPair(lodging.id, d3Bar.id), // check-out day chain
      ].sort(),
    );
    // d2 has ONE located item (solo) — no pairs; the spanning item is NOT in d2's chain.
    expect(keys.some((k) => k.includes(d2Solo.id))).toBe(false);
  });

  // ---- diffing (§3.5 step 4) -----------------------------------------------

  it("unchanged fresh pairs are NOT re-called; touched endpoints and TTL expiry are", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    const a = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    const { recompute, mapbox, transitous } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(mapbox.calls).toHaveLength(3);

    // Re-run, nothing changed: reuse — zero new provider calls, rows stable.
    const before = await legsOf(trip.id);
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(mapbox.calls).toHaveLength(3);
    expect(transitous.calls).toHaveLength(1);
    expect(await legsOf(trip.id)).toEqual(before);

    // Touch an endpoint (explicit future stamp — the conservative changedAt
    // rule): every mode of the touched pair is re-called.
    await db
      .update(schema.itineraryItems)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.itineraryItems.id, a.id));
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(mapbox.calls).toHaveLength(6);
    expect(transitous.calls).toHaveLength(2);
  });

  it("rows past the TTL are re-called even with untouched endpoints (R-ib-23 one-rule)", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    const { recompute, mapbox } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(mapbox.calls).toHaveLength(3);

    // Age every row past the 24 h TTL (test-staged staleness).
    await db
      .update(schema.travelLegs)
      .set({ computedAt: new Date(Date.now() - 25 * HOUR_MS) })
      .where(eq(schema.travelLegs.tripId, trip.id));
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(mapbox.calls).toHaveLength(6);
    const refreshed = await legsOf(trip.id);
    expect(refreshed.every((l) => Date.now() - l.computedAt.getTime() < HOUR_MS)).toBe(true);
  });

  // ---- cleanup (§3.5 step 4 / R-ib-22) -------------------------------------

  it("reorder: pairs no longer adjacent are deleted, new adjacency is computed", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    const p3 = await seedPlace("35.669500", "139.710500");
    const a = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    const b = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });
    const c = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 3072, placeId: p3.id });

    const { recompute } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect((await legKeys(trip.id)).filter((k) => k.endsWith("driving"))).toEqual(
      [`${a.id}|${b.id}|driving`, `${b.id}|${c.id}|driving`].sort(),
    );

    // Drag B behind C: A → C → B (stamped as changed — a real reorder does).
    await db
      .update(schema.itineraryItems)
      .set({ sortOrder: 4096, updatedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.itineraryItems.id, b.id));
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });

    expect((await legKeys(trip.id)).filter((k) => k.endsWith("driving"))).toEqual(
      [`${a.id}|${c.id}|driving`, `${c.id}|${b.id}|driving`].sort(),
    );
  });

  it("cross-day move: the orphaned cross-day pair is deleted when both days recompute", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    const a = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    const x = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    const { recompute } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(await legsOf(trip.id)).toHaveLength(4);

    // Move X to another day (mutations mark BOTH days — the dirty-days contract).
    await db
      .update(schema.itineraryItems)
      .set({ day: "2026-09-03", updatedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.itineraryItems.id, x.id));
    await recompute({ tripId: trip.id, days: ["2026-09-02", "2026-09-03"] });

    // A alone on d1, X alone on d2 — no pairs anywhere; stale (a→x) purged.
    expect(await legsOf(trip.id)).toHaveLength(0);
    expect(a.id).toBeTruthy();
  });

  it("prune protects legs that co-chain on a day OUTSIDE the batch (spanning lodging)", async () => {
    const trip = await seedTrip();
    const hotel = await seedPlace("35.689500", "139.691700");
    const cafe = await seedPlace("35.659500", "139.700500");
    const bar = await seedPlace("35.669500", "139.710500");
    const lodgingBooking = await seedBooking(trip.id, hotel.id);
    const lodging = await seedItem(trip.id, {
      day: "2026-09-04",
      endDay: "2026-09-06",
      sortOrder: 1024,
      bookingId: lodgingBooking.id,
    });
    const d1Cafe = await seedItem(trip.id, {
      day: "2026-09-04",
      sortOrder: 2048,
      placeId: cafe.id,
    });
    const d3Bar = await seedItem(trip.id, { day: "2026-09-06", sortOrder: 2048, placeId: bar.id });

    const { recompute } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-04", "2026-09-06"] });
    expect(await legsOf(trip.id)).toHaveLength(8);

    // Recompute ONLY the check-out day after removing its located item: the
    // check-IN day's legs must survive (co-chain {d1} ⊄ batch {d3}).
    await db.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, d3Bar.id));
    await recompute({ tripId: trip.id, days: ["2026-09-06"] });

    const keys = await legKeys(trip.id);
    expect(keys).toHaveLength(4);
    expect(keys.every((k) => k.startsWith(`${lodging.id}|${d1Cafe.id}|`))).toBe(true);
  });

  // ---- degradation (§3.5 step 5, R-ib-19/21) -------------------------------

  it("transit outage: mapbox rows land, transit rows are simply ABSENT — no error", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    const failingTransit = fakePort("transitous", ["transit"], () =>
      Promise.reject(new Error("ECONNREFUSED api.transitous.org")),
    );
    const mapbox = fakePort("mapbox", ["driving", "walking", "cycling"]);
    const warnings: string[] = [];
    const { recompute } = buildRecomputer({
      ports: [mapbox.port, failingTransit.port],
      logger: { warn: (m) => void warnings.push(m) },
    });

    await expect(recompute({ tripId: trip.id, days: ["2026-09-02"] })).resolves.toBeUndefined();
    const legs = await legsOf(trip.id);
    expect(legs).toHaveLength(3);
    expect(legs.every((l) => l.mode !== "transit")).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("no Mapbox port (token unconfigured): only transit rows; nothing errors", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    const transitous = fakePort("transitous", ["transit"]);
    const { recompute } = buildRecomputer({ ports: [transitous.port] });
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });

    const legs = await legsOf(trip.id);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.mode).toBe("transit");
  });

  it("provider FAILURE keeps existing rows (offline ETAs); definitive NO-ROUTE deletes them", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    const a = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    const { recompute } = buildRecomputer();
    await recompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(await legsOf(trip.id)).toHaveLength(4);

    // Touch an endpoint so reuse can't shortcut, then fail EVERYTHING:
    // stale-but-present beats absent (§3.5 step 5) — rows retained.
    await db
      .update(schema.itineraryItems)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.itineraryItems.id, a.id));
    const outage = fakePort("mapbox", ["driving", "walking", "cycling"], () =>
      Promise.reject(new Error("outage")),
    );
    const transitOutage = fakePort("transitous", ["transit"], () =>
      Promise.reject(new Error("outage")),
    );
    const { recompute: failingRecompute } = buildRecomputer({
      ports: [outage.port, transitOutage.port],
    });
    await failingRecompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(await legsOf(trip.id)).toHaveLength(4);

    // Definitive no-route answers delete the now-unroutable rows (R-ib-21).
    const noRoute = fakePort("mapbox", ["driving", "walking", "cycling"], () =>
      Promise.resolve(null),
    );
    const transitNoRoute = fakePort("transitous", ["transit"], () => Promise.resolve(null));
    const { recompute: noRouteRecompute } = buildRecomputer({
      ports: [noRoute.port, transitNoRoute.port],
    });
    await noRouteRecompute({ tripId: trip.id, days: ["2026-09-02"] });
    expect(await legsOf(trip.id)).toHaveLength(0);
  });

  it("a HUNG provider is bounded by the deterministic timeout race — the batch completes", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    let hangs = 0;
    const hungMapbox = fakePort("mapbox", ["driving", "walking", "cycling"], () => {
      hangs += 1;
      return new Promise<never>(() => undefined); // never settles
    });
    const transitous = fakePort("transitous", ["transit"]);
    const fake = fakeScheduler();
    const warnings: string[] = [];
    const { recompute } = buildRecomputer({
      ports: [hungMapbox.port, transitous.port],
      scheduler: fake.scheduler,
      logger: { warn: (m) => void warnings.push(m) },
    });

    const run = recompute({ tripId: trip.id, days: ["2026-09-02"] });
    // Drive each hung call's timeout as it is scheduled (no real sleeps).
    while (hangs < 3 || fake.count > 0) {
      fake.fireAll();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run; // completes despite three eternal hangs

    const legs = await legsOf(trip.id);
    expect(legs).toHaveLength(1); // transit survived the mapbox wedge
    expect(legs[0]?.mode).toBe("transit");
    expect(warnings.some((m) => m.includes("timed out"))).toBe(true);
  });

  // ---- item-deletion race (T-7.1 handoff) ----------------------------------

  it("an item deleted mid-recompute fires the legs FK and the batch is DROPPED quietly", async () => {
    const trip = await seedTrip();
    const p1 = await seedPlace("35.689500", "139.691700");
    const p2 = await seedPlace("35.659500", "139.700500");
    await seedItem(trip.id, { day: "2026-09-02", sortOrder: 1024, placeId: p1.id });
    const victim = await seedItem(trip.id, { day: "2026-09-02", sortOrder: 2048, placeId: p2.id });

    // The provider deletes the pair's to-item DURING the provider phase —
    // after the read phase, before the write transaction.
    const racingMapbox = fakePort("mapbox", ["driving"], async () => {
      await db.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, victim.id));
      return { durationSeconds: 600, distanceMeters: 1000 };
    });
    const warnings: string[] = [];
    const { recompute } = buildRecomputer({
      ports: [racingMapbox.port],
      logger: { warn: (m) => void warnings.push(m) },
    });

    await expect(recompute({ tripId: trip.id, days: ["2026-09-02"] })).resolves.toBeUndefined();
    expect(await legsOf(trip.id)).toHaveLength(0);
    expect(warnings.some((m) => m.includes("FK race"))).toBe(true);
  });

  it("isTravelLegFkViolation pins BOTH driver shapes (postgres-js vs pg-protocol)", () => {
    const pgJs = Object.assign(new Error("violates fk"), {
      code: "23503",
      constraint_name: "travel_legs_to_item_id_itinerary_items_id_fk",
    });
    const pgProtocol = Object.assign(new Error("violates fk"), {
      code: "23503",
      constraint: "travel_legs_from_item_id_itinerary_items_id_fk",
    });
    const wrapped = new Error("tx failed", { cause: pgProtocol });
    const foreign = Object.assign(new Error("violates fk"), {
      code: "23503",
      constraint_name: "bookings_place_id_places_id_fk",
    });
    expect(isTravelLegFkViolation(pgJs)).toBe(true);
    expect(isTravelLegFkViolation(pgProtocol)).toBe(true);
    expect(isTravelLegFkViolation(wrapped)).toBe(true);
    expect(isTravelLegFkViolation(foreign)).toBe(false);
    expect(isTravelLegFkViolation(new Error("plain"))).toBe(false);
  });

  // ---- staleness sweep (R-ib-23) -------------------------------------------

  it("sweep marks stale legs' days for active / starting-soon trips only", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const shift = (days: number) => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };

    async function seedTripWithStaleLeg(dates: { start: string; end: string }) {
      const trip = await seedTrip(dates);
      const p1 = await seedPlace("35.689500", "139.691700");
      const p2 = await seedPlace("35.659500", "139.700500");
      const a = await seedItem(trip.id, { day: dates.start, sortOrder: 1024, placeId: p1.id });
      const b = await seedItem(trip.id, { day: dates.start, sortOrder: 2048, placeId: p2.id });
      await db.insert(schema.travelLegs).values({
        tripId: trip.id,
        fromItemId: a.id,
        toItemId: b.id,
        mode: "driving",
        durationSeconds: 600,
        distanceMeters: 1000,
        provider: "mapbox",
        computedAt: new Date(Date.now() - 25 * HOUR_MS), // past the 24 h TTL
      });
      return trip;
    }

    const activeTrip = await seedTripWithStaleLeg({ start: shift(-2), end: shift(5) });
    const soonTrip = await seedTripWithStaleLeg({ start: shift(3), end: shift(9) });
    const farTrip = await seedTripWithStaleLeg({ start: shift(30), end: shift(40) });
    const pastTrip = await seedTripWithStaleLeg({ start: shift(-20), end: shift(-10) });

    const marked: DirtyDayMark[] = [];
    const result = await sweepStaleLegs({
      db,
      marker: { markDaysDirty: (marks) => void marked.push(...marks) },
    });

    const markedTrips = new Set(marked.map((m) => m.tripId));
    expect(markedTrips.has(activeTrip.id)).toBe(true);
    expect(markedTrips.has(soonTrip.id)).toBe(true);
    expect(markedTrips.has(farTrip.id)).toBe(false);
    expect(markedTrips.has(pastTrip.id)).toBe(false);
    expect(marked.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.day))).toBe(true);
    expect(result.staleLegs).toBeGreaterThanOrEqual(2);
    expect(result.markedDays).toBe(marked.length);

    // FRESH legs are never swept: refresh the active trip's leg and re-sweep.
    await db
      .update(schema.travelLegs)
      .set({ computedAt: new Date() })
      .where(eq(schema.travelLegs.tripId, activeTrip.id));
    const marked2: DirtyDayMark[] = [];
    await sweepStaleLegs({
      db,
      marker: { markDaysDirty: (marks) => void marked2.push(...marks) },
    });
    expect(new Set(marked2.map((m) => m.tripId)).has(activeTrip.id)).toBe(false);
  });
});
