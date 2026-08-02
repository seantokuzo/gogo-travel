/**
 * Travel-legs routes (T-7.3 / IB-3): POST
 * `/trips/:tripId/itinerary/refresh-legs` — itinerary-bookings spec §3.4,
 * R-ib-19/23/24. One endpoint, deliberately in its OWN router: the main
 * itinerary router is T-7.2's file (W2 runs in parallel — disjoint files by
 * construction).
 *
 * AUTHZ POSTURE (bookings routes precedent): behind the app-wide
 * `requireAuth`; the route sits behind `requireTripMember()` at ANY role —
 * refresh touches read-affecting derived data only (§3.4), so a viewer may
 * pull-to-refresh. Non-member → the byte-identical 404 (R-ib-24). No param
 * zValidator on `:tripId` (the gate folds malformed ids into the same 404).
 *
 * RATE LIMIT (§3.4: "rate-limited per trip; window is config"): the shared
 * fixed-window limiter keyed by the GATE-PROVEN tripId — one budget per
 * trip, however many members hammer it. Charged AFTER the membership gate,
 * so a non-member sees 404, never a 429 existence oracle. The store default
 * is in-memory (the §3.6.3 single-instance posture); `now` is injectable
 * for deterministic window tests.
 *
 * HANDLER: collect the trip's item days (day + end_day — both chain days of
 * spanning items, §3.6), mark them dirty through the seam's swallow helper,
 * 202 `{ enqueued: true }` (R-ib-23 — recompute is asynchronous; the worker
 * dedups marks per trip window, so repeated refreshes coalesce into ONE
 * pending recompute). A tripless/itemless refresh is a legal no-op 202.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { travelLegEndpoints, type RefreshLegsResponse } from "@gogo/shared/domains/travel-leg";
import { RATE_LIMITS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { RequestVars } from "../http/errors.js";
import { InMemoryRateLimitStore, rateLimit, type RateLimitStore } from "../http/rate-limit.js";
import { createRequireTripMember, tripContextOf } from "../http/require-trip-member.js";
import { markDaysDirty, type DirtyDayMark, type DirtyDayMarker } from "../bookings/dirty-days.js";
import { itemChainDays } from "./adjacency.js";

export interface TravelLegsRouterDeps {
  db: DbClient;
  /** The LIVE worker in prod wiring; any recording marker in tests. */
  dirtyDays: DirtyDayMarker;
  /**
   * Rate-limit seam. The limiter is ALWAYS on (spec-required) — omitting
   * this only means a private in-memory store and the real clock.
   */
  rateLimit?: { store: RateLimitStore; now?: () => number };
}

export function createTravelLegsRouter(deps: TravelLegsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  const store = deps.rateLimit?.store ?? new InMemoryRateLimitStore();
  const limiter = rateLimit(
    [
      {
        name: "refresh-legs-trip",
        limit: RATE_LIMITS.refreshLegs.limit,
        windowMs: RATE_LIMITS.refreshLegs.windowMs,
        // Gate-proven trip id — requireTripMember ran first (middleware order).
        keyOf: (c) => c.get("trip")?.tripId ?? null,
      },
    ],
    { store, ...(deps.rateLimit?.now ? { now: deps.rateLimit.now } : {}) },
  );

  router.post(
    travelLegEndpoints.refreshLegs.path,
    requireTripMember(), // any role — read-affecting derived data (§3.4)
    limiter,
    async (c) => {
      const { tripId } = tripContextOf(c);

      const dayRows = await deps.db
        .select({
          day: schema.itineraryItems.day,
          endDay: schema.itineraryItems.endDay,
        })
        .from(schema.itineraryItems)
        .where(eq(schema.itineraryItems.tripId, tripId));

      const marks = new Map<string, DirtyDayMark>();
      for (const row of dayRows) {
        for (const day of itemChainDays(row)) {
          marks.set(day, { tripId, day });
        }
      }
      // Fire-and-forget (R-ib-19 posture): the 202 never waits on — and can
      // never fail because of — the queue.
      markDaysDirty(deps.dirtyDays, [...marks.values()]);

      return c.json({ enqueued: true } satisfies RefreshLegsResponse, 202);
    },
  );

  return router;
}
