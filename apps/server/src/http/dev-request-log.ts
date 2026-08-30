/**
 * Development-only request log.
 *
 * Why this exists: until 2026-08-29 the server emitted nothing but the boot
 * banner and two auth lines, so device QA had no way to tell "the request
 * failed" from "the request never arrived" — the two have completely
 * different causes and we burned a debugging cycle on exactly that ambiguity.
 * `no-console` never forbade this (the root config allows `warn`/`error`); we
 * simply never built it.
 *
 * 🔴 Law #1 — this NEVER logs values. Not bodies, not headers, not query
 * values, not env. Paths are template-normalized before they are printed
 * because real ids and CAPABILITY TOKENS ride in path segments
 * (`/invites/:token` is a bearer credential in a URL): logging a raw path
 * would put a live invite token in a log file. Query strings are reduced to
 * their key names for the same reason.
 *
 * Mounted only when `NODE_ENV === "development"` (see `createApp`), so
 * production and test runs are byte-identical to before.
 */
import { createMiddleware } from "hono/factory";

import { requestIdOf, type RequestVars } from "./errors.js";

/** 8-4-4-4-12 hex. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Long opaque segment — invite tokens and anything else credential-shaped. */
const OPAQUE_RE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Collapse identifying segments so the line is a route template, not data.
 * `/api/trips/<uuid>/expenses/<uuid>` → `/api/trips/:id/expenses/:id`.
 */
export function redactPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg.length === 0) return seg;
      if (UUID_RE.test(seg)) return ":id";
      if (OPAQUE_RE.test(seg)) return ":token";
      if (/^\d+$/.test(seg)) return ":n";
      return seg;
    })
    .join("/");
}

/** Query reduced to key names — values can carry user data. */
export function redactQuery(search: string): string {
  if (search.length <= 1) return "";
  const keys = [...new URLSearchParams(search).keys()];
  return keys.length > 0 ? `?${keys.join(",")}` : "";
}

/**
 * Pull the shared envelope's `error.code` off a non-2xx response. Clones so
 * the real response body is left intact for the client. Best-effort: a
 * non-JSON or already-consumed body just yields no code.
 */
async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.clone().json();
    const err = (body as { error?: { code?: unknown; details?: unknown } } | null)?.error;
    const code = err?.code;
    if (typeof code !== "string") return undefined;

    // For a validation failure the code alone is useless — "VALIDATION_FAILED"
    // is the same line whether one field or ten are wrong. Append the failing
    // field NAMES, which are schema identifiers, never user data. The values
    // stay unread (Law #1): a rejected booking body can carry anything.
    const fieldErrors = (err?.details as { fieldErrors?: Record<string, unknown> } | undefined)
      ?.fieldErrors;
    if (fieldErrors && typeof fieldErrors === "object") {
      const fields = Object.keys(fieldErrors);
      if (fields.length > 0) return `${code} [${fields.join(",")}]`;
    }

    // DOMAIN rejections carry no `fieldErrors` — they key details by rule
    // (`{ details: "end before start" }`), so the branch above finds nothing
    // and the line degrades to a bare code, which is what made a booking 400
    // undiagnosable. The envelope `message` is developer-authored and is
    // ALREADY sent to the client over the wire, so echoing it into a local
    // dev log is strictly less exposure than the response itself.
    const message = (err as { message?: unknown } | undefined)?.message;
    if (typeof message === "string" && message.length > 0) {
      return `${code} — ${message.slice(0, 160)}`;
    }
    return code;
  } catch {
    return undefined;
  }
}

/**
 * Narrowed to what this module actually calls — one string. `console`
 * satisfies it, and so does the auth router's existing logger seam, without a
 * test double having to reproduce all of `Console["warn"]`'s overloads.
 */
export interface LogSink {
  warn: (message: string) => void;
}

export function createDevRequestLog(sink: LogSink = console) {
  return createMiddleware<RequestVars>(async (c, next) => {
    const started = Date.now();
    await next();

    const status = c.res.status;
    const url = new URL(c.req.url);
    const where = `${c.req.method} ${redactPath(url.pathname)}${redactQuery(url.search)}`;
    const code = status >= 400 ? await errorCodeOf(c.res) : undefined;

    sink.warn(
      `[req] ${where} -> ${status}${code ? ` ${code}` : ""} ` +
        `(${Date.now() - started}ms, requestId=${requestIdOf(c)})`,
    );
  });
}
