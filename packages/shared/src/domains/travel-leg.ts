/**
 * Travel-legs domain surface (itinerary-bookings spec §3.4
 * `POST /trips/:tripId/itinerary/refresh-legs`, R-ib-23).
 *
 * The `TravelLeg` entity schema lives in `domains/itinerary.ts` (it is part
 * of the composite itinerary read, R-ib-13); THIS module owns the explicit
 * refresh endpoint's wire contract — a separate file because the refresh
 * surface lands with the leg-computation job (T-7.3 / IB-3) while the
 * itinerary router lands in parallel (T-7.2 / IB-2); disjoint files by
 * construction.
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { UuidSchema } from "../scalars.js";

const tripIdParams = z.object({ tripId: UuidSchema });

/**
 * R-ib-23: an explicit refresh request enqueues recomputation and returns
 * 202 — always `{ enqueued: true }`; the recompute itself is asynchronous
 * and observable only through the itinerary read's legs.
 */
export const RefreshLegsResponseSchema = z.object({ enqueued: z.literal(true) });
export type RefreshLegsResponse = z.infer<typeof RefreshLegsResponseSchema>;

export const travelLegEndpoints = {
  /**
   * Explicit leg recompute (pull-to-refresh after a long offline stretch).
   * Member — ANY role (read-affecting derived data only, §3.4). 202;
   * rate-limited per trip (429 RATE_LIMITED on abuse; window is config).
   */
  refreshLegs: {
    method: "POST",
    path: "/trips/:tripId/itinerary/refresh-legs",
    params: tripIdParams,
    response: RefreshLegsResponseSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
