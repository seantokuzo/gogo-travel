/**
 * FX proxy route (T-9.4; P-9 ruling ③): GET `/fx/rate` — the ONE non-trip-
 * scoped money route (shared `moneyEndpoints.getFxRate`). The client fetches
 * OUR endpoint; no provider key exists anywhere (keyless Frankfurter v2
 * behind the `FxProviderPort` seam — provider.ts).
 *
 * AUTHZ POSTURE (the shared descriptor's JSDoc pin, quoted): "global, not
 * trip-scoped, but still behind `requireAuth`; cache writes only on
 * provider-confirmed pairs (an unauthenticated open proxy / attacker-
 * fillable cache is the R1 security finding this line pins against)". The
 * route is NOT on `PUBLIC_ALLOWLIST`, so the app-wide `requireAuth` fronts
 * it; app.ts rejects fx-without-auth as a wiring bug (the users-router
 * pairing rule).
 *
 * PER-DAY CACHE: in-memory, keyed `(base, quote)` with the entry stamped by
 * UTC calendar day — one provider hit per pair per UTC day, matching the
 * provider's daily-refresh cadence. ONLY the provider-confirmed `rate` arm
 * is stored (the pin above): error arms and unsupported pairs are never
 * cached, so the map is bounded by the provider's real currency matrix
 * (~30 × 29 pairs), not by the 26³ code space an attacker can spell. Day
 * rollover overwrites in place — one entry per pair, ever.
 *
 * PROVIDER-FAILURE CONTRACT ([I-…] numbered in the PR body):
 *  - `unsupported` (provider 422/404 — the pair, not the provider) → 400
 *    `VALIDATION_FAILED`;
 *  - `unavailable` (outage/timeout/transport/parse) → 503 `AI_UPSTREAM` —
 *    the envelope's ONLY transient-upstream code (append-only set; a
 *    generic `UPSTREAM` alias is a shared-schema change outside this task's
 *    file ownership). Either way the client's manual-rate fallback arm takes
 *    over (client money spec: "offline/FX-failure → manual rate required";
 *    R-money-6 keeps manual override available ALWAYS).
 *
 * RATE LIMIT (`RATE_LIMITS.fxRate`, per authenticated user — the
 * places-search posture): cache MISSES on never-confirmed pairs bypass the
 * cache by design, so without a limiter one authenticated client could fan
 * unbounded traffic (and 4-second timeout holds) onto the keyless third
 * party. Absent = no limiter (unit/integration tests); prod wiring
 * (`wire.ts`) always supplies it.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { moneyEndpoints, type FxRateRead } from "@gogo/shared/domains/money";
import { RATE_LIMITS } from "../config.js";
import { apiError, type RequestVars } from "../http/errors.js";
import { rateLimit, type RateLimitStore } from "../http/rate-limit.js";
import { rejectInvalidBody } from "../http/validation.js";
import type { FxProviderPort } from "./provider.js";

export interface FxRouterDeps {
  provider: FxProviderPort;
  /** Prod wiring always supplies it; absent = no limiter (tests). */
  rateLimit?: {
    store: RateLimitStore;
    now?: () => number;
  };
  /** Clock seam for the UTC cache day (tests pin rollover). */
  now?: () => Date;
}

interface CacheEntry {
  /** UTC calendar day (`YYYY-MM-DD`) the entry was confirmed on. */
  day: string;
  read: FxRateRead;
}

export function createFxRouter(deps: FxRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const nowOf = () => (deps.now ? deps.now() : new Date());

  /** Per-day cache — provider-confirmed pairs ONLY (module doc). */
  const cache = new Map<string, CacheEntry>();

  const passThrough = createMiddleware<RequestVars>(async (_c, next) => {
    await next();
  });
  const rl = deps.rateLimit;
  const limiter = rl
    ? rateLimit(
        [
          {
            name: "fx-rate-user",
            limit: RATE_LIMITS.fxRate.limit,
            windowMs: RATE_LIMITS.fxRate.windowMs,
            keyOf: (c) => c.get("auth")?.userId ?? null,
          },
        ],
        { store: rl.store, ...(rl.now ? { now: rl.now } : {}) },
      )
    : passThrough;

  router.get(
    moneyEndpoints.getFxRate.path,
    limiter,
    zValidator("query", moneyEndpoints.getFxRate.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { base, quote } = c.req.valid("query");
      const day = nowOf().toISOString().slice(0, 10);
      const key = `${base}:${quote}`;

      const hit = cache.get(key);
      if (hit && hit.day === day) {
        return c.json(hit.read satisfies FxRateRead);
      }

      const result = await deps.provider.rate(base, quote);
      switch (result.kind) {
        case "rate":
          cache.set(key, { day, read: result.read });
          return c.json(result.read satisfies FxRateRead);
        case "unsupported":
          // The pair, not the provider — never cached, never a 5xx.
          return apiError(c, "VALIDATION_FAILED", "currency pair not supported by the FX provider", {
            pair: "unsupported",
          });
        case "unavailable":
          // Manual-fallback arm (module doc). Detail is deliberately NOT
          // forwarded — provider-controlled text stays out of client bodies.
          return apiError(c, "AI_UPSTREAM", "FX provider unavailable — enter the rate manually");
      }
    },
  );

  return router;
}
