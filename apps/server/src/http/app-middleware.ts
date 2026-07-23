/**
 * App-wide middleware promoted here at AU-5 (auth-users spec §3.4/§3.6.4,
 * R-authz-4, R-shared-4). Two concerns, one home:
 *
 *  1. `requestIdMiddleware` — mints a correlation id per request and echoes it
 *     as `x-request-id`. Every `ApiError` carries it (contracts spec §3.5) so
 *     auth failures correlate in logs WITHOUT logging tokens (§3.6.4).
 *  2. `createErrorHandler` — the single serializer every non-2xx flows through
 *     (`app.onError`). Thrown `HttpError` → its envelope; malformed JSON
 *     (`HTTPException` 400 from the body parser) → `VALIDATION_FAILED`;
 *     anything else → `INTERNAL` 500 with the stack kept OFF the wire and only
 *     the error's `name` (never `.message`) logged (Law #1 / R-auth-9 hygiene).
 *
 * These lived on the AU-3 auth sub-router; promoting them to `app` means every
 * future domain router inherits them for free — a sub-router that adds its own
 * `onError` would shadow this one (Hono wraps custom sub-app error handlers),
 * so domain routers MUST NOT define one.
 */
import { randomUUID } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { apiError, requestIdOf, HttpError, type RequestVars } from "./errors.js";

/** Minimal logger seam — mirrors the auth router's (`console` by default). */
export interface ErrorLogger {
  warn(message: string): void;
}

/** Correlation id on every request + response. Runs first, app-wide. */
export const requestIdMiddleware = createMiddleware<RequestVars>(async (c, next) => {
  c.set("requestId", randomUUID());
  c.header("x-request-id", c.get("requestId"));
  await next();
});

/**
 * Build the app-wide `onError` serializer. `logger` defaults to `console`
 * (the one allowed sink, per the server rule) — the auth router injects a
 * test spy through the same seam.
 */
export function createErrorHandler(logger: ErrorLogger = console) {
  return (error: Error, c: Context<RequestVars>): Response => {
    // Typed, intentional failures — the common case. Serialize as-is.
    if (error instanceof HttpError) {
      return apiError(c, error.code, error.message, error.details);
    }

    // Malformed JSON / wrong content type surface as HTTPException(400) from
    // the body parser before Zod runs — the client-error twin of a Zod miss.
    if (error instanceof HTTPException && error.status === 400) {
      return apiError(c, "VALIDATION_FAILED", "malformed request body");
    }

    // Everything else is a bug or an upstream fault: log the error NAME only
    // (never `.message` — a dependency could interpolate a secret into it) and
    // return a body with no stack, no detail.
    logger.warn(
      `[http] unhandled error (requestId=${requestIdOf(c)}, name=${error.name || "unknown"})`,
    );
    return apiError(c, "INTERNAL", "internal error");
  };
}
