/**
 * ApiError envelope serialization (contracts spec §3.5; auth-users spec
 * §3.6.4). Every non-2xx is the shared `ApiError` shape with a `requestId`
 * for log correlation — never an ad-hoc body, never a stack trace on the
 * wire.
 *
 * Scope note: AU-5 owns the app-wide error middleware + requestId
 * middleware; this helper is the envelope chokepoint the auth routes (AU-3)
 * use until then, and AU-5 builds on it.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { ERROR_STATUS, type ApiError, type ErrorCode } from "@gogo/shared/api/envelope";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The ONE message every 401 carries — sign-in verification failures AND
 * `requireAuth` failures alike. A single constant guarantees no oracle for
 * "which check failed" or "does this principal exist" (R-auth-1 / §3.6.4).
 */
export const UNAUTHENTICATED_MESSAGE = "authentication failed";

/** The identity `requireAuth` attaches to an authenticated request (R-auth-12). */
export interface AuthIdentity {
  /** `sub` claim — `users.id`. */
  userId: string;
  /** `sid` claim — `auth_sessions.id`. */
  sessionId: string;
}

/** Hono context variables the auth router sets. */
export interface RequestVars {
  Variables: {
    requestId: string;
    /**
     * Set by `requireAuth` on authenticated routes only (AU-4 local guard;
     * AU-5 promotes the app-wide convention). Absent on public routes.
     */
    auth?: AuthIdentity;
  };
}

/**
 * Read the request's correlation id, minting one if middleware hasn't.
 * Generic over any env that extends `RequestVars` so authed routes (which
 * carry a wider `Variables`) reuse the same envelope helpers without a cast.
 */
export function requestIdOf<E extends RequestVars>(c: Context<E>): string {
  const existing = c.get("requestId");
  if (existing) return existing;
  const minted = randomUUID();
  c.set("requestId", minted);
  return minted;
}

/**
 * Serialize an `ApiError`. Status comes from the fixed `ERROR_STATUS` map —
 * handlers pick codes, never status numbers.
 */
export function apiError<E extends RequestVars>(
  c: Context<E>,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  const body: ApiError = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId: requestIdOf(c),
    },
  };
  return c.json(body, ERROR_STATUS[code] as ContentfulStatusCode);
}
