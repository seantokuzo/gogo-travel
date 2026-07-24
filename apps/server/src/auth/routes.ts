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
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { authEndpoints, type AuthTokens, type SignInResponse } from "@gogo/shared/domains/auth";
import { RATE_LIMITS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import {
  apiError,
  requestIdOf,
  UNAUTHENTICATED_MESSAGE,
  type RequestVars,
} from "../http/errors.js";
import {
  clientIp,
  rateLimit,
  type RateLimitRule,
  type RateLimitStore,
} from "../http/rate-limit.js";
import { authContextOf } from "../http/require-auth.js";
import { rejectInvalidBody } from "../http/validation.js";
import type { AccessTokenVerifier } from "./access-verify.js";
import type { AppleCodeExchanger } from "./apple-exchange.js";
import { encryptSecret, sha256Hex } from "./crypto.js";
import {
  verifyAppleToken,
  verifyGoogleToken,
  ProviderVerificationError,
  type ProviderVerifierDeps,
  type VerifiedIdentity,
} from "./provider-verify.js";
import { listUserSessions, revokeOwnedSession, revokeSession } from "./session-service.js";
import { resolveSignIn, SignInRejectedError, type SignInResolution } from "./sign-in.js";
import { createSessionWithTokens, type AccessTokenSigner } from "./token-issuer.js";
import { rotateRefreshToken, RefreshRejectedError } from "./token-rotation.js";
import { toUserWire } from "./serialize.js";

export interface AuthLogger {
  warn(message: string): void;
}

/**
 * Rate-limit wiring for the public auth surfaces (§3.6.3, R-auth-14). Absent =
 * limiting OFF (unit/integration suites that assert other behavior stay clean);
 * prod wiring (`wire.ts`) always supplies it. `now` is MILLISECONDS (the store
 * clock — distinct from the token `now: () => Date` below).
 */
export interface AuthRateLimitConfig {
  store: RateLimitStore;
  now?: () => number;
  /** IP resolver — defaults to the socket peer (`clientIp`), never XFF. */
  ipOf?: (c: Context<RequestVars>) => string;
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
  /** Rate limiting for `/auth/apple|google|refresh` (§3.6.3). Absent = off. */
  rateLimit?: AuthRateLimitConfig;
  /** Clock seam for tests. */
  now?: () => Date;
}

type AuthContext = Context<RequestVars>;

function failureReason(error: unknown): string {
  if (error instanceof ProviderVerificationError) return error.reason;
  if (error instanceof SignInRejectedError) return error.reason;
  return "unknown";
}

/**
 * Resolve a presented refresh token to its session id (or null) for the
 * per-session rate-limit key (§3.6.3). Read-only hash lookup — it never mutates
 * and only keys a counter, so it is not an existence oracle. A rotated token
 * still resolves (its row survives with `rotated_at` set), so reuse-probing is
 * rate-limited too.
 */
async function sessionIdForRefreshToken(db: DbClient, token: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: schema.refreshTokens.sessionId })
    .from(schema.refreshTokens)
    .where(eq(schema.refreshTokens.tokenHash, sha256Hex(token)));
  return row?.sessionId ?? null;
}

export function createAuthRouter(deps: AuthRouterDeps): Hono<RequestVars> {
  const logger = deps.logger ?? console;
  const router = new Hono<RequestVars>();

  // requireAuth (app-wide, mounted in app.ts), the correlation-id middleware,
  // and the error serializer are ALL promoted to the app at AU-5 — this router
  // only reads the auth context (`authContextOf`) its Auth: Required routes
  // need. It defines NO onError (that would shadow the app-wide one, Hono
  // wraps custom sub-app error handlers).

  // Rate limiting for the public surfaces (§3.6.3). Each limiter is a SINGLE
  // middleware (real limiter when `deps.rateLimit` is set, else a pass-through)
  // so the route arity stays fixed — spreading a conditional array would defeat
  // Hono's `zValidator` type inference (`c.req.valid` → `never`).
  const rl = deps.rateLimit;
  const ipOf = rl?.ipOf ?? clientIp;
  const passThrough = createMiddleware<RequestVars>(async (_c, next) => {
    await next();
  });
  const rlDeps = rl ? { store: rl.store, ...(rl.now ? { now: rl.now } : {}) } : undefined;

  // apple/google — per-IP: 10/min AND 50/day (credential grinding).
  const signInLimiter =
    rl && rlDeps
      ? rateLimit(
          RATE_LIMITS.signIn.map((w, i): RateLimitRule => ({
            name: `signin-${i}`,
            limit: w.limit,
            windowMs: w.windowMs,
            keyOf: ipOf,
          })),
          rlDeps,
        )
      : passThrough;

  // refresh — per-IP 60/hour at the edge; the per-session 30/hour is charged
  // in-handler (it needs the token resolved to its `sid`, §3.6.3).
  const refreshIpLimiter =
    rl && rlDeps
      ? rateLimit(
          [
            {
              name: "refresh-ip",
              limit: RATE_LIMITS.refreshPerIp.limit,
              windowMs: RATE_LIMITS.refreshPerIp.windowMs,
              keyOf: ipOf,
            },
          ],
          rlDeps,
        )
      : passThrough;

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
    signInLimiter,
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
    signInLimiter,
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
    refreshIpLimiter,
    zValidator("json", authEndpoints.refresh.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const body = c.req.valid("json");

      // Per-session rate limit (§3.6.3: 30/hour, keyed by `sid` via token row).
      // Resolving the sid needs the token, so it's charged here — read-only,
      // BEFORE any rotation, so a limited request mutates nothing (R-auth-14).
      // An unknown token maps to no session → session window skipped (the IP
      // window already bounds unknown-token floods) and the handler 401s below.
      if (rl) {
        const sid = await sessionIdForRefreshToken(deps.db, body.refresh_token);
        if (sid) {
          const nowMs = rl.now ? rl.now() : Date.now();
          const hit = rl.store.hit(
            `refresh-session:${sid}`,
            RATE_LIMITS.refreshPerSession.limit,
            RATE_LIMITS.refreshPerSession.windowMs,
            nowMs,
          );
          if (!hit.allowed) {
            c.header("Retry-After", String(hit.retryAfterSeconds));
            return apiError(c, "RATE_LIMITED", "rate limit exceeded");
          }
        }
      }

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
