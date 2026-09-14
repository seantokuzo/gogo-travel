/**
 * E2E fixture cleanup (S-4/T3 — session-door spec §5.4). The ONLY mechanism
 * that reclaims `E2E_DOOR_MAX_FIXTURE_USERS` capacity (R-door-14): the door
 * itself never deletes or resets anything (Sean's no-destructive-reset
 * ruling). Invoked explicitly and manually only — `scripts/e2e-cleanup.mjs`
 * is the operator entry point; nothing calls this per-request, per-run, or
 * on any schedule.
 *
 * Scoping guarantee: every candidate row is selected by `apple_sub LIKE
 * 'e2e:%'` — this is the ENTIRE guarantee against ever touching a real
 * account or a trip with a non-fixture member. A real account's `apple_sub`
 * is an opaque Apple-issued value that can never match this prefix.
 *
 * Ordering (§5.4, review round 2/3 — the naive "call `deleteAccount` for
 * every row, any order" cleanup stalls on exactly the case it exists to
 * fix, since `deleteAccount` throws `OwnerTransferRequiredError` before any
 * write when its caller solely owns a trip with another LIVE member):
 *
 *   1. All-fixture trips first — classify every trip a candidate owns by
 *      whether ALL live members are `e2e:`-prefixed; delete those in-process
 *      via the extracted `deleteTripCore` (never `deleteAccount`, never
 *      HTTP, never a session).
 *   2. Ownerless fixtures — `deleteAccount` for every remaining candidate
 *      who, after step 1, owns no trip at all. Can never hit the owner
 *      guard.
 *   3. Remaining fixture owners — `deleteAccount` for every candidate who
 *      still owns a trip. By construction (step 1 removed every all-fixture
 *      trip) any trip such a user still owns has a live NON-fixture member,
 *      so this throws `OwnerTransferRequiredError` — caught, logged as a
 *      skip (never deleted or reassigned), never retried.
 *   4. Retry pass — steps 1-3 run again once, resolving anything a
 *      concurrent membership change let slip through the first pass's
 *      snapshot.
 *   5. Per-user errors (anything but `OwnerTransferRequiredError`) are
 *      caught and logged; they never abort the run for other users.
 *   6. Exit status — the caller (`scripts/e2e-cleanup.mjs`) exits non-zero
 *      whenever `remainingFixtureCount > 0` after the retry pass, whether
 *      the cause is a logged mixed-membership skip or a transient failure.
 */
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { deleteAccount, OwnerTransferRequiredError } from "../users/account-deletion.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { deleteTripCore } from "../trips/routes.js";

/** `apple_sub` prefix — the entire scoping guarantee (see module header). */
const FIXTURE_PREFIX = "e2e:%";

export interface SkippedOwner {
  userId: string;
  appleSub: string;
  /** Trip ids this fixture solely owns that still carry a live non-fixture member. */
  tripIds: readonly string[];
}

export interface TransientFailure {
  userId: string;
  appleSub: string;
  /** `error.name` only — never `.message` (Law #1 hygiene; mirrors the house pattern). */
  errorName: string;
}

/**
 * Review round 1 correctness finding 3: a step-1 `deleteTripCore` rejection
 * (40P01, a pool blip, …) used to escape uncaught and abort the ENTIRE run —
 * before the retry pass, before any `deleteAccount` call, with no report
 * printed. Isolated per-trip the same way `TransientFailure` isolates a
 * per-user `deleteAccount` rejection. Aggregated across BOTH passes (unlike
 * `skippedOwners`/`transientFailures`, which report only what's STILL
 * failing after the retry): a trip whose explicit `deleteTripCore` call
 * failed but was later reclaimed a different way (e.g. `deleteAccount`'s own
 * sole-owner-trip cascade, once its last non-owner member is gone) is a
 * distinct, worth-surfacing event, not a "resolved, so drop it" case.
 */
export interface TripFailure {
  tripId: string;
  ownerId: string;
  /** `error.name` only — never `.message` (Law #1 hygiene). */
  errorName: string;
}

export interface E2eCleanupReport {
  /** All-fixture trips deleted across every pass (step 1). */
  tripsDeleted: number;
  /** Fixture users removed via `deleteAccount` across every pass (steps 2-3). */
  usersDeleted: number;
  /** Fixture owners left untouched because a trip they own has a live non-fixture member (step 3). */
  skippedOwners: readonly SkippedOwner[];
  /** Any other per-user `deleteAccount` failure (step 5) — never aborts the run. */
  transientFailures: readonly TransientFailure[];
  /** Any per-trip `deleteTripCore` failure (step 1) — never aborts the run. Aggregated across both passes (see `TripFailure` doc). */
  tripFailures: readonly TripFailure[];
  /** Live `e2e:`-prefixed users remaining after the retry pass (step 6). */
  remainingFixtureCount: number;
}

export interface E2eCleanupDeps {
  db: DbClient;
  /** AES-256-GCM key `deleteAccount` uses to decrypt `apple_credentials` — fixture rows never have a real one, so this is never actually exercised; any 32-byte buffer works. */
  appleCredentialsKey: Buffer;
  now?: () => Date;
  /**
   * One line per notable event — defaults to `console.warn` (a maintenance
   * script, not a request handler; the server no-`console.log` rule targets
   * request-path code). May return a `Promise` (review round 1 correctness
   * advisory 7): every call site is `await`ed, so a test can hook a
   * specific line and have its own async side effect (e.g. a DB write)
   * genuinely complete before the cleanup code proceeds — no more relying
   * on an unawaited fire-and-forget promise racing the next query.
   */
  log?: (line: string) => void | Promise<void>;
  /**
   * DI seam (review round 1 correctness finding 3): the trip-delete core
   * step 1 calls — defaults to the real `deleteTripCore`. Lets a test
   * inject a rejecting trip delete without corrupting the DB layer, to pin
   * that the failure is isolated per-trip rather than aborting the run.
   */
  deleteTripCoreFn?: typeof deleteTripCore;
  /**
   * DI seam (review round 1 correctness finding 7): the account-deletion
   * call steps 2-3 make — defaults to the real `deleteAccount`. Lets a test
   * inject a transient (non-`OwnerTransferRequiredError`) failure
   * deterministically, to pin that it lands in `transientFailures` instead
   * of aborting the run.
   */
  deleteAccountFn?: typeof deleteAccount;
}

interface FixtureUserRow {
  userId: string;
  appleSub: string;
}

async function liveFixtureUsers(db: DbClient): Promise<FixtureUserRow[]> {
  const rows = await db
    .select({ userId: schema.users.id, appleSub: schema.users.appleSub })
    .from(schema.users)
    .where(and(like(schema.users.appleSub, FIXTURE_PREFIX), isNull(schema.users.deletedAt)));
  // `appleSub` is non-null by construction of the `LIKE 'e2e:%'` predicate.
  return rows.map((row) => ({ userId: row.userId, appleSub: row.appleSub as string }));
}

/** Trip ids a fixture user owns, restricted to the given candidate set. */
async function ownedTripIdsFor(db: DbClient, ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ tripId: schema.tripMembers.tripId })
    .from(schema.tripMembers)
    .where(and(eq(schema.tripMembers.userId, ownerId), eq(schema.tripMembers.role, "owner")));
  return rows.map((row) => row.tripId);
}

/**
 * Step 1: delete every trip a live fixture user owns whose ENTIRE live
 * membership is also `e2e:`-prefixed. Returns how many trips were deleted
 * and any per-trip failures (review round 1 correctness finding 3 — a
 * rejection here used to escape uncaught and abort the whole run).
 */
async function deleteAllFixtureTrips(
  db: DbClient,
  fixtureUsers: readonly FixtureUserRow[],
  log: (line: string) => void | Promise<void>,
  deleteTripCoreFn: typeof deleteTripCore,
): Promise<{ deletedCount: number; failures: TripFailure[] }> {
  if (fixtureUsers.length === 0) return { deletedCount: 0, failures: [] };
  const fixtureIds = new Set(fixtureUsers.map((u) => u.userId));

  const ownedByFixture = await db
    .select({ tripId: schema.tripMembers.tripId, ownerId: schema.tripMembers.userId })
    .from(schema.tripMembers)
    .innerJoin(
      schema.users,
      and(eq(schema.users.id, schema.tripMembers.userId), isNull(schema.users.deletedAt)),
    )
    .where(and(eq(schema.tripMembers.role, "owner"), like(schema.users.appleSub, FIXTURE_PREFIX)));
  if (ownedByFixture.length === 0) return { deletedCount: 0, failures: [] };

  const candidateTripIds = ownedByFixture.map((row) => row.tripId);
  const allMembers = await db
    .select({
      tripId: schema.tripMembers.tripId,
      userId: schema.tripMembers.userId,
      appleSub: schema.users.appleSub,
    })
    .from(schema.tripMembers)
    .innerJoin(
      schema.users,
      and(eq(schema.users.id, schema.tripMembers.userId), isNull(schema.users.deletedAt)),
    )
    .where(inArray(schema.tripMembers.tripId, candidateTripIds));

  const membersByTrip = new Map<string, { userId: string; appleSub: string | null }[]>();
  for (const member of allMembers) {
    const list = membersByTrip.get(member.tripId) ?? [];
    list.push({ userId: member.userId, appleSub: member.appleSub });
    membersByTrip.set(member.tripId, list);
  }

  // Classification snapshot is now taken — everything from here on is the
  // review round 1 security finding 1 / correctness advisory 4 race window:
  // a real (non-fixture) member could join one of these trips before the
  // fenced delete below re-reads membership. `deleteTripCore`'s
  // `allowedMemberIds` guard closes it authoritatively (re-verified UNDER
  // the fence); this log line is the deterministic hook a test uses to
  // inject exactly that race.
  await log(
    `[e2e-cleanup] classification snapshot taken for ${candidateTripIds.length} candidate trip(s)`,
  );

  let deletedCount = 0;
  const failures: TripFailure[] = [];
  for (const { tripId, ownerId } of ownedByFixture) {
    const members = membersByTrip.get(tripId) ?? [];
    const allFixture = members.every(
      (m) => fixtureIds.has(m.userId) || (m.appleSub?.startsWith("e2e:") ?? false),
    );
    if (!allFixture) continue;

    try {
      // `fixtureIds` is passed as `allowedMemberIds` — makes the
      // "all-fixture" classification above authoritative AT DELETE TIME,
      // not just at snapshot time (review round 1 security finding 1).
      const result = await deleteTripCoreFn(db, tripId, ownerId, fixtureIds);
      if (result.deleted) {
        deletedCount += 1;
        await log(`[e2e-cleanup] deleted all-fixture trip ${tripId} (owner ${ownerId})`);
      } else if (result.memberSnapshot.length > 0) {
        await log(
          `[e2e-cleanup] skip: trip ${tripId} (owner ${ownerId}) gained a non-fixture member ` +
            `after the classification snapshot — left untouched (review round 1 finding 1 guard)`,
        );
      }
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "unknown";
      failures.push({ tripId, ownerId, errorName });
      await log(
        `[e2e-cleanup] transient failure deleting trip ${tripId} (owner ${ownerId}): ${errorName}`,
      );
    }
  }
  return { deletedCount, failures };
}

/** Steps 2 + 3: `deleteAccount` for every remaining live fixture user. Ownerless ones (step 2) always succeed; owners (step 3) throw `OwnerTransferRequiredError` and are recorded as skips, never retried within this pass. */
async function deleteRemainingFixtureUsers(
  deps: Pick<E2eCleanupDeps, "db" | "appleCredentialsKey" | "now" | "deleteAccountFn">,
  fixtureUsers: readonly FixtureUserRow[],
  log: (line: string) => void | Promise<void>,
): Promise<{ deleted: number; skipped: SkippedOwner[]; failures: TransientFailure[] }> {
  const now = deps.now ? deps.now() : new Date();
  const deleteAccountFn = deps.deleteAccountFn ?? deleteAccount;
  let deleted = 0;
  const skipped: SkippedOwner[] = [];
  const failures: TransientFailure[] = [];

  for (const user of fixtureUsers) {
    try {
      const result = await deleteAccountFn(
        { db: deps.db, appleCredentialsKey: deps.appleCredentialsKey },
        user.userId,
        now,
      );
      if (result.status === "deleted") {
        deleted += 1;
        await log(`[e2e-cleanup] deleted fixture user ${user.userId} (${user.appleSub})`);
      }
    } catch (error) {
      if (error instanceof OwnerTransferRequiredError) {
        const tripIds = await ownedTripIdsFor(deps.db, user.userId);
        skipped.push({ userId: user.userId, appleSub: user.appleSub, tripIds });
        await log(
          `[e2e-cleanup] skip: user ${user.userId} (${user.appleSub}) owns trip(s) ` +
            `${tripIds.join(", ")} with a non-fixture member — never deleted or reassigned`,
        );
        continue;
      }
      const errorName = error instanceof Error ? error.name : "unknown";
      failures.push({ userId: user.userId, appleSub: user.appleSub, errorName });
      await log(
        `[e2e-cleanup] transient failure deleting user ${user.userId} (${user.appleSub}): ${errorName}`,
      );
    }
  }

  return { deleted, skipped, failures };
}

/** One full pass of steps 1-3 against whatever `e2e:`-prefixed rows are currently live. */
async function runOnePass(
  deps: E2eCleanupDeps,
  log: (line: string) => void | Promise<void>,
): Promise<{
  tripsDeleted: number;
  usersDeleted: number;
  skipped: SkippedOwner[];
  failures: TransientFailure[];
  tripFailures: TripFailure[];
}> {
  const deleteTripCoreFn = deps.deleteTripCoreFn ?? deleteTripCore;
  const fixtureUsersBeforeTrips = await liveFixtureUsers(deps.db);
  const { deletedCount: tripsDeleted, failures: tripFailures } = await deleteAllFixtureTrips(
    deps.db,
    fixtureUsersBeforeTrips,
    log,
    deleteTripCoreFn,
  );

  // Re-query: step 1 may have freed some fixtures to "ownerless" (step 2)
  // that weren't before, and deleted rows must not be re-targeted.
  const fixtureUsersAfterTrips = await liveFixtureUsers(deps.db);
  const { deleted, skipped, failures } = await deleteRemainingFixtureUsers(
    deps,
    fixtureUsersAfterTrips,
    log,
  );

  return { tripsDeleted, usersDeleted: deleted, skipped, failures, tripFailures };
}

/**
 * Run the full cleanup: one pass, then the retry pass (§5.4 step 4). See the
 * module header for the ordering rationale. Never called by the door, never
 * scheduled — an explicit, operator-invoked, offline maintenance action.
 */
export async function runE2eCleanup(deps: E2eCleanupDeps): Promise<E2eCleanupReport> {
  const log = deps.log ?? ((line: string) => console.warn(line));

  const first = await runOnePass(deps, log);
  const retry = await runOnePass(deps, log);

  const remaining = await liveFixtureUsers(deps.db);

  return {
    tripsDeleted: first.tripsDeleted + retry.tripsDeleted,
    usersDeleted: first.usersDeleted + retry.usersDeleted,
    // `tripFailures` is a HISTORICAL log of what errored, aggregated across
    // both passes — unlike `skippedOwners`/`transientFailures` below, a
    // pass-1 trip failure that a different mechanism (e.g. `deleteAccount`'s
    // own sole-owner-trip cascade) later reclaims is still worth reporting,
    // not silently dropped.
    tripFailures: [...first.tripFailures, ...retry.tripFailures],
    // The retry pass is authoritative for who's STILL skipped/failing — a
    // user the first pass skipped but the retry pass actually deleted must
    // not show up in the final report as skipped.
    skippedOwners: retry.skipped,
    transientFailures: retry.failures,
    remainingFixtureCount: remaining.length,
  };
}
