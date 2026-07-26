/**
 * Invites lifecycle routes (T-6.2 / API-TRIPS-3): trip-scoped
 * create/list/revoke (`/trips/:tripId/invites*`) + capability-addressed
 * token preview/accept (`/invites/:token*`) — trips spec §3.3. Covers
 * R-trips-13..17.
 *
 * AUTHZ POSTURE: trip-scoped routes sit behind `requireTripMember("editor")`
 * (§3.2: create/view/revoke are owner/editor; viewers 403, non-members get
 * the indistinguishable 404 — F-038). The token routes are the spec'd
 * EXCEPTION: the token IS the capability — any authenticated holder may
 * preview/accept; unknown AND malformed tokens share one 404 door, and both
 * routes charge the token-guessing rate limit (defense-in-depth; entropy is
 * the primary defense, R-db-9).
 *
 * ACCEPT CONCURRENCY (R-trips-14, T-5.6 TOCTOU carry-forward): the whole
 * acceptance runs in ONE transaction on the transaction-capable driver
 * (landmine #1) with a fixed LOCK ORDER — (1) the trip's owner membership
 * row `FOR SHARE`, then (2) the invite row `FOR UPDATE`:
 *
 *  - The invite-row `FOR UPDATE` serializes racing accepts on the same
 *    token: the loser blocks, then re-observes the winner's committed
 *    `use_count` — it can never exceed `max_uses` (§4 race test).
 *  - The owner-row `FOR SHARE` is the account-deletion sync point: deletion
 *    locks the caller's membership rows `FOR UPDATE` before its sole-owner
 *    guard (users/account-deletion.ts), so an in-flight accept (holding FOR
 *    SHARE) forces deletion to wait and then SEE the new member (409
 *    transfer-first), while an accept arriving after deletion's lock blocks
 *    and then finds the invite cascade-deleted (404). Without this, an
 *    acceptance committing between deletion's guard SELECT and its cascade
 *    would be destroyed with the trip (T-6.1 round-1 security defer).
 *  - The caller-liveness `FOR SHARE` on the caller's own users row (taken
 *    FIRST, before the membership lock) closes the self-deletion door: a
 *    scrubbed caller's still-valid (≤15 min) access token cannot mint a
 *    ghost membership — the accept either serializes before the deletion
 *    (whose later membership sweep then sees the row) or observes
 *    `deleted_at` set and dies 401 (pairs with account-deletion's step-0
 *    users-row FOR UPDATE).
 *  - Lock ORDER is GLOBAL: users(caller) → trip_members → invites — every
 *    explicit locker follows it. The trips RI CASCADE does NOT (Postgres
 *    fires FK triggers in creation order, and 0000 creates the invites FK
 *    before the trip_members FK, so a cascade exclusive-locks invite rows
 *    BEFORE member rows). Deadlock safety therefore rests on the FENCE
 *    rule, not on cascade order: every path that deletes a trip (the trips
 *    DELETE route, account-deletion's reconcile) first takes FOR UPDATE on
 *    the trip's membership rows, so by cascade time no other transaction
 *    holds trip-scoped row locks. The FK-creation-order dependency is
 *    explicit here so a future migration reordering FKs doesn't silently
 *    change the analysis — the fence holds either way.
 *
 * Push events (invite.created / invite.revoked / member.added — §3.5) are
 * T-6.3's post-commit emitter seam — deliberately not emitted here yet.
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  inviteEndpoints,
  type InviteAccept,
  type InviteState,
} from "@gogo/shared/domains/member";
import type { Paginated } from "@gogo/shared/api/envelope";
import type { InviteListItem } from "@gogo/shared/domains/member";
import {
  INVITE_DEFAULT_TTL_MS,
  INVITES_PAGE_SIZE,
  RATE_LIMITS,
  TRIP_ROLE_RANK,
} from "../config.js";
import * as schema from "../db/schema/index.js";
import {
  apiError,
  HttpError,
  NOT_FOUND_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
  type RequestVars,
} from "../http/errors.js";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  epochMicrosExpr,
  keysetCursorPredicate,
} from "../http/keyset-cursor.js";
import { clientIp, rateLimit } from "../http/rate-limit.js";
import { authContextOf } from "../http/require-auth.js";
import {
  createRequireTripMember,
  tripContextOf,
  UUID_RE,
} from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import { generateInviteToken, INVITE_TOKEN_RE, inviteState } from "./invite-token.js";
import type { TripsRouterDeps } from "./routes.js";
import { toInviteListItemWire, toInvitePreviewWire, toInviteWithUrlWire } from "./serialize.js";

/** Dead-state → `details.reason` — the R-trips-16 value set, verbatim. */
const DEAD_STATE_MESSAGES: Record<Exclude<InviteState, "active">, string> = {
  expired: "this invite has expired",
  revoked: "this invite was revoked",
  max_uses_reached: "this invite has reached its maximum uses",
};

export function createInvitesRouter(deps: TripsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const nowOf = () => (deps.now ? deps.now() : new Date());
  const requireTripMember = createRequireTripMember({ db: deps.db });

  // ---- token-guessing rate limit (§3.3; real limiter iff wired) -----------
  const passThrough = createMiddleware<RequestVars>(async (_c, next) => {
    await next();
  });
  const rl = deps.rateLimit;
  const rlDeps = rl ? { store: rl.store, ...(rl.now ? { now: rl.now } : {}) } : undefined;
  const tokenLimiter = rlDeps
    ? rateLimit(
        [
          {
            name: "invite-token-user",
            limit: RATE_LIMITS.inviteTokenPerUser.limit,
            windowMs: RATE_LIMITS.inviteTokenPerUser.windowMs,
            keyOf: (c) => c.get("auth")?.userId ?? null,
          },
          {
            name: "invite-token-ip",
            limit: RATE_LIMITS.inviteTokenPerIp.limit,
            windowMs: RATE_LIMITS.inviteTokenPerIp.windowMs,
            keyOf: clientIp,
          },
        ],
        rlDeps,
      )
    : passThrough;

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/invites — owner/editor create a shareable multi-use
  // link (R-trips-13). `role: 'owner'` is unrepresentable in the shared body
  // schema (mirrors the DB CHECK); the ≤-own-role guard cannot fire with the
  // current two grantable roles but exists for enum growth (§3.3).
  // -------------------------------------------------------------------------
  router.post(
    inviteEndpoints.createInvite.path,
    zValidator("json", inviteEndpoints.createInvite.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId, role } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");

      if (TRIP_ROLE_RANK[body.role] > TRIP_ROLE_RANK[role]) {
        return apiError(c, "FORBIDDEN", "cannot grant a role above your own");
      }

      const [inserted] = await deps.db
        .insert(schema.invites)
        .values({
          tripId,
          token: generateInviteToken(),
          role: body.role,
          createdBy: userId,
          expiresAt: body.expires_at
            ? new Date(body.expires_at)
            : new Date(nowOf().getTime() + INVITE_DEFAULT_TTL_MS),
          ...(body.max_uses !== undefined ? { maxUses: body.max_uses } : {}),
        })
        .returning();
      if (!inserted) throw new HttpError("INTERNAL", "invite insert returned no row");

      return c.json(toInviteWithUrlWire(inserted), 201);
    },
  );

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/invites — active AND dead invites, flagged with the
  // computed `state` (§3.3). Keyset-paginated (created_at DESC, id DESC) via
  // the shared cursor helper; malformed cursors fall back to page 1.
  // -------------------------------------------------------------------------
  router.get(
    inviteEndpoints.listInvites.path,
    zValidator("query", inviteEndpoints.listInvites.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { cursor } = c.req.valid("query");
      const decoded = cursor ? decodeKeysetCursor(cursor) : null;
      const now = nowOf();

      const predicates: SQL[] = [eq(schema.invites.tripId, tripId)];
      if (decoded) {
        predicates.push(
          keysetCursorPredicate(schema.invites.createdAt, schema.invites.id, decoded),
        );
      }

      // pageSize + 1 sentinel: know whether a next page exists without ever
      // minting a cursor that dereferences to an empty page.
      const rows = await deps.db
        .select({ invite: schema.invites, cursorMicros: epochMicrosExpr(schema.invites.createdAt) })
        .from(schema.invites)
        .where(and(...predicates))
        .orderBy(sql`${schema.invites.createdAt} DESC, ${schema.invites.id} DESC`)
        .limit(INVITES_PAGE_SIZE + 1);

      const page = rows.slice(0, INVITES_PAGE_SIZE);
      const items = page.map((row) =>
        toInviteListItemWire(row.invite, inviteState(row.invite, now)),
      );

      const last = page[page.length - 1];
      const nextCursor =
        rows.length > INVITES_PAGE_SIZE && last
          ? encodeKeysetCursor({ micros: last.cursorMicros, id: last.invite.id })
          : null;

      const body: Paginated<InviteListItem> = { items, nextCursor };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/invites/:inviteId — revoke: sets `revoked_at`, the
  // row persists (R-trips-17; rows are never deleted as a revocation path).
  // Owner revokes any; editor only their own. Already-revoked → 409.
  // -------------------------------------------------------------------------
  router.delete(inviteEndpoints.revokeInvite.path, requireTripMember("editor"), async (c) => {
    const { tripId, role } = tripContextOf(c);
    const { userId } = authContextOf(c);
    const inviteId = c.req.param("inviteId");

    // Malformed id can't match any invite → the same 404 an unknown one gets.
    if (!inviteId || !UUID_RE.test(inviteId)) {
      return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    }

    // Trip-scoped lookup: an invite id from ANOTHER trip is unknown here —
    // the gate's trip is the only world this route can see (IDOR posture).
    const [invite] = await deps.db
      .select()
      .from(schema.invites)
      .where(and(eq(schema.invites.id, inviteId), eq(schema.invites.tripId, tripId)));
    if (!invite) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    if (role !== "owner" && invite.createdBy !== userId) {
      return apiError(c, "FORBIDDEN", "editors may revoke only their own invites");
    }
    if (invite.revokedAt !== null) {
      return apiError(c, "CONFLICT", "this invite was already revoked", {
        reason: "already_revoked",
      });
    }

    // Guarded write: a racing revoke matches zero rows → converge on 409.
    const updated = await deps.db
      .update(schema.invites)
      .set({ revokedAt: nowOf() })
      .where(and(eq(schema.invites.id, inviteId), isNull(schema.invites.revokedAt)))
      .returning({ id: schema.invites.id });
    if (updated.length === 0) {
      return apiError(c, "CONFLICT", "this invite was already revoked", {
        reason: "already_revoked",
      });
    }

    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /invites/:token — the join-screen preview (R-trips-16). The token is
  // the capability: any authenticated holder previews, INCLUDING dead states
  // (200 with `state`; the client renders distinct error states, R-nav-11).
  // Payload deliberately excludes trip_id and all trip content (§3.3).
  // -------------------------------------------------------------------------
  router.get(inviteEndpoints.previewInvite.path, tokenLimiter, async (c) => {
    const token = c.req.param("token");
    if (!token || !INVITE_TOKEN_RE.test(token)) {
      return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    }

    const [row] = await deps.db
      .select({ invite: schema.invites, trip: schema.trips, inviter: schema.users })
      .from(schema.invites)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.invites.tripId))
      // Plain join, not live-filtered: a scrubbed inviter row renders as
      // "Deleted user" (R-db-16) — the invite stays previewable.
      .innerJoin(schema.users, eq(schema.users.id, schema.invites.createdBy))
      .where(eq(schema.invites.token, token));
    if (!row) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const { userId } = authContextOf(c);
    const [membership] = await deps.db
      .select({ userId: schema.tripMembers.userId })
      .from(schema.tripMembers)
      .where(
        and(
          eq(schema.tripMembers.tripId, row.invite.tripId),
          eq(schema.tripMembers.userId, userId),
        ),
      );

    return c.json(
      toInvitePreviewWire(
        row.invite,
        row.trip,
        row.inviter,
        inviteState(row.invite, nowOf()),
        membership !== undefined,
      ),
    );
  });

  // -------------------------------------------------------------------------
  // POST /invites/:token/accept — become a member (R-trips-14/15/16). ONE
  // race-safe transaction; see the module doc for the lock-order design.
  //
  // Check order inside the lock: existing-membership BEFORE dead-state —
  // R-trips-15 is unconditional ("an existing member accepts ... return their
  // current membership unchanged"), and the everyday case demands it: the
  // member who consumed a max_uses:1 link re-taps it and must land on their
  // trip (200 already_member), not a 409 for the exhaustion THEY caused. The
  // preview's `already_member` field exists to render exactly that state.
  // -------------------------------------------------------------------------
  router.post(inviteEndpoints.acceptInvite.path, tokenLimiter, async (c) => {
    const token = c.req.param("token");
    if (!token || !INVITE_TOKEN_RE.test(token)) {
      return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    }
    const { userId } = authContextOf(c);
    const now = nowOf();

    const result = await deps.db.transaction(async (tx) => {
      // 1. Unlocked probe — learn the trip so locks can be taken in the
      //    global order (users row, then membership row, then invite row).
      const [probe] = await tx
        .select({ id: schema.invites.id, tripId: schema.invites.tripId })
        .from(schema.invites)
        .where(eq(schema.invites.token, token));
      if (!probe) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

      // 2. Caller liveness under lock — FIRST lock acquisition (global order:
      //    users → trip_members → invites). FOR SHARE on the caller's own
      //    users row, live only: a scrubbed account's still-valid (≤15 min)
      //    access token must not mint a ghost membership. Account deletion
      //    takes this row FOR UPDATE at its step 0, so an in-flight deletion
      //    blocks us until it commits (→ this re-check sees deleted_at → 401)
      //    and our held FOR SHARE blocks a deletion from starting until this
      //    accept commits (→ its membership sweep sees the new row). Absent
      //    row = same 401 (the principal no longer exists; one message, no
      //    oracle — T-6.2 round-1 advisory #3).
      const [liveCaller] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
        .for("share");
      if (!liveCaller) throw new HttpError("UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);

      // 3. FOR SHARE on the trip's owner membership row — the account-deletion
      //    sync point (module doc). Shareable, so concurrent accepts on the
      //    same trip don't serialize HERE (the invite lock below does that
      //    where it matters); conflicts only with FOR UPDATE/deletes.
      await tx
        .select({ userId: schema.tripMembers.userId })
        .from(schema.tripMembers)
        .where(
          and(
            eq(schema.tripMembers.tripId, probe.tripId),
            eq(schema.tripMembers.role, "owner"),
          ),
        )
        .for("share");

      // 4. FOR UPDATE re-read of the invite — the authoritative state. The
      //    row may have died between probe and lock (trip/account deletion
      //    cascade) → same unknown-token 404. A racing accept blocks here and
      //    re-observes the winner's committed use_count (READ COMMITTED
      //    lock-then-reevaluate) — use_count can never exceed max_uses.
      const [invite] = await tx
        .select()
        .from(schema.invites)
        .where(eq(schema.invites.id, probe.id))
        .for("update");
      if (!invite) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

      // 5. Existing member → idempotent 200, membership unchanged (even if
      //    the invite grants a higher role), NO use_count increment
      //    (R-trips-15; ordering rationale in the route doc).
      const [existing] = await tx
        .select()
        .from(schema.tripMembers)
        .where(
          and(
            eq(schema.tripMembers.tripId, invite.tripId),
            eq(schema.tripMembers.userId, userId),
          ),
        );
      if (existing) return { membership: existing, alreadyMember: true };

      // 6. Dead invite → 409 with the R-trips-16 reason, nothing written.
      const state = inviteState(invite, now);
      if (state !== "active") {
        throw new HttpError("CONFLICT", DEAD_STATE_MESSAGES[state], { reason: state });
      }

      // 7. Insert the membership. A same-user accept racing through a
      //    DIFFERENT invite can win the PK between step 5 and here —
      //    onConflictDoNothing folds that into the already-member answer
      //    instead of a unique-violation 500.
      const [inserted] = await tx
        .insert(schema.tripMembers)
        .values({ tripId: invite.tripId, userId, role: invite.role })
        .onConflictDoNothing({ target: [schema.tripMembers.tripId, schema.tripMembers.userId] })
        .returning();
      if (!inserted) {
        const [raced] = await tx
          .select()
          .from(schema.tripMembers)
          .where(
            and(
              eq(schema.tripMembers.tripId, invite.tripId),
              eq(schema.tripMembers.userId, userId),
            ),
          );
        if (!raced) throw new HttpError("INTERNAL", "membership upsert returned no row");
        return { membership: raced, alreadyMember: true };
      }

      // 8. Charge the use. Plain arithmetic is race-safe HERE because the
      //    FOR UPDATE lock (step 4) made this transaction the only writer of
      //    the row until commit.
      await tx
        .update(schema.invites)
        .set({ useCount: invite.useCount + 1 })
        .where(eq(schema.invites.id, invite.id));

      return { membership: inserted, alreadyMember: false };
    });

    const body: InviteAccept = {
      trip_id: result.membership.tripId,
      role: result.membership.role,
      joined_at: result.membership.joinedAt.toISOString(),
      already_member: result.alreadyMember,
    };
    return c.json(body);
  });

  return router;
}
