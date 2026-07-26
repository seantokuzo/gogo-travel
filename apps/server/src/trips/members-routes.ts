/**
 * Trip members routes (T-6.2 / API-TRIPS-2): GET/PATCH/DELETE
 * `/trips/:tripId/members*` + `POST /trips/:tripId/transfer-ownership` —
 * trips spec §3.3, §3.2 thresholds. Covers R-trips-9..12.
 *
 * AUTHZ POSTURE: same as trips/routes.ts — app-wide `requireAuth`, every
 * route behind `requireTripMember` (non-member 404 is byte-identical to an
 * absent trip; F-038 harness proves it). Route minimums per §3.2: member
 * list + leave `viewer`, role change + transfer `owner`; removal of OTHERS
 * tightens to owner in-handler (the route stays `viewer` because leave is
 * self-service). `:userId` gets a UUID pre-check that folds malformed ids
 * into the target-not-found 404 — no param zValidator 400 door (server rule;
 * the users' 400-vs-404 convergence is the parked P3 QUEUE row).
 *
 * ONE-OWNER INVARIANT (R-trips-9): at-most-one is the DB's partial unique
 * index (`uq_trip_single_owner`, 0000 baseline); at-least-one is enforced
 * here BY CONSTRUCTION — no code path deletes or demotes an owner row except
 * the transfer transaction, which demotes-then-promotes atomically (demote
 * FIRST so the non-deferrable unique index never sees two owners mid-flight).
 *
 * LIVE-USER SEMANTICS (STATE P-6 landmine: membership aggregates join LIVE
 * users): the member LIST and the owner-leave "other members" check join
 * live users (ghost rows must not inflate them); transfer REQUIRES a live
 * target (R-trips-10 needs a member who can still act — same rationale as
 * the account-deletion sole-owner-ghost fix). Removal deliberately operates
 * on the RAW membership row: it is a row write, not an aggregate, and it is
 * the only API path that can clean a legacy ghost row up.
 *
 * Push events (member.role_changed / member.removed / member.left /
 * ownership.transferred — §3.5) are T-6.3's post-commit emitter seam —
 * deliberately not emitted here yet (same deferral as trips/routes.ts).
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { memberEndpoints } from "@gogo/shared/domains/member";
import * as schema from "../db/schema/index.js";
import { apiError, HttpError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { authContextOf } from "../http/require-auth.js";
import {
  createRequireTripMember,
  tripContextOf,
  UUID_RE,
} from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import type { TripsRouterDeps } from "./routes.js";
import { toMemberListItemWire, toTripMemberWire } from "./serialize.js";

export function createMembersRouter(deps: TripsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  /** Any LIVE member of the trip other than `userId` (ghosts never count). */
  async function otherLiveMemberExists(tripId: string, userId: string): Promise<boolean> {
    const [other] = await deps.db
      .select({ userId: schema.tripMembers.userId })
      .from(schema.tripMembers)
      .innerJoin(
        schema.users,
        and(eq(schema.users.id, schema.tripMembers.userId), isNull(schema.users.deletedAt)),
      )
      .where(and(eq(schema.tripMembers.tripId, tripId), ne(schema.tripMembers.userId, userId)))
      .limit(1);
    return other !== undefined;
  }

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/members — every LIVE member with role + the
  // member-visible UserProfile (handles included by design, §3.2). Plain
  // `{ items }`, not Paginated — the spec shape carries no cursor (§3.3).
  // Deterministic order: joined_at ASC (owner first by construction), id
  // tiebreak.
  // -------------------------------------------------------------------------
  router.get(memberEndpoints.listMembers.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);

    const rows = await deps.db
      .select({ member: schema.tripMembers, user: schema.users })
      .from(schema.tripMembers)
      .innerJoin(
        schema.users,
        and(eq(schema.users.id, schema.tripMembers.userId), isNull(schema.users.deletedAt)),
      )
      .where(eq(schema.tripMembers.tripId, tripId))
      .orderBy(sql`${schema.tripMembers.joinedAt} ASC, ${schema.tripMembers.userId} ASC`);

    return c.json({ items: rows.map((row) => toMemberListItemWire(row.member, row.user)) });
  });

  // -------------------------------------------------------------------------
  // PATCH /trips/:tripId/members/:userId — owner flips editor ↔ viewer.
  // `role: 'owner'` is unrepresentable in the shared body schema (400 at the
  // boundary); targeting the owner is a 400 (there is exactly one owner and
  // ownership moves ONLY through the transfer endpoint — R-trips-9).
  // -------------------------------------------------------------------------
  router.patch(
    memberEndpoints.updateMemberRole.path,
    zValidator("json", memberEndpoints.updateMemberRole.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("owner"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const body = c.req.valid("json");
      const targetId = c.req.param("userId");

      // Malformed target id can't match any member → the same 404 an unknown
      // target gets (no malformed-vs-absent oracle; keeps the ::uuid cast safe).
      if (!targetId || !UUID_RE.test(targetId)) {
        return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      }

      const [target] = await deps.db
        .select({ role: schema.tripMembers.role })
        .from(schema.tripMembers)
        .where(
          and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.userId, targetId)),
        );
      if (!target) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      if (target.role === "owner") {
        return apiError(c, "VALIDATION_FAILED", "the owner's role moves only via transfer", {
          user_id: "is the owner",
        });
      }

      // `ne(role,'owner')` rides IN the predicate (not just the pre-check
      // above): under READ COMMITTED a concurrent transfer promoting this
      // target commits while we wait on its row lock, and EvalPlanQual
      // re-evaluates the WHERE against the NEW row version — without the
      // role guard the write would land on the NEW OWNER and demote them
      // (zero-owner strand, R-trips-9; T-6.2 round-1 blocking #1). With it,
      // the EPQ re-check misses → 0 rows → converge below.
      const [updated] = await deps.db
        .update(schema.tripMembers)
        .set({ role: body.role })
        .where(
          and(
            eq(schema.tripMembers.tripId, tripId),
            eq(schema.tripMembers.userId, targetId),
            ne(schema.tripMembers.role, "owner"),
          ),
        )
        .returning();
      // Raced a concurrent removal or promotion — converge (§3.5 rule 3).
      if (!updated) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      return c.json(toTripMemberWire(updated));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/members/:userId — remove (owner) or leave (self).
  // The owner can NEVER exit through this door (R-trips-11, Gate 2): with
  // other members present → 409 transfer-first; as sole member → 409 in
  // favor of the explicit DELETE /trips/:tripId (equivalent to deletion).
  // Financial history is untouched by construction — this handler writes
  // ONLY the membership row (R-trips-12).
  // -------------------------------------------------------------------------
  router.delete(memberEndpoints.removeMember.path, requireTripMember(), async (c) => {
    const { tripId, role: callerRole } = tripContextOf(c);
    const { userId: callerId } = authContextOf(c);
    const targetId = c.req.param("userId");

    if (!targetId || !UUID_RE.test(targetId)) {
      return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    }

    if (targetId === callerId) {
      // Leave. Owners transfer first — or delete the trip if they're alone.
      if (callerRole === "owner") {
        const hasOthers = await otherLiveMemberExists(tripId, callerId);
        return apiError(
          c,
          "CONFLICT",
          hasOthers
            ? "transfer ownership before leaving the trip"
            : "the sole member cannot leave — delete the trip instead",
          { reason: hasOthers ? "owner_transfer_required" : "delete_trip_instead" },
        );
      }
    } else if (callerRole !== "owner") {
      // Proven member removing someone else without owner role → 403 (safe:
      // membership already told them the trip exists).
      return apiError(c, "FORBIDDEN", "insufficient role");
    }

    // `ne(role,'owner')` in the DELETE predicate: no code path legitimately
    // deletes an owner row (owner exit is always the 409 above), so this is
    // pure EPQ armor — a transfer promoting the target that commits while we
    // wait on its row lock re-evaluates the WHERE against the NEW row
    // version; without the guard, B-leaves-while-A-transfers-to-B deletes
    // the freshly promoted owner and strands the trip owner-less
    // (R-trips-9; T-6.2 round-1 blocking #1). With it: 0 rows → 404.
    const deleted = await deps.db
      .delete(schema.tripMembers)
      .where(
        and(
          eq(schema.tripMembers.tripId, tripId),
          eq(schema.tripMembers.userId, targetId),
          ne(schema.tripMembers.role, "owner"),
        ),
      )
      .returning({ userId: schema.tripMembers.userId });
    // Unknown target (or a concurrent removal/promotion won) → converge on 404.
    if (deleted.length === 0) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/transfer-ownership — demote current owner to editor,
  // promote the (already-member, LIVE) target to owner, ONE transaction
  // (R-trips-10). Demote runs FIRST: `uq_trip_single_owner` is non-deferrable,
  // so promote-first would violate it mid-flight. Prod driver is the Neon WS
  // Pool — a real transaction (landmine #1).
  // -------------------------------------------------------------------------
  router.post(
    memberEndpoints.transferOwnership.path,
    zValidator("json", memberEndpoints.transferOwnership.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("owner"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId: callerId } = authContextOf(c);
      const { to_user_id: targetId } = c.req.valid("json");

      if (targetId === callerId) {
        return apiError(c, "VALIDATION_FAILED", "cannot transfer ownership to yourself", {
          to_user_id: "is the caller",
        });
      }

      const rows = await deps.db.transaction(async (tx) => {
        // Ordered membership fence FIRST (T-6.2 round-1 blocking #2): both
        // rows FOR UPDATE in user_id order before any write. The demote →
        // promote UPDATE sequence acquires in role order, which can invert
        // against other lockers' scan order (e.g. a trip-delete fence or the
        // RI cascade's multi-row members DELETE); a deterministic user_id
        // acquisition order removes the cycle. The fence also parks this
        // transfer behind any in-flight accept/removal touching these rows.
        await tx
          .select({ userId: schema.tripMembers.userId })
          .from(schema.tripMembers)
          .where(
            and(
              eq(schema.tripMembers.tripId, tripId),
              inArray(schema.tripMembers.userId, [callerId, targetId]),
            ),
          )
          .orderBy(schema.tripMembers.userId)
          .for("update");

        // Target must be a member AND live — a ghost cannot receive a
        // transfer (R-trips-10 requires a member who can still act; the
        // account-deletion sole-owner-ghost fix set this semantics). An
        // absent-or-ghost target is the same 404 (no live-ness oracle).
        const [target] = await tx
          .select({ userId: schema.tripMembers.userId })
          .from(schema.tripMembers)
          .innerJoin(
            schema.users,
            and(eq(schema.users.id, schema.tripMembers.userId), isNull(schema.users.deletedAt)),
          )
          .where(
            and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.userId, targetId)),
          );
        if (!target) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

        const [demoted] = await tx
          .update(schema.tripMembers)
          .set({ role: "editor" })
          .where(
            and(
              eq(schema.tripMembers.tripId, tripId),
              eq(schema.tripMembers.userId, callerId),
              eq(schema.tripMembers.role, "owner"),
            ),
          )
          .returning();
        // The gate proved ownership, so a miss means a concurrent membership
        // write won the race — conflict, nothing written.
        if (!demoted) {
          throw new HttpError("CONFLICT", "ownership changed concurrently", {
            reason: "ownership_changed",
          });
        }

        const [promoted] = await tx
          .update(schema.tripMembers)
          .set({ role: "owner" })
          .where(
            and(eq(schema.tripMembers.tripId, tripId), eq(schema.tripMembers.userId, targetId)),
          )
          .returning();
        // Target vanished mid-transaction (concurrent removal/deletion) —
        // roll back so the demote never lands alone (at-least-one owner).
        if (!promoted) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

        return [demoted, promoted];
      });

      return c.json({ items: rows.map(toTripMemberWire) });
    },
  );

  return router;
}
