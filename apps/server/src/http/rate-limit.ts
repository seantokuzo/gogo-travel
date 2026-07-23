/**
 * Rate limiting for auth surfaces (AU-5, R-auth-14; auth-users spec §3.6.3).
 *
 * Store choice — **in-memory fixed-window counter**, one bucket per
 * `(rule, key)`, resetting `windowMs` after the first hit. The spec pins this
 * as acceptable: "single-instance in-memory is acceptable until there are ≥ 2
 * server instances" (§3.6.3). A fixed-window counter is chosen over a token
 * bucket for its deterministic, clock-injectable reset (trivial to test) and
 * because the limits here are coarse (per minute / hour / day) where the
 * boundary-burst weakness is immaterial. The ≥ 2-instance upgrade is a shared
 * Postgres/Redis counter behind the SAME `RateLimitStore` seam — no call-site
 * change. Rejected attempts count against the window (flood-penalizing, the
 * point of the limit).
 *
 * Keying — the caller supplies each window's `keyOf`. IP-keyed windows use
 * `clientIp` (the socket peer via `getConnInfo`), NOT `X-Forwarded-For`:
 * spoofable, and "not a defense" (server rule). A deployment behind a trusted
 * proxy must inject a trusted-proxy-aware `ipOf` — it is a seam, off by default.
 * A `keyOf` returning `null` skips that window for the request.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { apiError, type RequestVars } from "./errors.js";

/** Result of charging one request against one window. */
export interface RateLimitHit {
  allowed: boolean;
  /** Whole seconds until the window resets — the `Retry-After` value. */
  retryAfterSeconds: number;
}

/**
 * The store seam. `hit` is check-and-charge in one call: it records the
 * attempt AND reports whether it is within `limit`. `nowMs` is injected so the
 * window boundary is deterministic under test.
 */
export interface RateLimitStore {
  hit(key: string, limit: number, windowMs: number, nowMs: number): RateLimitHit;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Default single-instance fixed-window store. Buckets are lazily reset on
 * access; a periodic sweep bounds memory for keys that go quiet (auth surfaces
 * are low-cardinality — IPs and session ids — so this stays small).
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  hit(key: string, limit: number, windowMs: number, nowMs: number): RateLimitHit {
    this.maybeSweep(nowMs);

    const bucket = this.buckets.get(key);
    if (!bucket || nowMs >= bucket.resetAt) {
      // Fresh window: this attempt is #1.
      this.buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)),
      };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop expired buckets at most once a minute — keeps memory bounded. */
  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}

/** One rate-limit window applied by the middleware. */
export interface RateLimitRule {
  /** Namespaces the bucket key so different surfaces never share counters. */
  name: string;
  limit: number;
  windowMs: number;
  /** The per-request key (IP / session / user); `null` skips this window. */
  keyOf: (c: Context<RequestVars>) => string | null;
}

export interface RateLimitMiddlewareDeps {
  store: RateLimitStore;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a middleware that charges each rule and, if ANY window is exceeded,
 * returns 429 `RATE_LIMITED` + `Retry-After` (the max wait across exceeded
 * windows) and processes nothing (R-auth-14). All rules are charged so every
 * independent window (e.g. per-IP AND per-day) advances on each attempt.
 */
export function rateLimit(rules: readonly RateLimitRule[], deps: RateLimitMiddlewareDeps) {
  return createMiddleware<RequestVars>(async (c, next) => {
    const nowMs = deps.now ? deps.now() : Date.now();
    let retryAfter = 0;

    for (const rule of rules) {
      const key = rule.keyOf(c);
      if (key === null) continue;
      const result = deps.store.hit(`${rule.name}:${key}`, rule.limit, rule.windowMs, nowMs);
      if (!result.allowed) retryAfter = Math.max(retryAfter, result.retryAfterSeconds);
    }

    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return apiError(c, "RATE_LIMITED", "rate limit exceeded");
    }

    await next();
    return undefined;
  });
}

/**
 * The socket peer address — the IP rate-limit key. `getConnInfo` reads the
 * Node request's socket, so it is unspoofable by headers (unlike XFF). Under
 * `app.request()` (tests) there is no socket → `"unknown"`; a real proxied
 * deployment injects a trusted-proxy `ipOf` instead of relying on this.
 */
export function clientIp(c: Context<RequestVars>): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
