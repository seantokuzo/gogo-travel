/**
 * S-4/T3 (session-door spec §5.4, R-door-14's cleanup obligation) —
 * `runE2eCleanup` exercised DIRECTLY against a real Postgres, in-process (no
 * HTTP, no session, no session door), the same way `scripts/e2e-cleanup.mjs`
 * calls it.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less CI
 * run is a HARD FAILURE; a local Docker-less run skips with a loud banner.
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { afterEach, describe, expect, inject, it } from "vitest";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";
import { deleteAccount } from "../users/account-deletion.js";
import { runE2eCleanup } from "./cleanup.js";

const dockerAvailable = inject("dbAvailable");
const FROZEN_NOW = new Date("2026-09-13T00:00:00.000Z");
const APPLE_CREDENTIALS_KEY = Buffer.alloc(32, 0);

describe.skipIf(!dockerAvailable)("runE2eCleanup (S-4/T3, integration)", () => {
  let suiteDb: SuiteDb | undefined;
  let db: PostgresJsDatabase<typeof schema>;

  afterEach(async () => {
    await suiteDb?.drop();
    suiteDb = undefined;
  });

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  async function fixtureUser(key: string) {
    const { user } = await createUserWithEntitlements(db, {
      email: `e2e+${key}@gogotravel.invalid`,
      displayName: `E2E ${key}`,
      appleSub: `e2e:${key}`,
    });
    return user;
  }

  async function realUser() {
    const { user } = await createUserWithEntitlements(db, {
      email: `real-${uniq()}@example.com`,
      displayName: "Real User",
      googleSub: `google-${uniq()}`,
    });
    return user;
  }

  async function trip(ownerId: string, name: string) {
    const [row] = await db
      .insert(schema.trips)
      .values({
        name,
        destinationName: "Lisbon, Portugal",
        destinationLat: "38.722252",
        destinationLng: "-9.139337",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        status: "planning",
        createdBy: ownerId,
      })
      .returning();
    if (!row) throw new Error("trip insert returned no row");
    await db.insert(schema.tripMembers).values({ tripId: row.id, userId: ownerId, role: "owner" });
    return row;
  }

  async function addMember(tripId: string, userId: string, role: "editor" | "viewer" = "editor") {
    await db.insert(schema.tripMembers).values({ tripId, userId, role });
  }

  async function liveUserRow(userId: string) {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return row;
  }

  async function tripRow(tripId: string) {
    const [row] = await db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    return row;
  }

  async function cleanup() {
    return runE2eCleanup({ db, appleCredentialsKey: APPLE_CREDENTIALS_KEY, now: () => FROZEN_NOW });
  }

  it(
    "mixed set: removes only e2e:-prefixed rows and their owned trips; a real user's trip is untouched",
    { timeout: 30_000 },
    async () => {
      suiteDb = await createSuiteDb("e2e_cleanup_mixed");
      db = suiteDb.db;

      const fixture = await fixtureUser(`mix-${uniq()}`);
      const real = await realUser();
      const realTrip = await trip(real.id, "Real trip");

      const report = await cleanup();

      // Nit (review round 1 correctness 8): exactly one fixture user exists
      // in this graph — `>=` can't catch an over-delete; assert the exact
      // count.
      expect(report.usersDeleted).toBe(1);
      // Real user + trip survive byte-for-byte.
      expect(await liveUserRow(real.id)).toMatchObject({ id: real.id, deletedAt: null });
      expect(await tripRow(realTrip.id)).toBeDefined();
      // The fixture user is scrubbed (soft-deleted — deleteAccount's contract).
      const fixtureRow = await liveUserRow(fixture.id);
      expect(fixtureRow?.deletedAt).not.toBeNull();
      expect(fixtureRow?.appleSub).toBeNull();
      expect(report.remainingFixtureCount).toBe(0);
    },
  );

  it(
    "mixed-membership skip: a trip with one e2e:-prefixed owner and one real member survives cleanup byte-for-byte; the fixture owner is skipped, not deleted",
    { timeout: 30_000 },
    async () => {
      suiteDb = await createSuiteDb("e2e_cleanup_skip");
      db = suiteDb.db;

      const owner = await fixtureUser(`skip-${uniq()}`);
      const realMember = await realUser();
      const mixedTrip = await trip(owner.id, "Mixed trip");
      await addMember(mixedTrip.id, realMember.id, "editor");

      const report = await cleanup();

      // Falsification: drop the OwnerTransferRequiredError catch in
      // cleanup.ts (call deleteAccount and let it throw uncaught) and this
      // whole run rejects instead of reporting a skip.
      expect(report.skippedOwners).toHaveLength(1);
      expect(report.skippedOwners[0]?.userId).toBe(owner.id);
      expect(report.skippedOwners[0]?.tripIds).toEqual([mixedTrip.id]);
      expect(report.remainingFixtureCount).toBe(1);

      // The trip and BOTH memberships are untouched.
      expect(await tripRow(mixedTrip.id)).toEqual(mixedTrip);
      const members = await db
        .select()
        .from(schema.tripMembers)
        .where(eq(schema.tripMembers.tripId, mixedTrip.id));
      expect(members.map((m) => m.userId).sort()).toEqual([owner.id, realMember.id].sort());
      // The owner itself is untouched (not scrubbed).
      expect(await liveUserRow(owner.id)).toMatchObject({ id: owner.id, deletedAt: null });
    },
  );

  it(
    "multi-fixture-member trip: a 3-way OWNERSHIP CYCLE (A owns A+B, B owns B+C, C owns C+A, all e2e:-prefixed) is fully resolved by step 1's trip-core deletion, independent of any per-user processing order",
    { timeout: 30_000 },
    async () => {
      suiteDb = await createSuiteDb("e2e_cleanup_cycle");
      db = suiteDb.db;

      // A cycle is the deterministic discriminator (order-independent,
      // unlike a simple 2-member trip): calling `deleteAccount` on A, B, or
      // C ALONE — in ANY order, with NO dedicated trip-core-first phase —
      // always finds its own owned trip's OTHER member still live and
      // throws `OwnerTransferRequiredError`, because no actor's deletion
      // ever frees a DIFFERENT actor's distinct owned trip. Only step 1's
      // batch classification (snapshotted before any deletes) resolves it.
      const a = await fixtureUser(`cycle-a-${uniq()}`);
      const b = await fixtureUser(`cycle-b-${uniq()}`);
      const c = await fixtureUser(`cycle-c-${uniq()}`);
      const tripA = await trip(a.id, "Cycle trip A");
      await addMember(tripA.id, b.id, "viewer");
      const tripB = await trip(b.id, "Cycle trip B");
      await addMember(tripB.id, c.id, "viewer");
      const tripC = await trip(c.id, "Cycle trip C");
      await addMember(tripC.id, a.id, "viewer");

      const report = await cleanup();

      // Falsification: make `deleteAllFixtureTrips` a no-op (never call
      // `deleteTripCore`) and this goes RED — EVERY ONE of the three stays
      // blocked with `OwnerTransferRequiredError` no matter how many retry
      // passes run, since no actor's `deleteAccount` call ever frees a
      // DIFFERENT actor's distinct owned trip in a true ownership cycle.
      // (Verified: merely reordering the two steps within one pass does
      // NOT reproduce this — the retry pass papers over a pure reorder,
      // since a blocked `deleteAccount` call is a no-op and step 1 still
      // runs later in the same pass. Only removing step 1 outright
      // deadlocks the cycle for good, which is the actual property this
      // pin exists to guard.)
      expect(report.skippedOwners).toHaveLength(0);
      expect(report.tripsDeleted).toBe(3);
      expect(await tripRow(tripA.id)).toBeUndefined();
      expect(await tripRow(tripB.id)).toBeUndefined();
      expect(await tripRow(tripC.id)).toBeUndefined();
      expect((await liveUserRow(a.id))?.deletedAt).not.toBeNull();
      expect((await liveUserRow(b.id))?.deletedAt).not.toBeNull();
      expect((await liveUserRow(c.id))?.deletedAt).not.toBeNull();
      expect(report.remainingFixtureCount).toBe(0);
    },
  );

  it(
    "retry pass: a fixture owner whose blocking real member is removed DURING pass 1 is freed by pass 2 with no operator action",
    { timeout: 30_000 },
    async () => {
      suiteDb = await createSuiteDb("e2e_cleanup_retry");
      db = suiteDb.db;

      const owner = await fixtureUser(`retry-${uniq()}`);
      const blocker = await realUser();
      const blockedTrip = await trip(owner.id, "Retry trip");
      await addMember(blockedTrip.id, blocker.id, "editor");

      // Simulate a concurrent process resolving the mixed-membership block
      // WHILE cleanup's first pass is running: the moment pass 1 logs the
      // skip for this exact owner, remove the real blocking member — a
      // deterministic stand-in for "a step-1 trip delete (elsewhere) lands
      // in the same window" that doesn't depend on real thread timing.
      //
      // Review round 1 correctness advisory 7: the prior version of this
      // test fired that DELETE unawaited ("fire-and-forget"), justified by
      // a claim that JS single-threadedness alone made it land before pass
      // 2's queries — FALSE: `createSuiteDb` hands back a 5-connection pool,
      // so pass 2's SELECT runs on a DIFFERENT pooled connection, genuinely
      // concurrently with the still-uncommitted DELETE, and could win the
      // race under CI contention (a timing pin that is really a sleep).
      // `log` may now return a `Promise` that `runE2eCleanup` AWAITS
      // between every logged line — this hook uses that to make the DELETE
      // provably COMPLETE before cleanup proceeds, no timing assumption
      // required.
      let resolved = false;
      const report = await runE2eCleanup({
        db,
        appleCredentialsKey: APPLE_CREDENTIALS_KEY,
        now: () => FROZEN_NOW,
        log: async (line) => {
          if (!resolved && line.includes(owner.id) && line.includes("skip:")) {
            resolved = true;
            await db.delete(schema.tripMembers).where(eq(schema.tripMembers.userId, blocker.id));
          }
        },
      });

      // Falsification: delete the retry pass (call `runOnePass` only once
      // in `runE2eCleanup`) and this goes RED — `remainingFixtureCount`
      // stays 1 and `skippedOwners` still lists the owner, since only a
      // SECOND pass re-classifies the now-ownerless-of-real-members trip.
      expect(resolved).toBe(true);
      expect(report.remainingFixtureCount).toBe(0);
      expect(report.skippedOwners).toHaveLength(0);
    },
  );

  it("capacity is actually freed: a fresh count of live e2e:-prefixed users drops to 0 after cleanup of an all-fixture set (not just renamed)", async () => {
    suiteDb = await createSuiteDb("e2e_cleanup_capacity");
    db = suiteDb.db;

    for (let i = 0; i < 3; i++) {
      await fixtureUser(`cap-${uniq()}`);
    }
    const before = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.appleSub, "e2e:nonexistent")); // sanity: query works
    expect(before).toEqual([]);

    const report = await cleanup();
    expect(report.usersDeleted).toBe(3);
    expect(report.remainingFixtureCount).toBe(0);
  });

  it(
    "review round 1 correctness finding 3: a step-1 trip-delete failure is isolated per trip — recorded, the run completes, and steps 2/3 still run",
    { timeout: 30_000 },
    async () => {
      suiteDb = await createSuiteDb("e2e_cleanup_trip_failure");
      db = suiteDb.db;

      const owner = await fixtureUser(`tripfail-${uniq()}`);
      const ownedTrip = await trip(owner.id, "Trip-failure trip");

      const report = await runE2eCleanup({
        db,
        appleCredentialsKey: APPLE_CREDENTIALS_KEY,
        now: () => FROZEN_NOW,
        // DI seam (review round 1 correctness finding 3): always reject
        // step 1's own trip delete for this trip — a stand-in for a 40P01 /
        // pool blip `deleteTripCore` itself can throw.
        deleteTripCoreFn: () =>
          Promise.reject(new Error("simulated transient trip-delete failure")),
      });

      // Falsification: drop the per-trip try/catch in `deleteAllFixtureTrips`
      // (let the throw propagate) and `runE2eCleanup` REJECTS instead of
      // resolving — no report, no retry pass, no `deleteAccount` step ever
      // runs for this owner.
      expect(report.tripFailures).toHaveLength(1); // pass 1 only — see below
      expect(report.tripFailures[0]?.tripId).toBe(ownedTrip.id);
      // Steps 2/3 still ran despite step 1's failure: `deleteAccount`'s OWN
      // internal sole-owner-trip cascade (independent of `deleteTripCore`,
      // never touched by the injected failure) reclaims the owner — and,
      // with it, the trip — in the SAME pass 1, since no other live member
      // blocks it. That's WHY pass 2 never re-attempts the trip delete (the
      // owner is already gone): proof the run proceeded past the isolated
      // step-1 failure into steps 2/3, rather than aborting.
      expect(report.remainingFixtureCount).toBe(0);
      expect(await tripRow(ownedTrip.id)).toBeUndefined();
    },
  );

  it(
    "review round 1 security finding 1 / correctness advisory 4: a real member who joins a trip between the classification snapshot and the fenced delete is not deleted — the trip survives, reported as skipped",
    { timeout: 30_000 },
    async () => {
      suiteDb = await createSuiteDb("e2e_cleanup_late_join");
      db = suiteDb.db;

      const owner = await fixtureUser(`latejoin-${uniq()}`);
      const real = await realUser();
      const mixedTrip = await trip(owner.id, "Late-join trip");

      let joined = false;
      const report = await runE2eCleanup({
        db,
        appleCredentialsKey: APPLE_CREDENTIALS_KEY,
        now: () => FROZEN_NOW,
        log: async (line) => {
          // The trip is all-fixture (owner only) at classification time —
          // this hook fires right after that snapshot, simulating a real
          // user accepting a pending invite in the window before the
          // fenced delete re-reads membership.
          if (!joined && line.includes("classification snapshot taken")) {
            joined = true;
            await db.insert(schema.tripMembers).values({
              tripId: mixedTrip.id,
              userId: real.id,
              role: "editor",
            });
          }
        },
      });

      // Falsification: drop the `allowedMemberIds` fence in `deleteTripCore`
      // (or stop passing `fixtureIds` as it from `deleteAllFixtureTrips`)
      // and this goes RED — the trip gets deleted anyway, taking the real
      // user's membership with it.
      expect(joined).toBe(true);
      expect(await tripRow(mixedTrip.id)).toBeDefined();
      const members = await db
        .select()
        .from(schema.tripMembers)
        .where(eq(schema.tripMembers.tripId, mixedTrip.id));
      expect(members.map((m) => m.userId).sort()).toEqual([owner.id, real.id].sort());
      expect(await liveUserRow(real.id)).toMatchObject({ id: real.id, deletedAt: null });
      // The owner is left live too — it now (correctly) has a live
      // non-fixture member, so step 2/3 skips it via the normal
      // OwnerTransferRequiredError path on a later pass.
      expect(report.remainingFixtureCount).toBe(1);
    },
  );

  it(
    "review round 1 correctness finding 7: a transient (non-OwnerTransferRequiredError) deleteAccount failure is isolated — recorded, the OTHER user still deletes, and the retry pass resolves it",
    { timeout: 30_000 },
    async () => {
      suiteDb = await createSuiteDb("e2e_cleanup_transient_user");
      db = suiteDb.db;

      const flaky = await fixtureUser(`flaky-${uniq()}`);
      const stable = await fixtureUser(`stable-${uniq()}`);

      let failedOnce = false;
      const report = await runE2eCleanup({
        db,
        appleCredentialsKey: APPLE_CREDENTIALS_KEY,
        now: () => FROZEN_NOW,
        // DI seam (review round 1 correctness finding 7): reject exactly
        // ONE user's FIRST `deleteAccount` call with a non-
        // `OwnerTransferRequiredError` — a stand-in for a transient DB
        // error unrelated to trip ownership.
        deleteAccountFn: async (deps, userId, now) => {
          if (userId === flaky.id && !failedOnce) {
            failedOnce = true;
            throw new Error("simulated transient deleteAccount failure");
          }
          return deleteAccount(deps, userId, now);
        },
      });

      // Falsification: drop the non-`OwnerTransferRequiredError` catch in
      // `deleteRemainingFixtureUsers` (let it propagate) and this goes RED
      // — the whole run rejects instead of isolating the one failure.
      expect(failedOnce).toBe(true);
      // The OTHER user was never touched by the injected failure and
      // deleted normally in pass 1.
      expect((await liveUserRow(stable.id))?.deletedAt).not.toBeNull();
      // The retry pass gave the flaky user another swing (the injected
      // failure only fires once) and it succeeded — no leftover, no entry
      // in the FINAL (retry-authoritative) transientFailures list.
      expect(report.transientFailures).toHaveLength(0);
      expect((await liveUserRow(flaky.id))?.deletedAt).not.toBeNull();
      expect(report.remainingFixtureCount).toBe(0);
    },
  );

  it("idempotent: a second cleanup run against an already-clean fixture set changes nothing", async () => {
    suiteDb = await createSuiteDb("e2e_cleanup_idempotent");
    db = suiteDb.db;

    const fixture = await fixtureUser(`idem-${uniq()}`);
    const first = await cleanup();
    expect(first.usersDeleted).toBe(1);
    expect(first.remainingFixtureCount).toBe(0);

    // Falsification: this would go RED if `runE2eCleanup` re-selected
    // already soft-deleted rows (e.g. dropped the `isNull(deletedAt)`
    // filter) or threw on an empty candidate set.
    const second = await cleanup();
    expect(second.tripsDeleted).toBe(0);
    expect(second.usersDeleted).toBe(0);
    expect(second.skippedOwners).toHaveLength(0);
    expect(second.transientFailures).toHaveLength(0);
    expect(second.tripFailures).toHaveLength(0);
    expect(second.remainingFixtureCount).toBe(0);
    expect((await liveUserRow(fixture.id))?.deletedAt).not.toBeNull();
  });
});
