import { describe, expect, it } from "vitest";
import { ItineraryItemSchema, TravelLegSchema } from "./itinerary.js";

const A = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";
const B = "7a1e2c43-8f5b-4c6d-8e7f-1a2b3c4d5e6f";

const base = {
  id: A,
  trip_id: B,
  booking_id: null,
  place_id: null,
  title: null,
  notes: null,
  day: "2026-09-02",
  end_day: null,
  start_time: null,
  end_time: null,
  sort_order: 1024,
  created_by: A,
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T00:00:00Z",
};

describe("ItineraryItem kind-shape checks (schema spec §3.3.10)", () => {
  it("booking kind requires booking_id", () => {
    expect(ItineraryItemSchema.safeParse({ ...base, kind: "booking" }).success).toBe(false);
    expect(ItineraryItemSchema.parse({ ...base, kind: "booking", booking_id: B }).booking_id).toBe(
      B,
    );
  });

  it("place_visit kind requires place_id", () => {
    expect(ItineraryItemSchema.safeParse({ ...base, kind: "place_visit" }).success).toBe(false);
    expect(ItineraryItemSchema.parse({ ...base, kind: "place_visit", place_id: B }).place_id).toBe(
      B,
    );
  });

  it("custom kind requires title", () => {
    expect(ItineraryItemSchema.safeParse({ ...base, kind: "custom" }).success).toBe(false);
    expect(ItineraryItemSchema.parse({ ...base, kind: "custom", title: "Onsen" }).title).toBe(
      "Onsen",
    );
  });

  it("booking_id is forbidden on non-booking kinds", () => {
    expect(
      ItineraryItemSchema.safeParse({ ...base, kind: "custom", title: "X", booking_id: B }).success,
    ).toBe(false);
  });

  it("multi-day spanning rows: end_day ≥ day; times are HH:MM wall times", () => {
    const spanning = ItineraryItemSchema.parse({
      ...base,
      kind: "booking",
      booking_id: B,
      end_day: "2026-09-05",
      start_time: "15:00",
      end_time: "11:00",
    });
    expect(spanning.end_day).toBe("2026-09-05");
    expect(
      ItineraryItemSchema.safeParse({
        ...base,
        kind: "booking",
        booking_id: B,
        end_day: "2026-09-01",
      }).success,
    ).toBe(false);
  });
});

describe("TravelLeg", () => {
  const leg = {
    id: A,
    trip_id: A,
    from_item_id: A,
    to_item_id: B,
    mode: "walking",
    duration_seconds: 600,
    distance_meters: 800,
    provider: "mapbox",
    computed_at: "2026-07-10T00:00:00Z",
    created_at: "2026-07-10T00:00:00Z",
  };

  it("parses a valid leg", () => {
    expect(TravelLegSchema.parse(leg).mode).toBe("walking");
  });
  it("rejects self-legs (R-db-15 CHECK mirror)", () => {
    expect(TravelLegSchema.safeParse({ ...leg, to_item_id: A }).success).toBe(false);
  });
  it("rejects negative durations/distances", () => {
    expect(TravelLegSchema.safeParse({ ...leg, duration_seconds: -1 }).success).toBe(false);
  });
});
