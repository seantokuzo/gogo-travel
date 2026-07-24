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
import type { AiFeature, TripMemberRole } from "@gogo/shared/enums";
import { ERROR_STATUS, type ApiError, type ErrorCode } from "@gogo/shared/api/envelope";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The ONE message every 401 carries — sign-in verification failures AND
 * `requireAuth` failures alike. A single constant guarantees no oracle for
 * "which check failed" or "does this principal exist" (R-auth-1 / §3.6.4).
 */
export const UNAUTHENTICATED_MESSAGE = "authentication failed";

/**
 * The ONE message every `requireTripMember` 404 carries. A non-member and a
 * nonexistent trip return this identical body (§3.6.4 / R-authz-2 / Law #3):
 * membership absence alone drives the 404, so the response can never reveal
 * that a trip exists. A single constant makes the indistinguishability a
 * compile-time fact, not a per-call-site coincidence.
 */
export const NOT_FOUND_MESSAGE = "not found";

/** The identity `requireAuth` attaches to an authenticated request (R-auth-12). */
export interface AuthIdentity {
  /** `sub` claim — `users.id`. */
  userId: string;
  /** `sid` claim — `auth_sessions.id`. */
  sessionId: string;
}

/** The trip context `requireTripMember` attaches once membership is proven (R-authz-2). */
export interface TripContext {
  tripId: string;
  role: TripMemberRole;
}

/** The quota context `requireAiQuota` attaches once the caller is under-cap (R-ent-2). */
export interface AiQuotaContext {
  feature: AiFeature;
  /** Effective `ai_calls_per_day` for the caller (resolveEntitlements). */
  cap: number;
  /** Counted calls already used today (UTC). */
  used: number;
}

/** Hono context variables the app-wide middleware set. */
export interface RequestVars {
  Variables: {
    requestId: string;
    /**
     * Set by the app-wide `requireAuth` on every non-allowlisted route
     * (R-authz-1). Absent on the public allowlist (health, sign-in, refresh).
     */
    auth?: AuthIdentity;
    /** Set by `requireTripMember` on `/trips/:tripId/*` routes (R-authz-2). */
    trip?: TripContext;
    /** Set by `requireAiQuota` on metered AI routes (R-ent-2). */
    aiQuota?: AiQuotaContext;
  };
}

/**
 * A typed, throwable API failure. Handlers and middleware `throw new
 * HttpError(code, message, details?)` and the app-wide error serializer
 * (`http/app-middleware.ts`) turns it into the shared `ApiError` envelope with
 * the code's fixed status — no handler emits an ad-hoc body, no stack ever
 * reaches the wire (R-shared-4 / R-authz-4). The `apiError` helper below is the
 * return-based twin for the common `return apiError(...)` form; both funnel
 * through the identical envelope.
 */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.details = details;
  }
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
