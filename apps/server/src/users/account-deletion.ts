/**
 * Account deletion (T-5.6 / AU-8 — R-user-9, schema spec R-db-16 / §3.3.1 /
 * §3.3.5). Soft-delete + PII scrub, in ONE transaction on a
 * transaction-capable driver (Neon WebSocket `Pool` in prod, `postgres-js` in
 * tests — the Neon HTTP driver would throw, landmine #1). A partial deletion is
 * a privacy hole (Law #3), so every write here is atomic:
 *
 *   1. Sole-owner-trip guard — BEFORE any write. If the caller solely owns a
 *      trip that still has OTHER **live** members they must transfer ownership
 *      first (schema §3.3.5); we throw `OwnerTransferRequiredError` → the
 *      transaction rolls back → the route returns 409 having scrubbed NOTHING.
 *      Only LIVE members block (P-6/T-6.1 sole-owner-ghost fix): a soft-deleted
 *      co-member is not a valid transfer target (R-trips-10 requires a member
 *      who can still act), so counting ghosts would deadlock the owner's own
 *      deletion forever — 409 with nobody to transfer to.
 *   2. Trip-membership reconcile (P-6/T-6.1 carry-forward). After the guard,
 *      every trip the caller still OWNS has zero other live members — keeping
 *      such a trip would orphan it (the membership gate is its only door,
 *      R-trips-1, and no live member remains to pass it). Owned trips are
 *      deleted with the same cascade semantics as `DELETE /trips/:tripId`
 *      (R-trips-8 / schema §3.6). The caller's remaining (non-owner)
 *      memberships are removed — account deletion is their final "leave"
 *      (§3.2 "Leave trip": self) — while their expenses/shares/settlements
 *      survive untouched (R-trips-12: financial history references `users`
 *      rows, never membership rows) and render as "Deleted user" (R-db-16).
 *   3. Consume `apple_credentials` — decrypt the stored Apple refresh token for
 *      the caller (returned for post-commit revocation) and delete the row. The
 *      row is soft-delete-invisible: `apple_credentials` cascades on a *hard*
 *      user delete, but we never hard-delete, so it is dropped explicitly.
 *   4. Scrub the `users` row (schema §3.3.1 scrub list) + set `deleted_at`. The
 *      `users_identity_or_scrubbed_ck` CHECK holds because `deleted_at` is set
 *      as the subs go NULL.
 *   5. Revoke every session (kills all refresh-token families, R-auth-11) and
 *      delete every push token.
 *
 * Idempotent: an already-scrubbed account short-circuits to `already-deleted`
 * (the route answers 204 either way — deletion is inherently idempotent and the
 * spec lists no 404 for `DELETE /users/me`).
 *
 * Apple's network revocation runs in the ROUTE, AFTER commit and OUTSIDE this
 * transaction (R-user-9): a network failure must not roll back the deletion,
 * and a DB transaction must never straddle a third-party round-trip.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { decryptSecret } from "../auth/crypto.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";

/**
 * Thrown inside the deletion transaction when the caller still solely owns a
 * trip that has other members — the route maps it to 409 `CONFLICT` (R-user-9).
 * Thrown BEFORE any scrub write, so the rollback leaves the account intact.
 */
export class OwnerTransferRequiredError extends Error {
  constructor() {
    super("owner must transfer trip ownership before deleting the account");
    this.name = "OwnerTransferRequiredError";
  }
}

export type AccountDeletionResult =
  { status: "deleted"; appleRefreshToken: string | null } | { status: "already-deleted" };

export interface AccountDeletionDeps {
  db: DbClient;
  /** AES-256-GCM key decrypting the stored Apple refresh token (§3.3.3). */
  appleCredentialsKey: Buffer;
}

/**
 * The schema §3.3.1 scrub list — every PII column nulled/tombstoned and
 * `deleted_at` stamped, as one `.set(...)`. `email` becomes a per-id unique
 * tombstone so `lower(email)` uniqueness still holds; `prefs` resets to `{}`.
 */
function scrubValues(userId: string, now: Date): Partial<typeof schema.users.$inferInsert> {
  return {
    email: `deleted:${userId}`,
    displayName: "Deleted user",
    avatarKey: null,
    appleSub: null,
    googleSub: null,
    venmoUsername: null,
    cashtag: null,
    paypalmeUsername: null,
    zelleHandle: null,
    zelleDisplayName: null,
    forwardEmailSlug: null,
    prefs: {},
    deletedAt: now,
  };
}

export async function deleteAccount(
  deps: AccountDeletionDeps,
  userId: string,
  now: Date,
): Promise<AccountDeletionResult> {
  return deps.db.transaction(async (tx) => {
    // 0. Only a LIVE (non-scrubbed) account has anything to do. Re-deleting an
    //    already-scrubbed account (a repeat request within the ≤15-min access
    //    token window, R-auth-12) is an idempotent no-op — never a 409, since we
    //    must not re-run the owner guard against a ghost account.
    const [live] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
    if (!live) return { status: "already-deleted" };

    // 1. LOCK the caller's membership rows — `SELECT … FOR UPDATE` — before
    //    ANY membership read (P-6/T-6.2 fix; T-6.1 round-1 security defer).
    //    This snapshot is the ONE membership state both the guard (step 1a)
    //    and the reconcile (step 1b) operate on; without it, a membership
    //    write committing between guard-read and cascade-delete destroys the
    //    writer's work — concretely:
    //      • transfer-ownership UPDATEs these very rows (demote/promote) →
    //        it now blocks on the lock and serializes either side of us;
    //      • invite-accept takes FOR SHARE on the trip's OWNER row (this
    //        caller's row, invites-routes.ts) before inserting a member → an
    //        in-flight accept makes our lock WAIT and the guard then SEES the
    //        new member (409 transfer-first); an accept arriving after us
    //        blocks, then finds the invite cascade-deleted (404). The
    //        "acceptance committing between guard SELECT and cascade delete
    //        destroys the new member's trip" window is closed.
    //    Lock order is GLOBAL (membership rows → invite rows via the trips
    //    cascade) and matches the accept path — no deadlock cycle.
    const lockedMemberships = await tx
      .select({ tripId: schema.tripMembers.tripId, role: schema.tripMembers.role })
      .from(schema.tripMembers)
      .where(eq(schema.tripMembers.userId, userId))
      .for("update");
    const ownedTripIds = lockedMemberships
      .filter((membership) => membership.role === "owner")
      .map((membership) => membership.tripId);

    // 1a. Sole-owner-trip guard (R-user-9 / schema §3.3.5). `uq_trip_single_
    //     owner` guarantees at most one owner per trip, so a caller `role =
    //     'owner'` row IS the sole owner — block iff any owned trip has ≥1
    //     OTHER **live** member. Ghost members (soft-deleted accounts) never
    //     block: they cannot receive a transfer, so counting them would
    //     deadlock this deletion permanently (P-6/T-6.1 sole-owner-ghost
    //     fix). Throw BEFORE any write so the rollback scrubs nothing.
    if (ownedTripIds.length > 0) {
      const blocking = await tx
        .select({ tripId: schema.tripMembers.tripId })
        .from(schema.tripMembers)
        .innerJoin(
          schema.users,
          and(eq(schema.users.id, schema.tripMembers.userId), isNull(schema.users.deletedAt)),
        )
        .where(
          and(
            inArray(schema.tripMembers.tripId, ownedTripIds),
            ne(schema.tripMembers.userId, userId),
          ),
        )
        .limit(1);
      if (blocking.length > 0) throw new OwnerTransferRequiredError();
    }

    // 1b. Trip-membership reconcile (P-6/T-6.1 carry-forward; see module doc
    //     step 2). The guard just proved every owned trip has no other live
    //     member — delete those trips outright (children cascade per schema
    //     §3.6, exactly as DELETE /trips/:tripId would, R-trips-8) so no trip
    //     is left orphaned behind an unreachable membership gate. Then drop
    //     the caller's remaining (non-owner) membership rows — the final
    //     "leave" (§3.2) — leaving all financial history intact (R-trips-12).
    //     Both writes consume the step-1 LOCKED snapshot (`ownedTripIds` is
    //     the materialized list, not a re-read) — guard and reconcile cannot
    //     disagree about which trips the caller owns.
    if (ownedTripIds.length > 0) {
      await tx.delete(schema.trips).where(inArray(schema.trips.id, ownedTripIds));
    }
    await tx.delete(schema.tripMembers).where(eq(schema.tripMembers.userId, userId));

    // FUTURE (P-11 capture / utilities documents): capture_senders, capture_inbox,
    // documents use ON DELETE CASCADE on user_id, but soft-delete NEVER fires the
    // cascade — when those features land, this transaction MUST explicitly purge
    // their rows or the "deleted" account's PII survives. See QUEUE. (Same reason
    // apple_credentials/push_tokens below are dropped explicitly, not by cascade.)

    // 3. Consume apple_credentials — decrypt for post-commit revocation, then
    //    drop the row (never left behind for a scrubbed account). A corrupt /
    //    undecryptable ciphertext must NOT block the deletion: we simply can't
    //    revoke what we can't decrypt (the local scrub remains authoritative).
    const [cred] = await tx
      .select({ ciphertext: schema.appleCredentials.refreshTokenCiphertext })
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.userId, userId));
    let appleRefreshToken: string | null = null;
    if (cred) {
      try {
        appleRefreshToken = decryptSecret(deps.appleCredentialsKey, cred.ciphertext);
      } catch {
        appleRefreshToken = null;
      }
      await tx.delete(schema.appleCredentials).where(eq(schema.appleCredentials.userId, userId));
    }

    // 4. Scrub the user row (PII → null/tombstone, deleted_at set). The
    //    `isNull(deletedAt)` predicate keeps this write single-shot even under a
    //    concurrent duplicate request.
    await tx
      .update(schema.users)
      .set(scrubValues(userId, now))
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));

    // 5. Revoke every live session (family kill for all refresh tokens,
    //    R-auth-11) and delete every push token. Also null `device_name` — a
    //    deletion-time erasure of client-supplied data (e.g. "Sean's iPhone
    //    17"), slightly beyond the §3.3.1 scrub list, so no identifying label
    //    lingers on the revoked rows until the 90-day prune (§3.3.2).
    await tx
      .update(schema.authSessions)
      .set({ revokedAt: now, deviceName: null })
      .where(and(eq(schema.authSessions.userId, userId), isNull(schema.authSessions.revokedAt)));
    await tx.delete(schema.pushTokens).where(eq(schema.pushTokens.userId, userId));

    return { status: "deleted", appleRefreshToken };
  });
}
