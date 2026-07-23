/**
 * `requireAuth` — the app-wide authenticated-route guard (AU-5, R-authz-1 /
 * R-auth-12). Promoted from the T-5.3 per-router guard: mounted ONCE at the
 * top of the app, it runs on every request and lets exactly the public
 * allowlist through (health + the three sign-in/refresh routes). There is only
 * one implementation — domain routers never re-mount their own.
 *
 * Verification is STATELESS (access-verify.ts — ES256 allowlist, iss/aud/exp,
 * no DB read) and attaches `{ userId, sessionId }` to the request context. Any
 * failure — allowlisted-miss with a missing/malformed header, bad/expired/
 * wrong-alg token — is the uniform 401 `UNAUTHENTICATED` with ZERO handler
 * execution and no oracle for which check failed (§3.6.4).
 *
 * Order (R-authz-4): `requireAuth` runs BEFORE body validation, so an invalid
 * token on a malformed body is a 401, never a 400 — auth precedes validation.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import {
  apiError,
  requestIdOf,
  UNAUTHENTICATED_MESSAGE,
  type AuthIdentity,
  type RequestVars,
} from "./errors.js";
import {
  AccessTokenInvalidError,
  verifyAccessToken,
  type AccessTokenVerifier,
} from "../auth/access-verify.js";

/** Minimal logger seam — shared with the auth router. */
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
  /**
   * The public allowlist as fully-qualified `"METHOD /full/path"` keys
   * (R-authz-1: health + `POST /auth/apple|google|refresh`). A request whose
   * `method` + `path` is in this set skips verification entirely; everything
   * else must present a valid access token. Built in `app.ts` from the shared
   * `authEndpoints` descriptors so the list can never drift from the routes.
   */
  allowlist: ReadonlySet<string>;
  logger?: RequireAuthLogger;
}

/**
 * Build the app-wide guard. Reads `deps.verifier` per request; on an
 * allowlist hit it calls `next()` untouched, on success it sets `c.var.auth`
 * and continues, otherwise it returns the uniform 401.
 */
export function createRequireAuth(deps: RequireAuthDeps) {
  const logger = deps.logger ?? console;
  return createMiddleware<RequestVars>(async (c, next) => {
    // Public allowlist — the ONLY routes that run without an access token.
    if (deps.allowlist.has(`${c.req.method} ${c.req.path}`)) {
      await next();
      return undefined;
    }

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
