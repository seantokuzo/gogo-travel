/**
 * Trip CRUD routes (T-6.1 / API-TRIPS-1): `POST /trips`, `GET /trips`,
 * `GET|PATCH|DELETE /trips/:tripId` — trips spec §3.3, wire shapes from
 * `@gogo/shared/domains/trip` only. Covers R-trips-1..8, 19, 20, 22.
 *
 * AUTHZ POSTURE: runs behind the app-wide `requireAuth` (R-authz-1). Every
 * `/:tripId` route sits behind `requireTripMember` — role resolved ONCE per
 * request (R-trips-1); a non-member's 404 is byte-identical to an absent
 * trip's (IDOR posture, §1 membership gate; the F-038 harness proves it).
 * The route-level minimum role only TIGHTENS per §3.2: reads `viewer`,
 * PATCH `editor` (no field is viewer-writable), DELETE `owner`. Owner-only
 * FIELDS on PATCH (`base_currency`, `status`) are asserted in-handler
 * (R-trips-20). Deliberately NO param zValidator on `:tripId`: the gate
 * already folds malformed ids into the same indistinguishable 404 — a 400
 * would add a distinguishable door.
 *
 * CONCURRENCY: row-grain LWW (§3.5 rule 1); optional `expect_updated_at`
 * precondition rides inside the guarded UPDATE (http/expect-updated-at.ts,
 * R-trips-6). Multi-row writes (trip + owner member on create, trip +
 * budgets on base-currency change) are REAL transactions — the prod driver
 * is the Neon WebSocket Pool, never Neon-HTTP (landmine #1). A PATCH
 * touching `base_currency` takes the trip row FOR UPDATE (T-9.2 rider —
 * closes the T-6.1 base-currency TOCTOU against racing first-expense
 * inserts, which take the same lock; expenses/service.ts module doc owns
 * the lock-order story).
 *
 * PUSH INVALIDATION (T-6.3, §3.5 rule 6 / R-trips-18): every committed
 * mutation emits its §3.5 event post-commit via the `tripEvents` seam
 * (push-invalidation.ts) — trip.updated on PATCH writes, trip.status_changed
 * whenever the STORED status moves (manual override or derived
 * reconciliation, §3.4 — including the read-path self-heal), trip.deleted on
 * DELETE with the fence transaction's pre-delete member snapshot (R-trips-8:
 * "captured before the delete"). Hooks fire only after the transaction (or
 * auto-commit statement) succeeds — an aborted/zero-row write never emits.
 * POST /trips emits nothing: §3.5 has no trip.created (the creator is the
 * sole member; there is no one to invalidate).
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { tripEndpoints, type Trip, type TripListItem } from "@gogo/shared/domains/trip";
import type { Paginated } from "@gogo/shared/api/envelope";
import { TRIPS_PAGE_SIZE_DEFAULT } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import {
  apiError,
  HttpError,
  NOT_FOUND_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
  type RequestVars,
} from "../http/errors.js";
import {
  expectUpdatedAtPrecondition,
  throwGuardedUpdateMiss,
} from "../http/expect-updated-at.js";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  epochMicrosExpr,
  keysetCursorPredicate,
} from "../http/keyset-cursor.js";
import type { RateLimitStore } from "../http/rate-limit.js";
import { authContextOf } from "../http/require-auth.js";
import { createRequireTripMember, tripContextOf } from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import type { PlacesIngestTrigger } from "../places/ingest-queue.js";
import { emitTripEvent, type TripEventEmitter } from "./push-invalidation.js";
import { effectiveTripStatus, reconcileStoredStatuses, todayUtc } from "./status.js";
import { toTripListItemWire, toTripWire, toTripWithRoleWire } from "./serialize.js";

export interface TripsRouterDeps {
  db: DbClient;
  /** Clock seam for tests (status boundary days, invite expiry). */
  now?: () => Date;
  /**
   * Rate limiting for the `/invites/:token*` token-guessing guard (trips
   * spec §3.3; consumed by `invites-routes.ts` — the CRUD routes here don't
   * charge it). Absent = no limiter (unit/integration tests); prod wiring
   * (`wire.ts`) always supplies it. `now` is MILLISECONDS (the store's clock),
   * independent of the seconds-grade `Date` seam above.
   */
  rateLimit?: {
    store: RateLimitStore;
    now?: () => number;
  };
  /**
   * Places-spine ingest enqueue seam (T-6.4, R-places-1): fired POST-COMMIT
   * on trip create and on destination change — asynchronous, fire-and-forget.
   * Optional: absent (tests/dev without the pipeline) simply skips the
   * trigger; trip writes NEVER block on, or fail because of, ingestion.
   */
  placesIngest?: PlacesIngestTrigger;
  /**
   * Push-invalidation emitter seam (T-6.3, R-trips-18): fired POST-COMMIT on
   * every §3.5 mutation — asynchronous, fire-and-forget, ids-only payloads.
   * Optional: absent (unit tests / dev without the seam) simply skips
   * emission; mutations NEVER block on, or fail because of, an emit. Prod
   * wiring (`wire.ts`) always supplies it (dormant until P-13's transport).
   */
  tripEvents?: TripEventEmitter;
}

// Keyset cursor over (created_at DESC, id DESC): the shared
// `http/keyset-cursor.ts` codec (extracted at T-6.2; behavior unchanged) —
// malformed cursors fall back to page 1 (the endpoint's documented errors
// don't include a cursor 400 — §3.3 GET /trips).

export function createTripsRouter(deps: TripsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const nowOf = () => (deps.now ? deps.now() : new Date());
  const requireTripMember = createRequireTripMember({ db: deps.db });

  // -------------------------------------------------------------------------
  // POST /trips — trip row + creator's owner membership in ONE transaction
  // (R-trips-3: at-least-one-owner from birth). Stored status is derived at
  // insert so a trip created mid-dates is born 'active', not 'planning'.
  // -------------------------------------------------------------------------
  router.post(
    tripEndpoints.createTrip.path,
    zValidator("json", tripEndpoints.createTrip.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");
      const today = todayUtc(nowOf());

      const trip = await deps.db.transaction(async (tx) => {
        // Caller liveness under lock — FIRST acquisition (global order:
        // users → trip_members → invites; the same door invite-accept
        // holds, T-6.2 round-2 advisory #2): a scrubbed account's
        // still-valid (≤15 min) token must not mint a ghost-owned orphan
        // trip. Account deletion holds this row FOR UPDATE for its whole
        // transaction (step 0), so an in-flight deletion parks this create
        // until it commits — the live-only re-check then misses → 401.
        const [liveCaller] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
          .for("share");
        if (!liveCaller) throw new HttpError("UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);

        const [inserted] = await tx
          .insert(schema.trips)
          .values({
            name: body.name,
            destinationName: body.destination_name,
            // numeric columns are string-mode (see db/schema/_shared.ts);
            // range was validated by the shared Lat/Lng schemas.
            destinationLat: String(body.destination_lat),
            destinationLng: String(body.destination_lng),
            startDate: body.start_date,
            endDate: body.end_date,
            status: effectiveTripStatus(
              { statusOverride: null, startDate: body.start_date, endDate: body.end_date },
              today,
            ),
            // Omitted → schema default 'USD' (§3.3 create; schema §3.3.4).
            ...(body.base_currency !== undefined ? { baseCurrency: body.base_currency } : {}),
            ...(body.theme !== undefined ? { theme: body.theme } : {}),
            createdBy: userId,
          })
          .returning();
        if (!inserted) throw new HttpError("INTERNAL", "trip insert returned no row");

        await tx
          .insert(schema.tripMembers)
          .values({ tripId: inserted.id, userId, role: "owner" });

        return inserted;
      });

      // R-places-1 primary trigger, POST-COMMIT: enqueue the destination's
      // region ingest. Fire-and-forget by contract — the trigger never
      // throws, and this belt-and-braces catch guarantees a broken seam
      // still can't fail the create (trip creation SHALL NOT block on, or
      // fail because of, ingestion).
      try {
        deps.placesIngest?.enqueueDestination(body.destination_lat, body.destination_lng);
      } catch {
        // Deliberately swallowed: enqueue is best-effort (R-places-1).
      }

      return c.json(toTripWithRoleWire(trip, "owner"), 201);
    },
  );

  // -------------------------------------------------------------------------
  // GET /trips — only trips where the caller holds a membership row, each
  // item carrying the caller's role + member_count (R-trips-4). Keyset-
  // paginated (created_at DESC, id DESC) — trip_members(user_id) is the root
  // query's index (§3.5 rule 5).
  // -------------------------------------------------------------------------
  router.get(
    tripEndpoints.listTrips.path,
    zValidator("query", tripEndpoints.listTrips.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const { cursor, limit } = c.req.valid("query");
      const pageSize = limit ?? TRIPS_PAGE_SIZE_DEFAULT;
      const decoded = cursor ? decodeKeysetCursor(cursor) : null;

      const predicates: SQL[] = [eq(schema.tripMembers.userId, userId)];
      if (decoded) {
        predicates.push(keysetCursorPredicate(schema.trips.createdAt, schema.trips.id, decoded));
      }

      // Fetch pageSize + 1: the sentinel row tells us whether a next page
      // exists without ever minting a cursor that dereferences to an empty
      // page. member_count is a correlated subquery — one round trip — and
      // counts LIVE members only (users.deleted_at IS NULL), the same
      // semantics as the account-deletion sole-owner guard: legacy ghost
      // membership rows (pre-T-6.1 deletions) must not inflate the count.
      const rows = await deps.db
        .select({
          trip: schema.trips,
          role: schema.tripMembers.role,
          memberCount: sql<number>`(select count(*)::int from trip_members tm join users u on u.id = tm.user_id and u.deleted_at is null where tm.trip_id = ${schema.trips.id})`,
          cursorMicros: epochMicrosExpr(schema.trips.createdAt),
        })
        .from(schema.trips)
        .innerJoin(schema.tripMembers, eq(schema.tripMembers.tripId, schema.trips.id))
        .where(and(...predicates))
        .orderBy(sql`${schema.trips.createdAt} DESC, ${schema.trips.id} DESC`)
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      const effective = await reconcileStoredStatuses(
        deps.db,
        page.map((row) => row.trip),
        todayUtc(nowOf()),
      );

      // §3.5 trip.status_changed fires on DERIVED RECONCILIATION too ("stored
      // status changes (derived reconciliation or manual override)"): the
      // reconcile write above is auto-commit, so this is post-commit. The
      // reader is the actor — their device just fetched the fresh value; the
      // other members' caches are the stale ones.
      for (const row of page) {
        if ((effective.get(row.trip.id) ?? row.trip.status) !== row.trip.status) {
          emitTripEvent(deps.tripEvents, {
            event: "trip.status_changed",
            tripId: row.trip.id,
            actorId: userId,
          });
        }
      }

      const items = page.map((row) =>
        toTripListItemWire(
          { ...row.trip, status: effective.get(row.trip.id) ?? row.trip.status },
          row.role,
          row.memberCount,
        ),
      );

      const last = page[page.length - 1];
      const nextCursor =
        rows.length > pageSize && last
          ? encodeKeysetCursor({ micros: last.cursorMicros, id: last.trip.id })
          : null;

      const body: Paginated<TripListItem> = { items, nextCursor };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // GET /trips/:tripId — member-gated detail (R-trips-1). Stored status
  // self-heals to the effective value on read (§3.4 reconciliation seam).
  // -------------------------------------------------------------------------
  router.get(tripEndpoints.getTrip.path, requireTripMember(), async (c) => {
    const { tripId, role } = tripContextOf(c);
    const { userId } = authContextOf(c);

    const [trip] = await deps.db
      .select()
      .from(schema.trips)
      .where(eq(schema.trips.id, tripId));
    // Gate raced a concurrent delete — the row is gone; converge (§3.5 rule 3).
    if (!trip) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const effective = await reconcileStoredStatuses(deps.db, [trip], todayUtc(nowOf()));
    const status = effective.get(trip.id) ?? trip.status;
    // Derived reconciliation moved the STORED status → §3.5 trip.status_changed
    // (post-commit: the reconcile write is auto-commit). Reader = actor.
    if (status !== trip.status) {
      emitTripEvent(deps.tripEvents, { event: "trip.status_changed", tripId, actorId: userId });
    }
    return c.json(toTripWithRoleWire({ ...trip, status }, role));
  });

  // -------------------------------------------------------------------------
  // PATCH /trips/:tripId — partial update, per-field authz per §3.2
  // (R-trips-20), row-grain LWW + optional expect_updated_at (R-trips-5/6),
  // base-currency lock (R-trips-22), status override seam (§3.4). Returns
  // the full updated row (R-trips-19).
  //
  // Route gate is `editor` (no PATCH field is viewer-writable, §3.2), so a
  // viewer gets 403 and a non-member the indistinguishable 404. Owner-only
  // fields tighten in-handler.
  // -------------------------------------------------------------------------
  router.patch(
    tripEndpoints.updateTrip.path,
    zValidator("json", tripEndpoints.updateTrip.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId, role } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");
      const today = todayUtc(nowOf());

      // Set inside the transaction iff the committed write moved the
      // destination — drives the post-commit ingest trigger (R-places-1).
      let destinationChanged = false;
      // Post-commit event flags (T-6.3, §3.5): trip.updated iff a writable
      // field actually committed (a write-less request is not a mutation —
      // R-trips-18 fires "WHEN any mutation ... commits"); trip.status_changed
      // iff the STORED status moved (override or derived reconciliation).
      // Both only escape the closure if the transaction commits.
      let fieldsWritten = false;
      let storedStatusChanged = false;

      const updated = await deps.db.transaction(async (tx) => {
        // Key-presence touches are known from the body alone — computed
        // before the load so the base-currency arm can lock it.
        const touchesBaseCurrency = body.base_currency !== undefined;
        const touchesStatus = body.status !== undefined;

        // T-6.1 TOCTOU fix (T-9.2 rider — the deferred QUEUE row): a body
        // touching base_currency takes the trip row FOR UPDATE, so the
        // R-trips-22 has-expenses check and the budgets-currency sync below
        // can never act on a pre-race snapshot. Expense create
        // (expenses/service.ts) takes the SAME lock before validating
        // against base_currency — the two serialize: a racing first expense
        // either commits before this check (→ 409 below) or waits and then
        // validates against the NEW base. Same-value resubmits also lock
        // (key presence, value-blind): the lock must be held BEFORE the
        // change/no-change decision reads the row, or the decision itself
        // races. Lock order: trips leads the global chain (expenses/
        // service.ts module doc).
        const currentQuery = tx.select().from(schema.trips).where(eq(schema.trips.id, tripId));
        const [current] = touchesBaseCurrency
          ? await currentQuery.for("update")
          : await currentQuery;
        if (!current) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

        // Owner-only FIELDS (R-trips-20): touching base_currency or the
        // manual status override requires role owner — presence of the key
        // is the "touch", regardless of value (403 is safe here: membership
        // already proved the trip exists).
        if ((touchesBaseCurrency || touchesStatus) && role !== "owner") {
          throw new HttpError("FORBIDDEN", "insufficient role");
        }

        // Date order re-validated against the MERGED row (§3.3: a partial
        // update can't sneak start > end past the body-only superRefine).
        const mergedStart = body.start_date ?? current.startDate;
        const mergedEnd = body.end_date ?? current.endDate;
        if (mergedStart > mergedEnd) {
          throw new HttpError(
            "VALIDATION_FAILED",
            "start_date must be on or before end_date",
            { end_date: "before start_date" },
          );
        }

        // Base-currency LOCK (R-trips-22): a CHANGE (value differs) is
        // rejected once the first expense row exists. Same-value resubmits
        // are not a change and pass — the settings form must be re-savable.
        const baseCurrencyChanges =
          touchesBaseCurrency && body.base_currency !== current.baseCurrency;
        if (baseCurrencyChanges) {
          const [expense] = await tx
            .select({ id: schema.expenses.id })
            .from(schema.expenses)
            .where(eq(schema.expenses.tripId, tripId))
            .limit(1);
          if (expense) {
            throw new HttpError(
              "CONFLICT",
              "base currency is locked once the first expense exists",
              { reason: "base_currency_locked" },
            );
          }
        }

        // Status seam (§3.4): the override (post-patch) wins; null clears it
        // and derivation resumes against the MERGED dates.
        const nextOverride = touchesStatus ? (body.status ?? null) : current.statusOverride;
        const nextStatus =
          nextOverride ??
          effectiveTripStatus(
            { statusOverride: null, startDate: mergedStart, endDate: mergedEnd },
            today,
          );

        const set: Partial<typeof schema.trips.$inferInsert> = { status: nextStatus };
        if (body.name !== undefined) set.name = body.name;
        if (body.destination_name !== undefined) set.destinationName = body.destination_name;
        if (body.destination_lat !== undefined) set.destinationLat = String(body.destination_lat);
        if (body.destination_lng !== undefined) set.destinationLng = String(body.destination_lng);
        if (body.start_date !== undefined) set.startDate = body.start_date;
        if (body.end_date !== undefined) set.endDate = body.end_date;
        if (body.theme !== undefined) set.theme = body.theme;
        if (body.base_currency !== undefined) set.baseCurrency = body.base_currency;
        if (touchesStatus) set.statusOverride = body.status ?? null;

        // No writable field in the body (empty patch, or expect_updated_at
        // alone): nothing to LWW — verify the precondition against the loaded
        // row and answer the current (status-reconciled) row. A write-less
        // request must never move `updated_at`.
        const { expect_updated_at: _precondition, ...writableFields } = body;
        const writableTouched = Object.values(writableFields).some(
          (value) => value !== undefined,
        );
        if (!writableTouched) {
          if (
            body.expect_updated_at !== undefined &&
            new Date(body.expect_updated_at).getTime() !== current.updatedAt.getTime()
          ) {
            throwGuardedUpdateMiss(true);
          }
          const effective = await reconcileStoredStatuses(tx, [current], today);
          const reconciled = effective.get(current.id) ?? current.status;
          storedStatusChanged = reconciled !== current.status;
          return { ...current, status: reconciled };
        }

        // Guarded LWW write: the precondition rides in the WHERE itself —
        // mismatch means ZERO rows written (R-trips-6), atomically.
        const wherePredicates: SQL[] = [eq(schema.trips.id, tripId)];
        const precondition = expectUpdatedAtPrecondition(
          schema.trips.updatedAt,
          body.expect_updated_at,
        );
        if (precondition) wherePredicates.push(precondition);

        const [row] = await tx
          .update(schema.trips)
          .set(set)
          .where(and(...wherePredicates))
          .returning();

        if (!row) {
          const [still] = await tx
            .select({ id: schema.trips.id })
            .from(schema.trips)
            .where(eq(schema.trips.id, tripId));
          throwGuardedUpdateMiss(still !== undefined);
        }
        fieldsWritten = true;
        storedStatusChanged = row.status !== current.status;

        // Pre-expense base-currency change updates budget rows' currency in
        // the SAME transaction — amounts unchanged, preserving
        // budgets.currency == trips.base_currency (R-trips-22, schema §3.3.15).
        if (baseCurrencyChanges && body.base_currency !== undefined) {
          await tx
            .update(schema.budgets)
            .set({ currency: body.base_currency })
            .where(eq(schema.budgets.tripId, tripId));
        }

        // Destination change (R-places-1: "…or its destination changes") —
        // VALUE-diff, not key-presence: resubmitting identical coords is not
        // a change (numeric columns are strings; compare numerically). The
        // flag only escapes if this transaction commits.
        destinationChanged =
          (body.destination_lat !== undefined &&
            Number(current.destinationLat) !== body.destination_lat) ||
          (body.destination_lng !== undefined &&
            Number(current.destinationLng) !== body.destination_lng);

        return row;
      });

      // POST-COMMIT ingest trigger for the moved destination — same
      // fire-and-forget contract as the create hook (R-places-1).
      if (destinationChanged) {
        try {
          deps.placesIngest?.enqueueDestination(
            Number(updated.destinationLat),
            Number(updated.destinationLng),
          );
        } catch {
          // Deliberately swallowed: enqueue is best-effort (R-places-1).
        }
      }

      // POST-COMMIT push invalidation (T-6.3, §3.5): trip.updated on any
      // committed field write ("any field incl. theme/currency"); ALSO
      // trip.status_changed when the stored status moved (its §3.5 row is
      // independent — a PATCH that archives emits both). The flags only
      // escape a COMMITTED transaction; every failure path above threw.
      if (fieldsWritten) {
        emitTripEvent(deps.tripEvents, { event: "trip.updated", tripId, actorId: userId });
      }
      if (storedStatusChanged) {
        emitTripEvent(deps.tripEvents, { event: "trip.status_changed", tripId, actorId: userId });
      }

      return c.json(toTripWire(updated) satisfies Trip);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId — owner-only; children cascade per schema §3.6
  // (R-trips-8). 204. A second delete converges to the indistinguishable 404
  // (§3.5 rule 3) — the membership row died with the trip, so the GATE
  // answers it; the in-handler 404 covers only the same-instant race.
  // -------------------------------------------------------------------------
  router.delete(tripEndpoints.deleteTrip.path, requireTripMember("owner"), async (c) => {
    const { tripId } = tripContextOf(c);
    const { userId } = authContextOf(c);

    // R-trips-8: trip.deleted goes "to all other members CAPTURED BEFORE THE
    // DELETE" — the fence SELECT below reads exactly that set, so capturing
    // it here adds no query and no lock. Post-commit the membership rows are
    // cascade-gone; this snapshot is the only correct recipient source.
    let memberSnapshot: readonly string[] = [];

    const deleted = await deps.db.transaction(async (tx) => {
      // Membership FENCE before the cascade (T-6.2 round-1 blocking #2). The
      // RI cascade exclusive-locks this trip's INVITE rows BEFORE its member
      // rows (Postgres fires FK triggers in creation order; 0000 creates the
      // invites FK before the trip_members FK), inverting the global
      // users → trip_members → invites acquisition order — an in-flight
      // invite-accept (owner-row FOR SHARE held, invite lock wanted) would
      // cycle with the cascade → 40P01. Taking every membership row
      // FOR UPDATE first, in user_id order (the account-deletion step-1
      // fence shape), parks this delete until in-flight accepts commit and
      // blocks new ones — by cascade time no other transaction holds
      // trip-scoped row locks, regardless of FK trigger order.
      const fencedMembers = await tx
        .select({ userId: schema.tripMembers.userId })
        .from(schema.tripMembers)
        .where(eq(schema.tripMembers.tripId, tripId))
        .orderBy(schema.tripMembers.userId)
        .for("update");
      memberSnapshot = fencedMembers.map((row) => row.userId);

      return tx
        .delete(schema.trips)
        .where(eq(schema.trips.id, tripId))
        .returning({ id: schema.trips.id });
    });
    if (deleted.length === 0) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    // POST-COMMIT push invalidation (T-6.3): the pre-delete member set minus
    // the actor (R-trips-8; §3.3 DELETE bullet). Live-filtering happens in
    // the emitter — ghost membership rows in the snapshot never get events.
    emitTripEvent(deps.tripEvents, {
      event: "trip.deleted",
      tripId,
      actorId: userId,
      recipientsSnapshot: memberSnapshot,
    });

    return c.body(null, 204);
  });

  return router;
}
