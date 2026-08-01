import { describe, expect, it } from "vitest";
import { TRAVEL_MODES } from "../enums.js";
import { COMPUTED_TRAVEL_MODES } from "../config/travel-legs.js";
import { RefreshLegsResponseSchema, travelLegEndpoints } from "./travel-leg.js";

describe("travel-leg domain (T-7.3 / IB-3)", () => {
  it("refresh response is exactly { enqueued: true } (R-ib-23)", () => {
    expect(RefreshLegsResponseSchema.parse({ enqueued: true })).toEqual({ enqueued: true });
    expect(RefreshLegsResponseSchema.safeParse({ enqueued: false }).success).toBe(false);
    expect(RefreshLegsResponseSchema.safeParse({}).success).toBe(false);
  });

  it("refreshLegs descriptor matches the spec route (§3.4)", () => {
    expect(travelLegEndpoints.refreshLegs.method).toBe("POST");
    expect(travelLegEndpoints.refreshLegs.path).toBe("/trips/:tripId/itinerary/refresh-legs");
    // No body, no query — the trip id is the entire input.
    expect(travelLegEndpoints.refreshLegs).not.toHaveProperty("body");
    expect(travelLegEndpoints.refreshLegs).not.toHaveProperty("query");
  });

  it("computed mode set is a non-empty subset of the wire enum (R-ib-21)", () => {
    expect(COMPUTED_TRAVEL_MODES.length).toBeGreaterThan(0);
    for (const mode of COMPUTED_TRAVEL_MODES) {
      expect(TRAVEL_MODES).toContain(mode);
    }
    // No duplicates — the job iterates this list per pair.
    expect(new Set(COMPUTED_TRAVEL_MODES).size).toBe(COMPUTED_TRAVEL_MODES.length);
  });
});
