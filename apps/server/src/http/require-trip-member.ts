/**
 * `requireTripMember(minRole)` — the trip-scoped authz guard every
 * `/trips/:tripId/*` route in every API spec runs (AU-5, R-authz-2/3; Law #3).
 *
 * THE headline property is 404-indistinguishability (§3.6.4): a caller who is
 * not a member of `:tripId` gets the byte-identical 404 a nonexistent trip
 * gets — never a 403, never a distinguishable body. A non-member must not be
 * able to tell a trip exists. The guard achieves this with ONE query: it loads
 * the caller's own `trip_members` row. Absent membership and absent trip are
 * the same observable outcome because we never consult the `trips` table — so
 * there is no existence oracle to leak. (A 403 is reserved for a proven member
 * whose role is too low: their membership already proves the trip exists, so
 * `FORBIDDEN` reveals nothing new — R-authz-3.)
 *
 * Runs AFTER `requireAuth` and body/param validation (R-authz-4 order): it
 * reads the authenticated `userId` from context and the `:tripId` route param.
 * A `:tripId` that is not a UUID is treated as not-found (indistinguishable) so
 * the guard never hands a crafted value to the `uuid` cast — no 500 vector, no
 * "valid-uuid vs garbage" oracle among values that reach it.
 */
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { TripMemberRole } from "@gogo/shared/enums";
import { TRIP_ROLE_RANK } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, NOT_FOUND_MESSAGE, type RequestVars, type TripContext } from "./errors.js";
import { authContextOf } from "./require-auth.js";

/**
 * Canonical hyphenated UUID — what `gen_random_uuid()` mints and `::uuid`
 * accepts. THE one copy: sibling route params (`:userId`, `:inviteId`) import
 * it to fold malformed ids into the same indistinguishable 404 (a param
 * zValidator 400 would open a distinguishable door — server rule; the users'
 * `:userId` 400-vs-404 convergence is the parked P3 QUEUE row), and the
 * keyset-cursor codec imports it to keep crafted cursors out of `::uuid`.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RequireTripMemberDeps {
  db: DbClient;
  /** Route param carrying the trip id (default `tripId`, matching the spec pattern). */
  paramName?: string;
}

/**
 * Build a trip-membership guard. `minRole` defaults to `viewer` (reads); a
 * mutation route passes `editor`, a management route `owner`. Per-endpoint
 * declarations may only TIGHTEN the minimum (R-authz-3).
 */
export function createRequireTripMember(deps: RequireTripMemberDeps) {
  const paramName = deps.paramName ?? "tripId";

  return (minRole: TripMemberRole = "viewer") =>
    createMiddleware<RequestVars>(async (c, next) => {
      const { userId } = authContextOf(c);
      const tripId = c.req.param(paramName);

      // A missing / non-UUID param can't match any real trip → the same 404 a
      // nonexistent trip yields. Guarding here also keeps the crafted value out
      // of the `::uuid` cast below (no `invalid input syntax` 500).
      if (!tripId || !UUID_RE.test(tripId)) {
        return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      }

      const [membership] = await deps.db
        .select({ role: schema.tripMembers.role })
        .from(schema.tripMembers)
        .where(and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.userId, userId)));

      // No membership row → indistinguishable 404 (this covers BOTH "trip does
      // not exist" and "trip exists but you are not a member"). Never 403 here.
      // `[row]` is typed defined but runtime-undefined on no match — guard it.
      if (!membership) {
        return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      }

      // Proven member below the required role → 403. Safe to differentiate now:
      // membership already told them the trip exists, so no new info leaks.
      if (TRIP_ROLE_RANK[membership.role] < TRIP_ROLE_RANK[minRole]) {
        return apiError(c, "FORBIDDEN", "insufficient role");
      }

      const trip: TripContext = { tripId, role: membership.role };
      c.set("trip", trip);
      await next();
      return undefined;
    });
}

/**
 * Read the trip context a preceding `requireTripMember` attached. Absent means
 * the guard did not run — a wiring bug, never a client condition.
 */
export function tripContextOf(c: Context<RequestVars>): TripContext {
  const trip = c.get("trip");
  if (!trip) throw new Error("tripContextOf called without a preceding requireTripMember");
  return trip;
}
