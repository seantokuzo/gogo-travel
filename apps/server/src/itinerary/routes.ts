/**
 * Itinerary routes (T-7.2 / IB-2): GET `/trips/:tripId/itinerary`,
 * POST `…/itinerary/items`, PATCH/DELETE `…/itinerary/items/:itemId`,
 * PUT `…/itinerary/days/:day/order` — itinerary-bookings spec §3.4, wire
 * shapes from `@gogo/shared/domains/itinerary` only. Covers
 * R-ib-13..R-ib-18, R-ib-24 (+ the R-ib-9 unschedule arm via the service).
 *
 * AUTHZ POSTURE (bookings routes precedent, followed exactly): runs behind
 * the app-wide `requireAuth`; every route sits behind `requireTripMember` —
 * a non-member's 404 is byte-identical to an absent trip's (R-ib-24, F-038
 * harness). Reads gate `viewer`; writes gate `editor`. No param zValidator
 * on `:tripId` (the gate folds malformed ids into the same 404);
 * `:itemId` is a gate-adjacent id param — in-handler `UUID_RE` pre-check
 * folds malformed values into the SAME indistinguishable 404, and the
 * trip-scoped service lookup makes a wrong-trip itemId identical to an
 * absent one. `:day` is NOT an id (no existence to protect): a malformed
 * day is a bad request — in-handler `ISODateSchema` check → 400
 * VALIDATION_FAILED.
 *
 * WRITE PATH: every mutation goes through the itinerary service
 * (service.ts); this router owns wire validation, authz, serialization, and
 * the POST-COMMIT dirty-day marks (I-5/R-ib-19 — fired strictly after the
 * service transaction returns, so an aborted write never marks; the seam is
 * dormant until T-7.3).
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  itineraryEndpoints,
  type DayOrderResult,
  type ItineraryItem,
  type ItineraryRead,
} from "@gogo/shared/domains/itinerary";
import { ISODateSchema } from "@gogo/shared/scalars";
import type { DbClient } from "../db/create-user.js";
import { apiError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { authContextOf } from "../http/require-auth.js";
import {
  createRequireTripMember,
  tripContextOf,
  UUID_RE,
} from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import { markDaysDirty, type DirtyDayMarker } from "../bookings/dirty-days.js";
import { toItineraryItemWire } from "../bookings/serialize.js";
import { createItem, deleteItem, readItinerary, reorderDay, updateItem } from "./service.js";
import { toTravelLegWire } from "./serialize.js";

export interface ItineraryRouterDeps {
  db: DbClient;
  /**
   * Travel-leg dirty-day marker seam (I-5/R-ib-19): fired POST-COMMIT on
   * every mutation that changes calendar placement — fire-and-forget, never
   * blocks, never fails a request. Optional: absent (unit tests) simply
   * skips marking; prod wiring supplies the (dormant until T-7.3) marker.
   */
  dirtyDays?: DirtyDayMarker;
}

export function createItineraryRouter(deps: ItineraryRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  /** Malformed `:itemId` → the same indistinguishable 404 (module doc). */
  const validItemId = (raw: string | undefined): string | null =>
    raw !== undefined && UUID_RE.test(raw) ? raw : null;

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/itinerary — the one-shot calendar read (R-ib-13).
  // -------------------------------------------------------------------------
  router.get(
    itineraryEndpoints.getItinerary.path,
    zValidator("query", itineraryEndpoints.getItinerary.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const query = c.req.valid("query");

      const result = await readItinerary(deps.db, {
        tripId,
        from: query.from,
        to: query.to,
      });
      const body: ItineraryRead = {
        items: result.items.map(toItineraryItemWire),
        legs: result.legs.map(toTravelLegWire),
      };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/itinerary/items — direct create, place_visit/custom
  // only (R-ib-14; kind 'booking' is unrepresentable in the wire schema).
  // -------------------------------------------------------------------------
  router.post(
    itineraryEndpoints.createItineraryItem.path,
    zValidator("json", itineraryEndpoints.createItineraryItem.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const input = c.req.valid("json");

      const result = await createItem(deps.db, { tripId, userId, input });
      // POST-COMMIT dirty-day marks (I-5): only a committed transaction
      // reaches here; every failure path threw inside it.
      markDaysDirty(deps.dirtyDays, result.dirtyDays);

      return c.json(toItineraryItemWire(result.item) satisfies ItineraryItem, 201);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /trips/:tripId/itinerary/items/:itemId — post-state (R-ib-18);
  // booking-kind field protection per R-ib-16 in the service.
  // -------------------------------------------------------------------------
  router.patch(
    itineraryEndpoints.updateItineraryItem.path,
    zValidator("json", itineraryEndpoints.updateItineraryItem.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const itemId = validItemId(c.req.param("itemId"));
      if (!itemId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      const input = c.req.valid("json");

      const result = await updateItem(deps.db, { tripId, itemId, userId, input });
      markDaysDirty(deps.dirtyDays, result.dirtyDays);

      return c.json(toItineraryItemWire(result.item) satisfies ItineraryItem);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/itinerary/items/:itemId — unschedule semantics for
  // booking-kind (R-ib-9: planned parent reverts to idea; booked parent 409).
  // -------------------------------------------------------------------------
  router.delete(
    itineraryEndpoints.deleteItineraryItem.path,
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const itemId = validItemId(c.req.param("itemId"));
      if (!itemId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      const result = await deleteItem(deps.db, { tripId, itemId });
      if (!result) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      markDaysDirty(deps.dirtyDays, result.dirtyDays);

      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /trips/:tripId/itinerary/days/:day/order — the drag-drop commit and
  // the re-index path (R-ib-15); post-state response (R-ib-18).
  // -------------------------------------------------------------------------
  router.put(
    itineraryEndpoints.putDayOrder.path,
    zValidator("json", itineraryEndpoints.putDayOrder.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const day = c.req.param("day");
      if (!day || !ISODateSchema.safeParse(day).success) {
        return apiError(c, "VALIDATION_FAILED", "day must be an ISO date (YYYY-MM-DD)", {
          day: "malformed",
        });
      }
      const input = c.req.valid("json");

      const result = await reorderDay(deps.db, { tripId, day, input });
      markDaysDirty(deps.dirtyDays, result.dirtyDays);

      const body: DayOrderResult = { items: result.items.map(toItineraryItemWire) };
      return c.json(body);
    },
  );

  return router;
}
