/**
 * `requireAuth` — the authenticated-route guard (T-5.3 / AU-4 — R-auth-12,
 * R-authz-1).
 *
 * Verifies the `Authorization: Bearer` access token STATELESSLY
 * (access-verify.ts — ES256 allowlist, iss/aud/exp, no DB read) and attaches
 * `{ userId, sessionId }` to the request context. Any failure — missing/
 * malformed header, bad/expired/wrong-alg token — is the uniform 401
 * `UNAUTHENTICATED` with ZERO handler execution.
 *
 * Scope note (mirrors http/errors.ts): AU-4 needs this to gate its own
 * Auth: Required routes (`/auth/logout`, `/auth/sessions*`). AU-5 promotes it
 * to the app-wide convention with the public allowlist + rate limiting; the
 * verification core and `AuthIdentity` context shape are the seams it builds
 * on — no security-model change here, just the enforcement wiring.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import {
  apiError,
  requestIdOf,
  UNAUTHENTICATED_MESSAGE,
  type AuthIdentity,
  type RequestVars,
} from "../http/errors.js";
import {
  AccessTokenInvalidError,
  verifyAccessToken,
  type AccessTokenVerifier,
} from "./access-verify.js";

/** Minimal logger seam — shared with the auth router (routes.ts injects it). */
export interface RequireAuthLogger {
  warn(message: string): void;
}

const BEARER_PREFIX = "bearer ";

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
function extractBearer(header: string | undefined): string | null {
  if (!header || !header.toLowerCase().startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export interface RequireAuthDeps {
  verifier: AccessTokenVerifier;
  logger?: RequireAuthLogger;
}

/**
 * Build the guard middleware. Reads `deps.verifier` per request; on success
 * sets `c.var.auth` and continues, otherwise returns the uniform 401.
 */
export function createRequireAuth(deps: RequireAuthDeps) {
  const logger = deps.logger ?? console;
  return createMiddleware<RequestVars>(async (c, next) => {
    const token = extractBearer(c.req.header("authorization"));
    if (!token) {
      logger.warn(`[auth] requireAuth: missing bearer token (requestId=${requestIdOf(c)})`);
      return apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);
    }

    let claims: AuthIdentity;
    try {
      claims = await verifyAccessToken(deps.verifier, token);
    } catch (error) {
      const reason = error instanceof AccessTokenInvalidError ? "invalid_token" : "unknown";
      logger.warn(`[auth] requireAuth: ${reason} (requestId=${requestIdOf(c)})`);
      return apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);
    }

    c.set("auth", claims);
    await next();
    return undefined;
  });
}

/**
 * Read the authenticated identity a preceding `requireAuth` attached. Absent
 * means the guard did not run before the handler — a wiring bug, never a
 * client condition, so it throws rather than 401s.
 */
export function authContextOf(c: Context<RequestVars>): AuthIdentity {
  const auth = c.get("auth");
  if (!auth) throw new Error("authContextOf called without a preceding requireAuth");
  return auth;
}
