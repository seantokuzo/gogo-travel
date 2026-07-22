/**
 * Auth sign-in routes (T-5.2 / AU-3): `POST /auth/apple`, `POST /auth/google`
 * — auth-users spec §3.4.1, wire shapes from `@gogo/shared` only.
 *
 * Failure posture (R-auth-1, §3.6.4): every verification/resolution failure
 * is ONE undifferentiated 401 — identical code and message across tampered
 * signature, wrong iss/aud, expired, nonce mismatch, unverified email, and
 * identity conflicts. Internal reason codes go to the logger with the
 * requestId; token material never appears in any log line (R-auth-9 hygiene).
 *
 * Not here by design: rate limiting (R-auth-14) and the app-wide error/
 * requestId middleware land with AU-5; `/auth/refresh`, `/auth/logout`, and
 * session list/revoke land with AU-4.
 */
import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context, type Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authEndpoints, type AuthTokens, type SignInResponse } from "@gogo/shared/domains/auth";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import {
  apiError,
  requestIdOf,
  UNAUTHENTICATED_MESSAGE,
  type RequestVars,
} from "../http/errors.js";
import type { AccessTokenVerifier } from "./access-verify.js";
import type { AppleCodeExchanger } from "./apple-exchange.js";
import { encryptSecret } from "./crypto.js";
import {
  verifyAppleToken,
  verifyGoogleToken,
  ProviderVerificationError,
  type ProviderVerifierDeps,
  type VerifiedIdentity,
} from "./provider-verify.js";
import { authContextOf, createRequireAuth } from "./require-auth.js";
import { listUserSessions, revokeOwnedSession, revokeSession } from "./session-service.js";
import { resolveSignIn, SignInRejectedError, type SignInResolution } from "./sign-in.js";
import { createSessionWithTokens, type AccessTokenSigner } from "./token-issuer.js";
import { rotateRefreshToken, RefreshRejectedError } from "./token-rotation.js";
import { toUserWire } from "./serialize.js";

export interface AuthLogger {
  warn(message: string): void;
}

export interface AuthRouterDeps {
  db: DbClient;
  verifier: ProviderVerifierDeps;
  signer: AccessTokenSigner;
  /** ES256 public key for stateless access-token verification (R-auth-12). */
  accessVerify: AccessTokenVerifier;
  /** R-auth-7 seam — prod hits Apple's endpoint, tests inject a fake. */
  appleExchange: AppleCodeExchanger;
  /** AES-256-GCM key for `apple_credentials` ciphertext (§3.3.3). */
  appleCredentialsKey: Buffer;
  logger?: AuthLogger;
  /** Clock seam for tests. */
  now?: () => Date;
}

type AuthContext = Context<RequestVars>;

/**
 * Shared zValidator failure hook body: a body that fails schema validation
 * becomes the `VALIDATION_FAILED` envelope (never zValidator's default 400
 * shape). Extracted so the single `c`-to-`AuthContext` cast — hook contexts
 * arrive typed with Hono's base `Env`, not our `RequestVars` (`requestIdOf`
 * mints the id if the requestId middleware hasn't run) — lives here once, not
 * copied per route.
 */
function rejectInvalidBody<T>(c: Context<Env>, error: z.core.$ZodError<T>): Response {
  return apiError(
    c as unknown as AuthContext,
    "VALIDATION_FAILED",
    "request body failed validation",
    z.flattenError(error),
  );
}

function failureReason(error: unknown): string {
  if (error instanceof ProviderVerificationError) return error.reason;
  if (error instanceof SignInRejectedError) return error.reason;
  return "unknown";
}

export function createAuthRouter(deps: AuthRouterDeps): Hono<RequestVars> {
  const logger = deps.logger ?? console;
  const router = new Hono<RequestVars>();
  // AU-4 local guard for this router's Auth: Required routes (AU-5 promotes it
  // app-wide with the public allowlist + rate limiting).
  const requireAuth = createRequireAuth({ verifier: deps.accessVerify, logger });

  // Correlation id on every request/response (AU-5 promotes this app-wide).
  router.use("*", async (c, next) => {
    c.set("requestId", randomUUID());
    c.header("x-request-id", c.get("requestId"));
    await next();
  });

  // Malformed JSON / wrong content type surface as HTTPException(400) from
  // the json body parser before Zod runs; everything else is INTERNAL. All
  // errors leave as the ApiError envelope — no stack traces on the wire.
  router.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return apiError(c, "VALIDATION_FAILED", "malformed request body");
    }
    logger.warn(`[auth] unhandled error (requestId=${requestIdOf(c)})`);
    return apiError(c, "INTERNAL", "internal error");
  });

  const unauthenticated = (c: AuthContext, error: unknown): Response => {
    logger.warn(
      `[auth] sign-in rejected (requestId=${requestIdOf(c)}, reason=${failureReason(error)})`,
    );
    return apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);
  };

  /** Shared tail: account resolution → session + tokens → `SignInResponse`. */
  const completeSignIn = async (
    c: AuthContext,
    identity: VerifiedIdentity,
    device: { device_name?: string | undefined; platform: "ios" | "android" },
    nameSeed?: { givenName?: string | undefined; familyName?: string | undefined },
    afterResolve?: (resolution: SignInResolution) => Promise<void>,
  ): Promise<Response> => {
    let resolution: SignInResolution;
    try {
      resolution = await resolveSignIn(deps.db, identity, nameSeed);
    } catch (error) {
      if (error instanceof SignInRejectedError) return unauthenticated(c, error);
      throw error;
    }

    await afterResolve?.(resolution);

    const issued = await createSessionWithTokens(deps.db, {
      userId: resolution.user.id,
      device: { deviceName: device.device_name, platform: device.platform },
      signer: deps.signer,
      ...(deps.now ? { now: deps.now() } : {}),
    });

    const body: SignInResponse = {
      user: toUserWire(resolution.user),
      tokens: {
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        expires_in: issued.expiresIn,
      },
      is_new_user: resolution.isNewUser,
    };
    return c.json(body);
  };

  /**
   * R-auth-7: exchange the authorization code and store the Apple refresh
   * token as AES-256-GCM ciphertext (upsert — each Apple sign-in refreshes
   * it). Exchange failure NEVER fails the sign-in: logged (reason only, no
   * token material), retried implicitly at the next sign-in.
   */
  const storeAppleCredential = async (
    c: AuthContext,
    userId: string,
    authorizationCode: string,
  ): Promise<void> => {
    try {
      const appleRefreshToken = await deps.appleExchange.exchange(authorizationCode);
      const ciphertext = encryptSecret(deps.appleCredentialsKey, appleRefreshToken);
      await deps.db
        .insert(schema.appleCredentials)
        .values({ userId, refreshTokenCiphertext: ciphertext })
        .onConflictDoUpdate({
          target: schema.appleCredentials.userId,
          // Landmine (_shared.ts): $onUpdate does not fire through upserts.
          set: { refreshTokenCiphertext: ciphertext, updatedAt: sql`now()` },
        });
    } catch (error) {
      // Log `error.name` (or a fixed reason) — NEVER `.message`. This is the
      // one path that trusts a DI dependency's error on a scope holding the
      // authorization code + Apple refresh token; an alternate exchanger that
      // interpolated the code into its message must not be able to leak it.
      const reason = error instanceof Error ? error.name : "unknown";
      logger.warn(
        `[auth] apple code exchange failed — sign-in continues (requestId=${requestIdOf(c)}, reason=${reason})`,
      );
    }
  };

  // Paths + body schemas come from the shared `authEndpoints` descriptors
  // (single source of truth, contracts spec §3.6) — this is the first route
  // implementation and the template every future route copies, so descriptor/
  // route drift (which would 404 clients) is killed at the source. Validation
  // hooks: Zod failure → 400 `VALIDATION_FAILED` envelope (never zValidator's
  // default shape).
  router.post(
    authEndpoints.appleSignIn.path,
    zValidator("json", authEndpoints.appleSignIn.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const body = c.req.valid("json");

      let identity: VerifiedIdentity;
      try {
        identity = await verifyAppleToken(deps.verifier, body.identity_token, body.raw_nonce);
      } catch (error) {
        return unauthenticated(c, error);
      }

      return completeSignIn(
        c,
        identity,
        body.device,
        { givenName: body.given_name, familyName: body.family_name },
        (resolution) => storeAppleCredential(c, resolution.user.id, body.authorization_code),
      );
    },
  );

  router.post(
    authEndpoints.googleSignIn.path,
    zValidator("json", authEndpoints.googleSignIn.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const body = c.req.valid("json");

      let identity: VerifiedIdentity;
      try {
        identity = await verifyGoogleToken(deps.verifier, body.id_token, body.raw_nonce);
      } catch (error) {
        return unauthenticated(c, error);
      }

      // Google name material rides the ID token (already on `identity.name`).
      return completeSignIn(c, identity, body.device);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/refresh — rotation + reuse-theft (R-auth-10/11). Public: the
  // refresh token IS the credential. Every rejection (unknown / expired /
  // rotated-reuse / revoked-session) is the SAME 401 — no oracle (§3.6.4);
  // the reuse branch has already burned the family before we get here.
  // ---------------------------------------------------------------------------
  router.post(
    authEndpoints.refresh.path,
    zValidator("json", authEndpoints.refresh.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const body = c.req.valid("json");

      let issued;
      try {
        issued = await rotateRefreshToken(deps.db, {
          presentedToken: body.refresh_token,
          signer: deps.signer,
          ...(deps.now ? { now: deps.now() } : {}),
        });
      } catch (error) {
        if (error instanceof RefreshRejectedError) {
          logger.warn(
            `[auth] refresh rejected (requestId=${requestIdOf(c)}, reason=${error.reason})`,
          );
          return apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);
        }
        throw error;
      }

      const tokens: AuthTokens = {
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        expires_in: issued.expiresIn,
      };
      return c.json(tokens);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/logout — revoke the calling session (from the `sid` claim) and
  // optionally deregister this device's push token (R-auth-13, R-user-8).
  // Order: requireAuth → validation → handler (R-authz-4).
  // ---------------------------------------------------------------------------
  router.post(
    authEndpoints.logout.path,
    requireAuth,
    zValidator("json", authEndpoints.logout.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId, sessionId } = authContextOf(c);
      const body = c.req.valid("json");
      const now = deps.now ? deps.now() : new Date();

      // Family kill for this device — idempotent (already-revoked → no-op).
      await revokeSession(deps.db, sessionId, now);

      // Push-token deregistration is scoped to the caller: a foreign id
      // matches 0 rows and is silently skipped (spec §3.4.1 authz test).
      if (body.push_token_id) {
        await deps.db
          .delete(schema.pushTokens)
          .where(
            and(eq(schema.pushTokens.id, body.push_token_id), eq(schema.pushTokens.userId, userId)),
          );
      }

      return c.body(null, 204);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /auth/sessions — the caller's live devices (R-auth-13). Revoked
  // sessions excluded; `current` marks the caller's own session.
  // ---------------------------------------------------------------------------
  router.get(
    authEndpoints.listSessions.path,
    requireAuth,
    zValidator("query", authEndpoints.listSessions.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId, sessionId } = authContextOf(c);
      const { cursor } = c.req.valid("query");
      const page = await listUserSessions(deps.db, userId, sessionId, cursor);
      return c.json(page);
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /auth/sessions/:sessionId — remote sign-out (R-auth-13). Absent,
  // already-revoked, or foreign ids are an indistinguishable 404 (IDOR posture).
  // ---------------------------------------------------------------------------
  router.delete(
    authEndpoints.revokeSession.path,
    requireAuth,
    zValidator("param", authEndpoints.revokeSession.params, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const { sessionId } = c.req.valid("param");
      const now = deps.now ? deps.now() : new Date();

      const revoked = await revokeOwnedSession(deps.db, userId, sessionId, now);
      if (!revoked) return apiError(c, "NOT_FOUND", "not found");

      return c.body(null, 204);
    },
  );

  return router;
}
