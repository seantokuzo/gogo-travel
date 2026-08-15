/**
 * Saved-places routes (T-8.1 / PL-4; places spec §3.3): GET/POST
 * `/trips/:tripId/saved-places`, PATCH/DELETE
 * `/trips/:tripId/saved-places/:savedPlaceId`. Covers R-places-15/16.
 *
 * AUTHZ POSTURE (bookings/itinerary routes precedent, followed exactly):
 * runs behind the app-wide `requireAuth`; every route sits behind
 * `requireTripMember` — a non-member's 404 is byte-identical to an absent
 * trip's (R-places-15, F-038 harness). Reads gate `viewer`; writes gate
 * `editor` (viewer → 403, server-enforced — the R-ib-24 pattern).
 * `:savedPlaceId` is a gate-adjacent id param — in-handler `UUID_RE`
 * pre-check folds malformed values into the SAME indistinguishable 404
 * (server rule: a param 400 is a distinguishable door), and the trip-scoped
 * `WHERE trip_id` predicate makes a wrong-trip savedPlaceId identical to an
 * absent one.
 *
 * LAW #3 — `place_id` IS A VISIBILITY GRANT (T-7.1 landmine): saving a place
 * surfaces it to every trip member via the trip-content widening rule, so
 * POST consumes THE shared predicate (`visibility.ts`) and folds an
 * invisible/unknown/malformed `place_id` into the canonical 404. Under READ
 * COMMITTED the check→insert window is a real race (the bookings
 * `assertPlaceVisible` analysis): a place hard-deleted in the window fires
 * the place FK instead — the constraint-precise 23503 walker below maps
 * that residue onto the SAME 404, and the duplicate-save unique constraint
 * maps 23505 onto the spec's 409 (R-places-16). Insert-then-map is
 * deliberately TOCTOU-free where a pre-check would not be; a transaction
 * would add nothing here (single-row insert; READ COMMITTED gives each
 * statement its own snapshot regardless, and no row is locked).
 *
 * No lock-order obligations: saved_places joins no locked table chain
 * (single-row writes, no membership-adjacent rows created — the STATE P-6
 * lock order stays untouched).
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Paginated } from "@gogo/shared/api/envelope";
import { placeEndpoints, type SavedPlaceWithPlace } from "@gogo/shared/domains/place";
import { SAVED_PLACES_PAGE_SIZE_DEFAULT } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, HttpError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  epochMicrosExpr,
  keysetCursorPredicate,
} from "../http/keyset-cursor.js";
import { authContextOf } from "../http/require-auth.js";
import {
  createRequireTripMember,
  tripContextOf,
  UUID_RE,
} from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import { toSavedPlaceWire } from "./serialize.js";
import { resolvePlaceAccess } from "./visibility.js";

export interface SavedPlacesRouterDeps {
  db: DbClient;
}

/** The Drizzle-generated constraints on `saved_places` this router maps. */
export const SAVED_PLACES_TRIP_PLACE_UQ = "saved_places_trip_place_uq";
export const SAVED_PLACES_PLACE_FK = "saved_places_place_id_places_id_fk";

/**
 * Constraint of a wrapped Postgres violation with the given SQLSTATE, or
 * `null`. 🔴 Driver trap (the `isPlaceFkViolation` / `fkViolationTable`
 * precedent): postgres-js — the TEST driver — exposes the wire field as
 * `constraint_name`; pg-protocol's `DatabaseError` — what the PROD Neon
 * serverless driver throws — exposes `constraint`. Accept BOTH and walk
 * `cause` for Drizzle-wrapped shapes; the predicates below are exported so
 * unit tests can pin the prod shape no container ever produces.
 */
function violationConstraint(error: unknown, code: "23503" | "23505"): string | null {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
    };
    if (candidate.code === code) {
      if (typeof candidate.constraint_name === "string") return candidate.constraint_name;
      if (typeof candidate.constraint === "string") return candidate.constraint;
      return null;
    }
    current = current.cause;
  }
  return null;
}

/** Duplicate `(trip_id, place_id)` → the R-places-16 409. Constraint-PRECISE:
 * any other unique violation on this path is a bug and stays loud. */
export function isSavedPlaceDuplicate(error: unknown): boolean {
  return violationConstraint(error, "23505") === SAVED_PLACES_TRIP_PLACE_UQ;
}

/** The check→insert race residue (place hard-deleted in the window) → the
 * canonical 404. Constraint-PRECISE: the trip FK is gate-proven and the
 * creator FK is auth-proven — those stay loud if they ever fire. */
export function isSavedPlacePlaceFkViolation(error: unknown): boolean {
  return violationConstraint(error, "23503") === SAVED_PLACES_PLACE_FK;
}

export function createSavedPlacesRouter(deps: SavedPlacesRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  /** Malformed `:savedPlaceId` → the same indistinguishable 404 (module doc). */
  const validSavedPlaceId = (raw: string | undefined): string | null =>
    raw !== undefined && UUID_RE.test(raw) ? raw : null;

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/saved-places — the map's pin set + the saved list
  // (R-places-15; any member, viewer included). Embedded `place` per §3.2 —
  // one round trip renders pins + list. Ordered `created_at DESC, id DESC`
  // on THE keyset codec (its canonical ordering — deterministic for cursor
  // stability); malformed cursors fall back to page 1 (opaque server-minted
  // token, trips precedent).
  // -------------------------------------------------------------------------
  router.get(
    placeEndpoints.listSavedPlaces.path,
    zValidator("query", placeEndpoints.listSavedPlaces.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const query = c.req.valid("query");
      const pageSize = query.limit ?? SAVED_PLACES_PAGE_SIZE_DEFAULT;
      const cursor = query.cursor ? decodeKeysetCursor(query.cursor) : null;

      // pageSize + 1 sentinel: know whether a next page exists without ever
      // minting a cursor that dereferences to an empty page.
      const rows = await deps.db
        .select({
          saved: schema.savedPlaces,
          place: schema.places,
          createdMicros: epochMicrosExpr(schema.savedPlaces.createdAt),
        })
        .from(schema.savedPlaces)
        .innerJoin(schema.places, eq(schema.places.id, schema.savedPlaces.placeId))
        .where(
          and(
            eq(schema.savedPlaces.tripId, tripId),
            ...(cursor
              ? [keysetCursorPredicate(schema.savedPlaces.createdAt, schema.savedPlaces.id, cursor)]
              : []),
          ),
        )
        .orderBy(sql`${schema.savedPlaces.createdAt} DESC, ${schema.savedPlaces.id} DESC`)
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > pageSize && last
          ? encodeKeysetCursor({ micros: last.createdMicros, id: last.saved.id })
          : null;

      const body: Paginated<SavedPlaceWithPlace> = {
        items: page.map((row) => toSavedPlaceWire(row.saved, row.place)),
        nextCursor,
      };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/saved-places — save a place to the trip
  // (R-places-15/16; owner/editor). Visibility check (Law #3, module doc)
  // then insert; the constraint walkers close both race windows.
  // -------------------------------------------------------------------------
  router.post(
    placeEndpoints.createSavedPlace.path,
    zValidator("json", placeEndpoints.createSavedPlace.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");

      // Unknown, invisible-custom, and (schema-rejected upstream) malformed
      // place ids all converge on the canonical 404 — a probe can't learn a
      // custom place exists via the save door (R-places-8 posture).
      const access = await resolvePlaceAccess(deps.db, { placeId: body.place_id, userId });
      if (access.kind === "not_found") return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      let inserted: (typeof schema.savedPlaces.$inferSelect)[];
      try {
        inserted = await deps.db
          .insert(schema.savedPlaces)
          .values({
            tripId,
            placeId: access.row.id,
            note: body.note ?? null,
            createdBy: userId,
          })
          .returning();
      } catch (err) {
        // Already saved → 409 (R-places-16; clients may treat as idempotent
        // success — map spec R-map-11).
        if (isSavedPlaceDuplicate(err)) {
          return apiError(c, "CONFLICT", "place is already saved to this trip", {
            reason: "already_saved",
          });
        }
        // Place hard-deleted in the check→insert window → same canonical 404.
        if (isSavedPlacePlaceFkViolation(err)) {
          return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
        }
        throw err;
      }
      const row = inserted[0];
      if (!row) throw new HttpError("INTERNAL", "saved place insert returned no row");

      return c.json(toSavedPlaceWire(row, access.row) satisfies SavedPlaceWithPlace, 201);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /trips/:tripId/saved-places/:savedPlaceId — edit the note
  // (R-places-15; owner/editor). `null` clears. Row-grain LWW — no
  // precondition field is specced for saved places. The `trip_id` predicate
  // makes a wrong-trip id indistinguishable from an absent one.
  // -------------------------------------------------------------------------
  router.patch(
    placeEndpoints.updateSavedPlace.path,
    zValidator("json", placeEndpoints.updateSavedPlace.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const savedPlaceId = validSavedPlaceId(c.req.param("savedPlaceId"));
      if (!savedPlaceId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      const body = c.req.valid("json");

      const [updated] = await deps.db
        .update(schema.savedPlaces)
        .set({ note: body.note })
        .where(
          and(eq(schema.savedPlaces.id, savedPlaceId), eq(schema.savedPlaces.tripId, tripId)),
        )
        .returning();
      if (!updated) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      // FK RESTRICT guarantees the place row outlives its pins — an absent
      // row here is corruption, never a client condition.
      const [place] = await deps.db
        .select()
        .from(schema.places)
        .where(eq(schema.places.id, updated.placeId));
      if (!place) throw new HttpError("INTERNAL", "saved place references a missing place row");

      return c.json(toSavedPlaceWire(updated, place) satisfies SavedPlaceWithPlace);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/saved-places/:savedPlaceId — unsave
  // (R-places-15; owner/editor). Hard delete, no tombstone — a re-save
  // afterwards succeeds (§3.3 test contract). 204.
  // -------------------------------------------------------------------------
  router.delete(
    placeEndpoints.deleteSavedPlace.path,
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const savedPlaceId = validSavedPlaceId(c.req.param("savedPlaceId"));
      if (!savedPlaceId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      const deleted = await deps.db
        .delete(schema.savedPlaces)
        .where(
          and(eq(schema.savedPlaces.id, savedPlaceId), eq(schema.savedPlaces.tripId, tripId)),
        )
        .returning({ id: schema.savedPlaces.id });
      if (deleted.length === 0) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      return c.body(null, 204);
    },
  );

  return router;
}
