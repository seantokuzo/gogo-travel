/**
 * Bookings routes (T-7.1 / IB-1): GET/POST `/trips/:tripId/bookings`,
 * GET/PATCH/DELETE `/trips/:tripId/bookings/:bookingId`,
 * POST `…/bookings/:bookingId/schedule` — itinerary-bookings spec §3.4, wire
 * shapes from `@gogo/shared/domains/booking` only. Covers R-ib-1..R-ib-12,
 * R-ib-18, R-ib-24 (+ §3.1 I-1..I-4 via the service).
 *
 * AUTHZ POSTURE (trips routes precedent, followed exactly): runs behind the
 * app-wide `requireAuth`; every route sits behind `requireTripMember` — a
 * non-member's 404 is byte-identical to an absent trip's (R-ib-24, F-038
 * harness). Reads gate `viewer`; writes gate `editor` (viewer → 403,
 * server-enforced R-ib-24). No param zValidator on `:tripId` (the gate folds
 * malformed ids into the same 404); `:bookingId` is a gate-adjacent id param
 * — in-handler `UUID_RE` pre-check folds malformed values into the SAME
 * indistinguishable 404 (server rule: a param 400 is a distinguishable door),
 * and the trip-scoped service lookup makes a wrong-trip bookingId identical
 * to an absent one.
 *
 * WRITE PATH: every mutation goes through the booking domain service
 * (service.ts — §3.1's single write path); this router owns only wire
 * validation, authz, serialization, and the POST-COMMIT dirty-day marks
 * (I-5/R-ib-19 — fired strictly after the service transaction returns, so an
 * aborted write never marks; the seam is dormant until T-7.3).
 *
 * DOMAIN EVENTS: §3.8 puts push fan-out out of scope and the spec text names
 * no booking.* events — none are emitted (Law #4: no improvised events; gap
 * noted in the PR body for the notifications spec).
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, notExists, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { bookingEndpoints, type Booking } from "@gogo/shared/domains/booking";
import { BOOKING_STATUSES } from "@gogo/shared/enums";
import type { Paginated } from "@gogo/shared/api/envelope";
import { BOOKINGS_PAGE_SIZE_DEFAULT } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { epochMicrosExpr, nullableEpochMicrosExpr } from "../http/keyset-cursor.js";
import { authContextOf } from "../http/require-auth.js";
import {
  createRequireTripMember,
  tripContextOf,
  UUID_RE,
} from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import {
  bookingCursorPredicate,
  decodeBookingCursor,
  encodeBookingCursor,
} from "./cursor.js";
import { markDaysDirty, type DirtyDayMarker } from "./dirty-days.js";
import {
  createBooking,
  deleteBooking,
  getBookingWithItems,
  scheduleBooking,
  updateBooking,
} from "./service.js";
import { toBookingWire, toBookingWithItemsWire } from "./serialize.js";

export interface BookingsRouterDeps {
  db: DbClient;
  /**
   * Travel-leg dirty-day marker seam (I-5/R-ib-19): fired POST-COMMIT on
   * every mutation that changes calendar placement — fire-and-forget, never
   * blocks, never fails a request. Optional: absent (unit tests) simply
   * skips marking; prod wiring supplies the (dormant until T-7.3) marker.
   */
  dirtyDays?: DirtyDayMarker;
}

const DEFAULT_STATUSES = BOOKING_STATUSES.filter((status) => status !== "cancelled");

export function createBookingsRouter(deps: BookingsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  /** Malformed `:bookingId` → the same indistinguishable 404 (module doc). */
  const validBookingId = (raw: string | undefined): string | null =>
    raw !== undefined && UUID_RE.test(raw) ? raw : null;

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/bookings — the bookings/ideas surfaces list.
  // Ordered `starts_at ASC NULLS LAST, updated_at DESC, id DESC` (timeless
  // ideas trail, freshest first; id is the determinism tiebreaker). Filters
  // per R-ib-10; keyset-paginated on the bookings cursor codec (malformed
  // cursors fall back to page 1 — no cursor 400 is documented).
  // -------------------------------------------------------------------------
  router.get(
    bookingEndpoints.listBookings.path,
    zValidator("query", bookingEndpoints.listBookings.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const query = c.req.valid("query");
      const pageSize = query.limit ?? BOOKINGS_PAGE_SIZE_DEFAULT;
      const decoded = query.cursor ? decodeBookingCursor(query.cursor) : null;

      // Default status set = all except cancelled; explicit `status=` wins
      // (R-ib-10: cancelled appears only when explicitly requested).
      const statuses = query.status ?? DEFAULT_STATUSES;
      const predicates: SQL[] = [
        eq(schema.bookings.tripId, tripId),
        inArray(schema.bookings.status, statuses),
      ];
      if (query.category !== undefined) {
        predicates.push(eq(schema.bookings.category, query.category));
      }
      if (query.unscheduled === true) {
        // R-ib-10: exactly the bookings having ZERO itinerary_items rows.
        predicates.push(
          notExists(
            deps.db
              .select({ one: sql`1` })
              .from(schema.itineraryItems)
              .where(eq(schema.itineraryItems.bookingId, schema.bookings.id)),
          ),
        );
      }
      // `unscheduled=false` deliberately behaves as ABSENT (no filter): the
      // spec defines only `unscheduled=true` (R-ib-10) — a scheduled-only
      // complement would be spec-uncovered behavior (Law #4; the product
      // question is parked for the spec pass, round-1 A3).
      if (decoded) predicates.push(bookingCursorPredicate(decoded));

      // pageSize + 1 sentinel: know whether a next page exists without ever
      // minting a cursor that dereferences to an empty page.
      const rows = await deps.db
        .select({
          booking: schema.bookings,
          // One formula home (round-1 A4): the select-side sort keys and the
          // cursor predicate share the keyset-cursor helpers — never drift.
          startsMicros: nullableEpochMicrosExpr(schema.bookings.startsAt),
          updatedMicros: epochMicrosExpr(schema.bookings.updatedAt),
        })
        .from(schema.bookings)
        .where(and(...predicates))
        .orderBy(
          sql`${schema.bookings.startsAt} ASC NULLS LAST, ${schema.bookings.updatedAt} DESC, ${schema.bookings.id} DESC`,
        )
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > pageSize && last
          ? encodeBookingCursor({
              startsMicros: last.startsMicros,
              updatedMicros: last.updatedMicros,
              id: last.booking.id,
            })
          : null;

      const body: Paginated<Booking> = {
        items: page.map((row) => toBookingWire(row.booking)),
        nextCursor,
      };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/bookings — manual-entry + deeplink-return create.
  // The wire schema restricts `source` to manual|deeplink_return (R-ib-11)
  // and `status` to the creatable set; side effects per §3.1 ride the
  // service transaction (R-ib-4/R-ib-5).
  // -------------------------------------------------------------------------
  router.post(
    bookingEndpoints.createBooking.path,
    zValidator("json", bookingEndpoints.createBooking.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const input = c.req.valid("json");

      const result = await createBooking(deps.db, { tripId, userId, input });
      // POST-COMMIT dirty-day marks (I-5): only a committed transaction
      // reaches here; every failure path threw inside it.
      markDaysDirty(deps.dirtyDays, result.dirtyDays);

      return c.json(toBookingWire(result.booking) satisfies Booking, 201);
    },
  );

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/bookings/:bookingId — detail + calendar presence.
  // -------------------------------------------------------------------------
  router.get(bookingEndpoints.getBooking.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);
    const bookingId = validBookingId(c.req.param("bookingId"));
    if (!bookingId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const found = await getBookingWithItems(deps.db, { tripId, bookingId });
    if (!found) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    return c.json(toBookingWithItemsWire(found.booking, found.items));
  });

  // -------------------------------------------------------------------------
  // PATCH /trips/:tripId/bookings/:bookingId — partial update; §3.2
  // transitions + item side effects in the service transaction; post-state
  // response (R-ib-18).
  // -------------------------------------------------------------------------
  router.patch(
    bookingEndpoints.updateBooking.path,
    zValidator("json", bookingEndpoints.updateBooking.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const bookingId = validBookingId(c.req.param("bookingId"));
      if (!bookingId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      const input = c.req.valid("json");

      const result = await updateBooking(deps.db, { tripId, bookingId, userId, input });
      markDaysDirty(deps.dirtyDays, result.dirtyDays);

      return c.json(toBookingWithItemsWire(result.booking, result.items));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/bookings/:bookingId — hard delete; items cascade,
  // expense links SET NULL (schema §3.6). 204.
  // -------------------------------------------------------------------------
  router.delete(bookingEndpoints.deleteBooking.path, requireTripMember("editor"), async (c) => {
    const { tripId } = tripContextOf(c);
    const bookingId = validBookingId(c.req.param("bookingId"));
    if (!bookingId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const result = await deleteBooking(deps.db, { tripId, bookingId });
    if (!result) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    markDaysDirty(deps.dirtyDays, result.dirtyDays);

    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/bookings/:bookingId/schedule — the ideas-bucket
  // "Add to day" action (R-ib-8). 201 with the post-state (R-ib-18).
  // -------------------------------------------------------------------------
  router.post(
    bookingEndpoints.scheduleBooking.path,
    zValidator("json", bookingEndpoints.scheduleBooking.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const bookingId = validBookingId(c.req.param("bookingId"));
      if (!bookingId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      const input = c.req.valid("json");

      const result = await scheduleBooking(deps.db, { tripId, bookingId, userId, input });
      markDaysDirty(deps.dirtyDays, result.dirtyDays);

      return c.json(toBookingWithItemsWire(result.booking, result.items), 201);
    },
  );

  return router;
}
