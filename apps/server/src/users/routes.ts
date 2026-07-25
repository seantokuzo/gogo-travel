/**
 * Users & entitlements routes (T-5.5 / AU-6 + AU-7): `GET|PATCH /users/me`,
 * `POST /users/me/avatar-upload`, `PATCH /users/me/payment-handles`,
 * `GET /users/me/entitlements`, `POST /users/me/push-tokens`,
 * `DELETE /users/me/push-tokens/:pushTokenId`, `GET /users/:userId` —
 * auth-users spec §3.4.2/§3.4.3, wire shapes from `@gogo/shared` only.
 *
 * AUTHZ POSTURE (R-user-1..8): every `/users/me/*` route addresses the
 * token's `sub` exclusively — there is NO client-supplied user id on any
 * write path, so cross-user mutation is unrepresentable. The one
 * parameterized read (`GET /users/:userId`) is gated by shared-trip
 * membership with a 404 indistinguishable from a nonexistent user
 * (R-user-4, IDOR posture). Runs behind the app-wide `requireAuth`
 * (R-authz-1); order per R-authz-4: auth → validation → ownership-by-
 * construction → handler.
 *
 * `DELETE /users/me` (R-user-9) is AU-8's — deliberately absent here.
 *
 * Route registration order matters: the static `/users/me` tree registers
 * BEFORE `/users/:userId` so "me" always resolves to the caller's own
 * routes, never to the param route.
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  AVATAR_MAX_BYTES,
  userEndpoints,
  type AvatarUploadTicket,
} from "@gogo/shared/domains/user";
import { entitlementEndpoints } from "@gogo/shared/domains/entitlement";
import { resolveEntitlements } from "@gogo/shared/config/entitlements";
import { AVATAR_TICKET_TTL_SECONDS, RATE_LIMITS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import {
  apiError,
  HttpError,
  NOT_FOUND_MESSAGE,
  requestIdOf,
  type RequestVars,
} from "../http/errors.js";
import { rateLimit, type RateLimitStore } from "../http/rate-limit.js";
import { authContextOf } from "../http/require-auth.js";
import { rejectInvalidBody } from "../http/validation.js";
import { toUserWire } from "../auth/serialize.js";
import type { AppleTokenRevoker } from "../auth/apple-revoke.js";
import { mintAvatarKey, parseAvatarKey, type ObjectStorage } from "../storage/object-storage.js";
import {
  deleteAccount,
  OwnerTransferRequiredError,
  type AccountDeletionResult,
} from "./account-deletion.js";
import type { CashtagChecker } from "./cashtag.js";
import { toPaymentHandlesWire, toPushTokenWire, toUserProfileWire } from "./serialize.js";

export interface UsersLogger {
  warn(message: string): void;
}

/**
 * User-keyed rate-limit wiring (§3.6.3 rows `avatarUpload`/`paymentHandles`).
 * Absent = limiting OFF (suites asserting other behavior stay clean); prod
 * wiring always supplies it. Windows key on the authenticated user id — the
 * app-wide `requireAuth` has already run, so the key is never absent on a
 * charged request.
 */
export interface UsersRateLimitConfig {
  store: RateLimitStore;
  /** Store clock, MILLISECONDS. */
  now?: () => number;
}

export interface UsersRouterDeps {
  db: DbClient;
  /** The §3.7 presign port — the ONLY storage dependency (R-user-3). */
  storage: ObjectStorage;
  /** R-user-6 seam — prod HEADs cash.app, tests inject fakes. */
  cashtagChecker: CashtagChecker;
  /**
   * R-user-9 seam — Apple token revocation at account deletion. Prod hits
   * Apple's REST endpoint, tests inject a fake; a revocation failure never
   * blocks the (already-committed) deletion.
   */
  appleRevoker: AppleTokenRevoker;
  /** AES-256-GCM key decrypting the stored Apple refresh token (§3.3.3, R-user-9). */
  appleCredentialsKey: Buffer;
  logger?: UsersLogger;
  /** Rate limiting for avatar-upload + payment-handles + account deletion. Absent = off. */
  rateLimit?: UsersRateLimitConfig;
  /** Clock seam for tests. */
  now?: () => Date;
}

type UsersContext = Context<RequestVars>;

/**
 * ONE uniform 400 for every avatar_key commit failure — foreign namespace,
 * never-issued key, and missing object are indistinguishable (R-user-3; no
 * oracle for which check failed, mirroring §3.6.4 posture).
 */
const AVATAR_KEY_REJECTION = "avatar_key was not issued to this user";

export function createUsersRouter(deps: UsersRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();

  const nowOf = () => (deps.now ? deps.now() : new Date());

  // ---- rate limiters (user-keyed; §3.6.3) ---------------------------------
  const userKey = (c: UsersContext) => c.get("auth")?.userId ?? null;
  const passThrough = createMiddleware<RequestVars>(async (_c, next) => {
    await next();
  });
  const rl = deps.rateLimit;
  const rlDeps = rl ? { store: rl.store, ...(rl.now ? { now: rl.now } : {}) } : undefined;
  const avatarLimiter = rlDeps
    ? rateLimit(
        [
          {
            name: "avatar-upload",
            limit: RATE_LIMITS.avatarUpload.limit,
            windowMs: RATE_LIMITS.avatarUpload.windowMs,
            keyOf: userKey,
          },
        ],
        rlDeps,
      )
    : passThrough;
  const handlesLimiter = rlDeps
    ? rateLimit(
        [
          {
            name: "payment-handles",
            limit: RATE_LIMITS.paymentHandles.limit,
            windowMs: RATE_LIMITS.paymentHandles.windowMs,
            keyOf: userKey,
          },
        ],
        rlDeps,
      )
    : passThrough;
  const deleteAccountLimiter = rlDeps
    ? rateLimit(
        [
          {
            name: "delete-account",
            limit: RATE_LIMITS.deleteAccount.limit,
            windowMs: RATE_LIMITS.deleteAccount.windowMs,
            keyOf: userKey,
          },
        ],
        rlDeps,
      )
    : passThrough;

  /** The caller's own live (non-scrubbed) `users` row, or null. */
  async function ownUserRow(userId: string) {
    const [row] = await deps.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // GET /users/me — the caller's full profile (R-user-1). No parameterization
  // exists to reach another principal's `User`.
  // -------------------------------------------------------------------------
  router.get(userEndpoints.getMe.path, async (c) => {
    const { userId } = authContextOf(c);
    const row = await ownUserRow(userId);
    if (!row) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    return c.json(toUserWire(row));
  });

  // -------------------------------------------------------------------------
  // PATCH /users/me — display_name / prefs / avatar_key ONLY (R-user-2);
  // unknown keys (email, subs, slug) are stripped by the shared schema and can
  // never reach this handler. avatar_key commits are namespace + existence
  // checked (R-user-3).
  // -------------------------------------------------------------------------
  router.patch(
    userEndpoints.updateMe.path,
    zValidator("json", userEndpoints.updateMe.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");

      if (typeof body.avatar_key === "string") {
        const parsed = parseAvatarKey(body.avatar_key);
        const ownNamespace =
          parsed !== null && parsed.userId.toLowerCase() === userId.toLowerCase();
        // Order matters: namespace first, storage lookup only for keys already
        // proven to be in the caller's own namespace (no probing foreign keys
        // against storage).
        if (!ownNamespace || !(await deps.storage.objectExists(body.avatar_key))) {
          return apiError(c, "VALIDATION_FAILED", AVATAR_KEY_REJECTION, {
            avatar_key: "invalid",
          });
        }
      }

      const set: Partial<typeof schema.users.$inferInsert> = {};
      if (body.display_name !== undefined) set.displayName = body.display_name;
      if (body.prefs !== undefined) set.prefs = body.prefs; // whole-object replace (R-user-2)
      if (body.avatar_key !== undefined) set.avatarKey = body.avatar_key;

      if (Object.keys(set).length === 0) {
        // Empty patch — a no-op that returns the current profile.
        const row = await ownUserRow(userId);
        if (!row) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
        return c.json(toUserWire(row));
      }

      const [updated] = await deps.db
        .update(schema.users)
        .set(set)
        .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
        .returning();
      if (!updated) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      return c.json(toUserWire(updated));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /users/me — account deletion (R-user-9). Rate-limited 3/day/user.
  // Owner-scoped by construction (the token's `sub`, no parameterization). The
  // whole DB effect (sole-owner guard → PII scrub + deleted_at → session revoke
  // → push-token delete → apple_credentials consume) is ONE transaction
  // (account-deletion.ts); Apple's network revocation runs AFTER commit so its
  // failure can't roll back the deletion (R-user-9 / R-db-16).
  // -------------------------------------------------------------------------
  router.delete(userEndpoints.deleteMe.path, deleteAccountLimiter, async (c) => {
    const { userId } = authContextOf(c);

    let result: AccountDeletionResult;
    try {
      result = await deleteAccount(
        { db: deps.db, appleCredentialsKey: deps.appleCredentialsKey },
        userId,
        nowOf(),
      );
    } catch (error) {
      // Sole owner of a trip with other members → transfer first (409). The
      // transaction already rolled back, so nothing was revoked or scrubbed.
      if (error instanceof OwnerTransferRequiredError) {
        return apiError(c, "CONFLICT", error.message, { reason: "owner_transfer_required" });
      }
      throw error;
    }

    // Apple revocation is best-effort and OUTSIDE the committed transaction: a
    // non-2xx / network failure is logged (reason only, never token material)
    // and the deletion STANDS — the local scrub is the source of truth, and the
    // App Store account-deletion mandate is satisfied by it (R-user-9 / R-db-16).
    if (result.status === "deleted" && result.appleRefreshToken !== null) {
      try {
        await deps.appleRevoker.revoke(result.appleRefreshToken);
      } catch (error) {
        const reason = error instanceof Error ? error.name : "unknown";
        deps.logger?.warn(
          `[users] apple token revoke failed — account already deleted (requestId=${requestIdOf(c)}, reason=${reason})`,
        );
      }
    }

    // Idempotent: a live account is scrubbed; an already-scrubbed one is a
    // no-op. Either way the account is gone — 204 (the spec lists no 404 here).
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // POST /users/me/avatar-upload — presign ticket via the ObjectStorage port
  // (R-user-3). Rate-limited per user (presign farming). Key is minted fresh
  // in the caller's namespace; the commit-side check closes the loop.
  // -------------------------------------------------------------------------
  router.post(
    userEndpoints.requestAvatarUpload.path,
    avatarLimiter,
    zValidator("json", userEndpoints.requestAvatarUpload.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");

      // Schema-valid (positive int) but oversized is its own status: 413
      // (spec §3.4.2), distinct from the 400 a disallowed content type gets.
      if (body.byte_size > AVATAR_MAX_BYTES) {
        return apiError(c, "PAYLOAD_TOO_LARGE", "avatar exceeds the size limit", {
          max_bytes: AVATAR_MAX_BYTES,
        });
      }

      const key = mintAvatarKey(userId);
      const presigned = await deps.storage.createPresignedUpload(
        key,
        body.content_type,
        body.byte_size,
        AVATAR_TICKET_TTL_SECONDS,
      );
      const ticket: AvatarUploadTicket = {
        upload_url: presigned.url,
        method: "PUT",
        headers: presigned.headers,
        storage_key: key,
        expires_at: new Date(nowOf().getTime() + AVATAR_TICKET_TTL_SECONDS * 1000).toISOString(),
      };
      return c.json(ticket);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /users/me/payment-handles — normalize-then-validate rails (shared
  // schema), MERGED-row zelle pairing, cashtag HEAD check fail-open
  // (R-user-5/6/7). Rate-limited per user (bounds outbound HEADs).
  // -------------------------------------------------------------------------
  router.patch(
    userEndpoints.updatePaymentHandles.path,
    handlesLimiter,
    zValidator("json", userEndpoints.updatePaymentHandles.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");

      const current = await ownUserRow(userId);
      if (!current) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      // The shared schema's zelle rule only sees THIS payload; the pairing
      // invariant holds on the MERGED row (stored ∘ patch) — e.g. a patch of
      // `{ zelle_display_name: null }` must not strand a stored handle
      // (schema NOTE, R-user-5).
      const mergedZelleHandle =
        body.zelle_handle !== undefined ? body.zelle_handle : current.zelleHandle;
      const mergedZelleName =
        body.zelle_display_name !== undefined ? body.zelle_display_name : current.zelleDisplayName;
      if (mergedZelleHandle !== null && mergedZelleName === null) {
        return apiError(
          c,
          "VALIDATION_FAILED",
          "zelle_display_name is required while zelle_handle is set",
          { zelle_display_name: "required" },
        );
      }

      // Cashtag existence check (R-user-6) — only when a cashtag is being SET.
      // "not_found" rejects; anything else (including a throwing checker) is
      // fail-open: the save must never depend on cash.app's uptime.
      if (typeof body.cashtag === "string") {
        let verdict: "ok" | "not_found" = "ok";
        try {
          verdict = await deps.cashtagChecker.check(body.cashtag);
        } catch {
          verdict = "ok";
        }
        if (verdict === "not_found") {
          return apiError(c, "VALIDATION_FAILED", "cashtag does not exist", {
            cashtag: "not_found",
          });
        }
      }

      const set: Partial<typeof schema.users.$inferInsert> = {};
      if (body.venmo_username !== undefined) set.venmoUsername = body.venmo_username;
      if (body.cashtag !== undefined) set.cashtag = body.cashtag;
      if (body.paypalme_username !== undefined) set.paypalmeUsername = body.paypalme_username;
      if (body.zelle_handle !== undefined) set.zelleHandle = body.zelle_handle;
      if (body.zelle_display_name !== undefined) set.zelleDisplayName = body.zelle_display_name;

      if (Object.keys(set).length === 0) {
        return c.json(toPaymentHandlesWire(current));
      }

      const [updated] = await deps.db
        .update(schema.users)
        .set(set)
        .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
        .returning();
      if (!updated) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      return c.json(toPaymentHandlesWire(updated));
    },
  );

  // -------------------------------------------------------------------------
  // GET /users/me/entitlements — effective entitlements via the ONLY
  // resolution path (R-ent-1, R-shared-12). A missing row is impossible for a
  // live account (created with it, R-db-5) — default to plan `free` so a data
  // anomaly fails safe, mirroring `requireAiQuota`.
  // -------------------------------------------------------------------------
  router.get(entitlementEndpoints.getMyEntitlements.path, async (c) => {
    const { userId } = authContextOf(c);
    const [entRow] = await deps.db
      .select({ plan: schema.entitlements.plan, overrides: schema.entitlements.overrides })
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, userId));
    return c.json(resolveEntitlements(entRow ?? { plan: "free", overrides: {} }));
  });

  // -------------------------------------------------------------------------
  // POST /users/me/push-tokens — upsert on the unique `token`; a token owned
  // by another account MOVES to the caller (R-user-8, schema §3.3.3
  // semantics); re-registration is the keep-alive (`last_seen_at` bump).
  // -------------------------------------------------------------------------
  router.post(
    userEndpoints.registerPushToken.path,
    zValidator("json", userEndpoints.registerPushToken.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");
      const now = nowOf();

      const [row] = await deps.db
        .insert(schema.pushTokens)
        .values({ userId, token: body.token, platform: body.platform, lastSeenAt: now })
        .onConflictDoUpdate({
          target: schema.pushTokens.token,
          // Landmine (_shared.ts): $onUpdate does not fire through upserts.
          set: { userId, platform: body.platform, lastSeenAt: now, updatedAt: sql`now()` },
        })
        .returning();
      if (!row) throw new HttpError("INTERNAL", "push token upsert returned no row");
      return c.json(toPushTokenWire(row));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /users/me/push-tokens/:pushTokenId — owner-scoped delete; absent
  // and foreign-owned ids are an indistinguishable 404 (R-user-8).
  // -------------------------------------------------------------------------
  router.delete(
    userEndpoints.deletePushToken.path,
    zValidator("param", userEndpoints.deletePushToken.params, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const { pushTokenId } = c.req.valid("param");

      const deleted = await deps.db
        .delete(schema.pushTokens)
        .where(and(eq(schema.pushTokens.id, pushTokenId), eq(schema.pushTokens.userId, userId)))
        .returning({ id: schema.pushTokens.id });
      if (deleted.length === 0) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /users/:userId — member-visible profile, gated on ≥1 shared trip
  // (R-user-4). ONE query: nonexistent user, scrubbed user, and zero shared
  // trips all produce the byte-identical 404 (no existence oracle). Must
  // register AFTER the /users/me tree.
  // -------------------------------------------------------------------------
  router.get(
    userEndpoints.getUserProfile.path,
    zValidator("param", userEndpoints.getUserProfile.params, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId: callerId } = authContextOf(c);
      const { userId: targetId } = c.req.valid("param");

      const theirMembership = alias(schema.tripMembers, "their_membership");
      const myMembership = alias(schema.tripMembers, "my_membership");
      const [row] = await deps.db
        .select({ user: schema.users })
        .from(schema.users)
        .innerJoin(theirMembership, eq(theirMembership.userId, schema.users.id))
        .innerJoin(
          myMembership,
          and(eq(myMembership.tripId, theirMembership.tripId), eq(myMembership.userId, callerId)),
        )
        .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)))
        .limit(1);

      if (!row) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      return c.json(toUserProfileWire(row.user));
    },
  );

  return router;
}
