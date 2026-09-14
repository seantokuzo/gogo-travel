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

/**
 * R-door-11's server-only peer gate (session-door spec §3.2 G5) — co-located
 * with `clientIp` deliberately (the R-door-11 "implementation location" note:
 * a NEW predicate, never `apps/mobile/src/auth/config.ts`'s
 * `isLocalOrPrivateHost` — that checks a client-chosen HOSTNAME, this checks
 * an IP-literal SOCKET PEER; different trust boundary, different input
 * shape, no shared code by design).
 *
 * Accepts IPv4 loopback (`127.0.0.0/8`) and RFC-1918 private ranges
 * (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and IPv6 loopback
 * (`::1`) and ULA (`fc00::/7`, i.e. a first hextet of `fc`/`fd`) — after
 * normalizing an IPv4-mapped IPv6 prefix (`::ffff:10.0.0.5` → `10.0.0.5`)
 * and a bracketed form (`[::1]` → `::1`). Every other input — a public
 * address, `0.0.0.0`, link-local (`169.254.0.0/16`, `fe80::/10`), a name
 * (`.local` included), the unresolvable `"unknown"` `clientIp()` returns
 * under `app.request()`, empty, or `null` — is rejected. Pure and
 * synchronous: no DNS, no I/O, safe to call before any DB access (R-door-11:
 * "evaluated before the secret comparison and before any database access").
 */
export function isLoopbackOrPrivatePeer(addr: string | null | undefined): boolean {
  if (!addr) return false;

  let normalized = addr.trim();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.toLowerCase().startsWith("::ffff:")) {
    normalized = normalized.slice("::ffff:".length);
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const [first, second] = octets as [number, number, number, number];
    if (first === 127) return true; // 127.0.0.0/8 loopback
    if (first === 10) return true; // 10.0.0.0/8 private
    if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12
    if (first === 192 && second === 168) return true; // 192.168.0.0/16
    return false; // 0.0.0.0, 169.254.0.0/16 link-local, and every public range
  }

  const lower = normalized.toLowerCase();
  if (lower === "::1") return true; // IPv6 loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  return false; // fe80::/10 link-local, public IPv6, names, "unknown", ""
}
