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
 * is the Neon WebSocket Pool, never Neon-HTTP (landmine #1).
 *
 * Push invalidation events (§3.5: trip.updated / trip.status_changed /
 * trip.deleted) are T-6.3's post-commit emitter seam — deliberately not
 * emitted here yet (STATE P-6 wave plan: emitter stubs land in T-6.3).
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { tripEndpoints, type Trip, type TripListItem } from "@gogo/shared/domains/trip";
import type { Paginated } from "@gogo/shared/api/envelope";
import { TRIPS_PAGE_SIZE_DEFAULT } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, HttpError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
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

    const [trip] = await deps.db
      .select()
      .from(schema.trips)
      .where(eq(schema.trips.id, tripId));
    // Gate raced a concurrent delete — the row is gone; converge (§3.5 rule 3).
    if (!trip) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const effective = await reconcileStoredStatuses(deps.db, [trip], todayUtc(nowOf()));
    return c.json(
      toTripWithRoleWire({ ...trip, status: effective.get(trip.id) ?? trip.status }, role),
    );
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
      const body = c.req.valid("json");
      const today = todayUtc(nowOf());

      const updated = await deps.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.trips)
          .where(eq(schema.trips.id, tripId));
        if (!current) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

        // Owner-only FIELDS (R-trips-20): touching base_currency or the
        // manual status override requires role owner — presence of the key
        // is the "touch", regardless of value (403 is safe here: membership
        // already proved the trip exists).
        const touchesBaseCurrency = body.base_currency !== undefined;
        const touchesStatus = body.status !== undefined;
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
          return { ...current, status: effective.get(current.id) ?? current.status };
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

        // Pre-expense base-currency change updates budget rows' currency in
        // the SAME transaction — amounts unchanged, preserving
        // budgets.currency == trips.base_currency (R-trips-22, schema §3.3.15).
        if (baseCurrencyChanges && body.base_currency !== undefined) {
          await tx
            .update(schema.budgets)
            .set({ currency: body.base_currency })
            .where(eq(schema.budgets.tripId, tripId));
        }

        return row;
      });

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

    const deleted = await deps.db
      .delete(schema.trips)
      .where(eq(schema.trips.id, tripId))
      .returning({ id: schema.trips.id });
    if (deleted.length === 0) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    return c.body(null, 204);
  });

  return router;
}
