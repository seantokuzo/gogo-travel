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
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AppleSignInRequestSchema,
  GoogleSignInRequestSchema,
  type SignInResponse,
} from "@gogo/shared/domains/auth";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, requestIdOf, type RequestVars } from "../http/errors.js";
import type { AppleCodeExchanger } from "./apple-exchange.js";
import { encryptSecret } from "./crypto.js";
import {
  verifyAppleToken,
  verifyGoogleToken,
  ProviderVerificationError,
  type ProviderVerifierDeps,
  type VerifiedIdentity,
} from "./provider-verify.js";
import { resolveSignIn, SignInRejectedError, type SignInResolution } from "./sign-in.js";
import { createSessionWithTokens, type AccessTokenSigner } from "./token-issuer.js";
import { toUserWire } from "./serialize.js";

export interface AuthLogger {
  warn(message: string): void;
}

export interface AuthRouterDeps {
  db: DbClient;
  verifier: ProviderVerifierDeps;
  signer: AccessTokenSigner;
  /** R-auth-7 seam — prod hits Apple's endpoint, tests inject a fake. */
  appleExchange: AppleCodeExchanger;
  /** AES-256-GCM key for `apple_credentials` ciphertext (§3.3.3). */
  appleCredentialsKey: Buffer;
  logger?: AuthLogger;
  /** Clock seam for tests. */
  now?: () => Date;
}

type AuthContext = Context<RequestVars>;

/** One message for every 401 — no oracle for which check failed (R-auth-1). */
const UNAUTHENTICATED_MESSAGE = "authentication failed";

function failureReason(error: unknown): string {
  if (error instanceof ProviderVerificationError) return error.reason;
  if (error instanceof SignInRejectedError) return error.reason;
  return "unknown";
}

export function createAuthRouter(deps: AuthRouterDeps): Hono<RequestVars> {
  const logger = deps.logger ?? console;
  const router = new Hono<RequestVars>();

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
      const reason = error instanceof Error ? error.message : "unknown";
      logger.warn(
        `[auth] apple code exchange failed — sign-in continues (requestId=${requestIdOf(c)}, reason=${reason})`,
      );
    }
  };

  // Validation hooks: Zod failure → 400 `VALIDATION_FAILED` envelope (never
  // zValidator's default shape).
  router.post(
    "/auth/apple",
    zValidator("json", AppleSignInRequestSchema, (result, c) => {
      if (!result.success) {
        // Hook contexts arrive with Hono's base env — safe: the router env is RequestVars.
        return apiError(
          c as unknown as AuthContext,
          "VALIDATION_FAILED",
          "request body failed validation",
          z.flattenError(result.error),
        );
      }
      return undefined;
    }),
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
    "/auth/google",
    zValidator("json", GoogleSignInRequestSchema, (result, c) => {
      if (!result.success) {
        // Hook contexts arrive with Hono's base env — safe: the router env is RequestVars.
        return apiError(
          c as unknown as AuthContext,
          "VALIDATION_FAILED",
          "request body failed validation",
          z.flattenError(result.error),
        );
      }
      return undefined;
    }),
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

  return router;
}
