/**
 * B-7 part 3 migration suite: `drizzle/0005_nullable_custom_coords.sql`.
 *
 * Two things a route-level test can't prove on its own:
 *  1. The migrated SCHEMA actually carries the four nullable columns and the
 *     three new CHECK constraints (the "pristine clone carries the
 *     migrations through 0005" pin — the `fresh-install.db.test.ts`
 *     precedent for "through 0003").
 *  2. The BACKFILL statements are scoped EXACTLY to `(0,0)` custom rows /
 *     `(0,0)` trips, and touch nothing else — read straight out of the
 *     shipped SQL file (not a hand-copied re-implementation) so an edit to
 *     the migration's WHERE clause reds this test, not just a code review.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres (PG 18 —
 * `test/global-setup.ts`); the shared template is migrated 0000→0005 ONCE
 * per vitest process, so any suite booting via `createSuiteDb` is itself
 * live proof the full chain applies cleanly on a fresh container — this
 * file additionally asserts what that migration left behind.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createUserWithEntitlements } from "./db/create-user.js";
import { isCheckViolationOf } from "./db/pg-errors.js";
import * as schema from "./db/schema/index.js";
import { createSuiteDb, type SuiteDb } from "./test/suite-db.js";

const dockerAvailable = inject("dbAvailable");
const BOOT_TIMEOUT_MS = 240_000;

/** The shipped migration file, read fresh at test time — never re-typed. */
const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("../drizzle/0005_nullable_custom_coords.sql", import.meta.url)),
  "utf8",
);

/** Every statement in the file, in order — the same split drizzle-kit uses. */
function migrationStatements(): string[] {
  return MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Strip `-- ...` line comments — statements carry reviewer-facing prose above the SQL. */
function stripLineComments(statement: string): string {
  return statement
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

describe.skipIf(!dockerAvailable)("B-7 part 3 migration 0005 (integration)", () => {
  let suiteDb: SuiteDb;
  let db: PostgresJsDatabase<typeof schema>;
  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    suiteDb = await createSuiteDb("migration_nullable_coords");
    db = suiteDb.db;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  it("the migration file itself is shaped as expected: DROP NOT NULL x4, two backfill UPDATEs, three ADD CONSTRAINTs", () => {
    // A cheap structural sanity check BEFORE the behavioral pins below run
    // extracted statements against a live DB — if this reds, the extraction
    // logic below is reading the wrong thing entirely.
    const statements = migrationStatements().map(stripLineComments);
    const dropNotNull = statements.filter((s) => /ALTER COLUMN .* DROP NOT NULL/.test(s));
    const updates = statements.filter((s) => /^UPDATE /i.test(s));
    const addConstraints = statements.filter((s) => /ADD CONSTRAINT/.test(s));
    expect(dropNotNull).toHaveLength(4);
    expect(updates).toHaveLength(2);
    expect(addConstraints).toHaveLength(3);
  });

  it("pristine clone carries the migrations THROUGH 0005: places/trips coordinate columns are nullable, all three B-7 part 3 CHECK constraints exist", async () => {
    const [placesCols, tripsCols] = await Promise.all([
      suiteDb.client<{ column_name: string; is_nullable: string }[]>`
        select column_name, is_nullable from information_schema.columns
        where table_name = 'places' and column_name in ('lat', 'lng')
      `,
      suiteDb.client<{ column_name: string; is_nullable: string }[]>`
        select column_name, is_nullable from information_schema.columns
        where table_name = 'trips' and column_name in ('destination_lat', 'destination_lng')
      `,
    ]);
    for (const row of [...placesCols, ...tripsCols]) {
      expect(row.is_nullable).toBe("YES");
    }
    expect(placesCols).toHaveLength(2);
    expect(tripsCols).toHaveLength(2);

    const constraints = await suiteDb.client<{ conname: string }[]>`
      select conname from pg_constraint
      where conname in (
        'places_coords_pair_ck', 'places_spine_coords_ck', 'trips_destination_coords_pair_ck'
      )
    `;
    expect(new Set(constraints.map((c) => c.conname))).toEqual(
      new Set([
        "places_coords_pair_ck",
        "places_spine_coords_ck",
        "trips_destination_coords_pair_ck",
      ]),
    );
    // Falsification (round-1 fix — the TS-schema half of the original note
    // was INERT, verified: 4/4 GREEN after deleting a CHECK from
    // db/schema/{places,trips}.ts): this suite's shared template DB is built
    // by replaying `drizzle/*.sql` (`test/global-setup.ts`'s `migrate()`) —
    // it never reads the TS schema file at all, so editing a `check(...)`
    // call there has ZERO effect on what a test container enforces. The
    // ONLY real falsification is the shipped migration file itself: comment
    // out (or delete) any one `ADD CONSTRAINT` in
    // `drizzle/0005_nullable_custom_coords.sql` — this reds on the missing
    // name. (The TS `check(...)` calls still matter — `drizzle-kit generate`
    // diffs against them for the NEXT migration — the drift pin below is
    // what actually exercises that half.)
  });

  it("[B-7 part 3 R1] drift pin: every CHECK constraint db/schema/{places,trips}.ts declares matches what the shipped migrations actually created", async () => {
    // The pin above hardcodes the three B-7 names and only reads the LIVE
    // db — it can't catch a TS `check(...)` renamed/added/removed without a
    // matching migration edit (or the reverse). This pin reads BOTH sides:
    // the TS schema source (static, for the declared names) and
    // `pg_constraint` (live, for what actually shipped) and requires the
    // sets to match exactly, closing the "Drizzle drift-check gate" QUEUE
    // row this cheaply.
    const CHECK_NAME_RE = /check\(\s*"([a-z0-9_]+)"/g;
    const declared = new Set<string>();
    for (const file of ["schema/places.ts", "schema/trips.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`./db/${file}`, import.meta.url)), "utf8");
      for (const match of source.matchAll(CHECK_NAME_RE)) declared.add(match[1]!);
    }
    expect(declared.size).toBeGreaterThanOrEqual(3); // sanity: the regex found something

    // `trips.ts` also defines `trip_members` and `invites` in the same
    // file — the regex above picks up `invites`' two checks along with
    // `trips`', so the live side must query all three tables (`trip_members`
    // declares none).
    const live = await suiteDb.client<{ conname: string }[]>`
      select conname from pg_constraint
      where contype = 'c'
        and conrelid in ('places'::regclass, 'trips'::regclass, 'invites'::regclass)
    `;
    expect(new Set(live.map((c) => c.conname))).toEqual(declared);
    // Falsification: add a `check(...)` to db/schema/places.ts (or trips.ts)
    // with no matching migration — declared grows, live doesn't, reds. Or
    // rename one shipped migration's constraint without updating the TS
    // `check(...)` call — same divergence, opposite direction.
  });

  it("[THE BACKFILL PIN] the shipped UPDATE statements convert exactly the (0,0) custom-place and (0,0) trip rows, nothing else", async () => {
    // Seed the exact scenario the spec names, against the ALREADY-migrated
    // schema (nullable columns + CHECKs already exist — an explicit (0,0) on
    // a custom place is legal forever, per the migration's own header note).
    const owner = (
      await createUserWithEntitlements(db, {
        email: `migration-probe-${uniq()}@example.com`,
        displayName: "Migration Probe",
        googleSub: `google-${uniq()}`,
      })
    ).user;

    const [customAtOrigin] = await db
      .insert(schema.places)
      .values({
        source: "custom",
        name: "a: custom at (0,0)",
        lat: "0",
        lng: "0",
        createdBy: owner.id,
      })
      .returning();
    const [customElsewhere] = await db
      .insert(schema.places)
      .values({
        source: "custom",
        name: "b: custom at (0, 12.5)",
        lat: "0",
        lng: "12.5",
        createdBy: owner.id,
      })
      .returning();
    const [spineAtOrigin] = await db
      .insert(schema.places)
      .values({
        source: "overture",
        sourceId: `probe-origin-${uniq()}`,
        name: "c: overture at (0,0)",
        lat: "0",
        lng: "0",
      })
      .returning();
    const [tripAtOrigin] = await db
      .insert(schema.trips)
      .values({
        name: "d: trip at (0,0)",
        destinationName: "Origin",
        destinationLat: "0",
        destinationLng: "0",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        createdBy: owner.id,
      })
      .returning();
    const [tripElsewhere] = await db
      .insert(schema.trips)
      .values({
        name: "e: trip at (35.6, 139.6)",
        destinationName: "Tokyo",
        destinationLat: "35.6",
        destinationLng: "139.6",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        createdBy: owner.id,
      })
      .returning();
    expect(
      customAtOrigin && customElsewhere && spineAtOrigin && tripAtOrigin && tripElsewhere,
    ).toBeTruthy();

    // Execute ONLY the UPDATE statements read out of the shipped file — the
    // ALTER/ADD CONSTRAINT statements already applied when the template was
    // built, so re-running them here would just fail as duplicates.
    const updates = migrationStatements()
      .map(stripLineComments)
      .filter((s) => /^UPDATE /i.test(s));
    expect(updates).toHaveLength(2);
    for (const statement of updates) {
      await suiteDb.client.unsafe(statement);
    }

    const [reReadCustomOrigin] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, customAtOrigin!.id));
    const [reReadCustomElsewhere] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, customElsewhere!.id));
    const [reReadSpineOrigin] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, spineAtOrigin!.id));
    const [reReadTripOrigin] = await db
      .select()
      .from(schema.trips)
      .where(eq(schema.trips.id, tripAtOrigin!.id));
    const [reReadTripElsewhere] = await db
      .select()
      .from(schema.trips)
      .where(eq(schema.trips.id, tripElsewhere!.id));

    // (a) and (d): backfilled to NULL.
    expect(reReadCustomOrigin?.lat).toBeNull();
    expect(reReadCustomOrigin?.lng).toBeNull();
    expect(reReadTripOrigin?.destinationLat).toBeNull();
    expect(reReadTripOrigin?.destinationLng).toBeNull();
    // (b), (c), (e): untouched.
    expect(reReadCustomElsewhere?.lat).toBe("0.000000");
    expect(reReadCustomElsewhere?.lng).toBe("12.500000");
    expect(reReadSpineOrigin?.lat).toBe("0.000000");
    expect(reReadSpineOrigin?.lng).toBe("0.000000");
    expect(reReadTripElsewhere?.destinationLat).toBe("35.600000");
    expect(reReadTripElsewhere?.destinationLng).toBe("139.600000");
    // Falsification: change `AND lat = 0 AND lng = 0` to `OR` (or drop the
    // `source = 'custom'` guard) in the shipped migration file — (b) and/or
    // (c) get wrongly nulled and this reds. This test reads the FILE, so
    // the falsification is a one-line edit to the shipped SQL, not to this
    // test.
  });

  it("DB CHECK: trips_destination_coords_pair_ck rejects a half-null destination pair (23514) — mirrors the places-side pins", async () => {
    const owner = (
      await createUserWithEntitlements(db, {
        email: `migration-check-${uniq()}@example.com`,
        displayName: "Migration Check Probe",
        googleSub: `google-${uniq()}`,
      })
    ).user;
    await expect(
      db.insert(schema.trips).values({
        name: "half pair",
        destinationName: "Nowhere",
        destinationLat: null,
        destinationLng: "12.5",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        createdBy: owner.id,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolationOf(err, "trips_destination_coords_pair_ck"),
    );
  });
});
