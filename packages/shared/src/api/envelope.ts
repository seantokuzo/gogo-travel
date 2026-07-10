/**
 * API envelope conventions (contracts spec §3.5).
 *
 * Success: 2xx with the endpoint's response schema as the body — no wrapper
 * (R-shared-5). Lists use `Paginated<T>`. Every non-2xx is an `ApiError`
 * whose `code` is a member of the append-only `ErrorCode` set (R-shared-4).
 */
import { z } from "zod";

/**
 * Machine-readable, stable error codes. APPEND-ONLY — never remove or rename
 * (contracts spec §3.5; `AI_UPSTREAM` appended per ai spec §3.4).
 */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "RATE_LIMITED",
  "AI_CAP_EXCEEDED",
  "AI_DISABLED",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL",
  "AI_UPSTREAM",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Fixed status↔code mapping (contracts spec §3.5). Handlers pick codes; the
 * shared server error middleware owns serialization and reads the status here.
 *
 * Semantics fixed by the spec:
 * - `FORBIDDEN` includes privacy-boundary denials; the message never reveals
 *   whether the resource exists.
 * - `NOT_FOUND` is also returned for resources hidden by visibility —
 *   indistinguishable from absent (Law #3).
 * - `AI_DISABLED` is a policy stop (kill switch); `AI_UPSTREAM` is transient
 *   and retryable (Anthropic upstream failure / invalid structured output
 *   after retry).
 */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  AI_CAP_EXCEEDED: 429,
  AI_DISABLED: 503,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
  AI_UPSTREAM: 503,
};

export const ApiErrorSchema = z.object({
  error: z.object({
    /** Machine-readable, stable. */
    code: ErrorCodeSchema,
    /** Human-readable, safe to display. English v1. */
    message: z.string(),
    /** e.g. `zodError.flatten()` for `VALIDATION_FAILED`. */
    details: z.unknown().optional(),
    /** Correlation id for logs. */
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Shared list shape (R-shared-5): `{ items, nextCursor }` with an opaque
 * cursor (`null` = no further page). Page-size caps are server-defined.
 */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export type Paginated<T> = {
  items: T[];
  nextCursor: string | null;
};
