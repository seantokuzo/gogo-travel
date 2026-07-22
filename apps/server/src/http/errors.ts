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

/** Hono context variables the auth router sets. */
export interface RequestVars {
  Variables: {
    requestId: string;
  };
}

/** Read the request's correlation id, minting one if middleware hasn't. */
export function requestIdOf(c: Context<RequestVars>): string {
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
export function apiError(
  c: Context<RequestVars>,
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
