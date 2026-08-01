import { describe, expect, it } from "vitest";
import {
  DAY_ORDER_MAX_ITEMS,
  DayOrderInputSchema,
  ItineraryItemCreateSchema,
  ItineraryItemSchema,
  ItineraryItemUpdateSchema,
  ItineraryRangeQuerySchema,
  ItineraryReadSchema,
  itineraryEndpoints,
  SORT_ORDER_ABS_MAX,
  TravelLegSchema,
  violatesSingleDayTimeOrder,
} from "./itinerary.js";

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

// ---------------------------------------------------------------------------
// IB-2 request shapes (§3.4/§3.7)
// ---------------------------------------------------------------------------

describe("ItineraryItemCreate (R-ib-14/15/17)", () => {
  const customBody = { kind: "custom", title: "Onsen soak", day: "2026-09-03" };
  const visitBody = { kind: "place_visit", place_id: A, day: "2026-09-03" };

  it("accepts both creatable kinds", () => {
    expect(ItineraryItemCreateSchema.parse(customBody).kind).toBe("custom");
    expect(ItineraryItemCreateSchema.parse(visitBody).kind).toBe("place_visit");
  });

  it("kind 'booking' is unrepresentable (R-ib-14 — they exist only via R-ib-5/R-ib-8)", () => {
    expect(
      ItineraryItemCreateSchema.safeParse({ kind: "booking", day: "2026-09-03" }).success,
    ).toBe(false);
  });

  it("place_visit requires place_id and forbids title; custom requires title", () => {
    expect(
      ItineraryItemCreateSchema.safeParse({ kind: "place_visit", day: "2026-09-03" }).success,
    ).toBe(false);
    expect(ItineraryItemCreateSchema.safeParse({ ...visitBody, title: "x" }).success).toBe(false);
    expect(
      ItineraryItemCreateSchema.safeParse({ kind: "custom", day: "2026-09-03" }).success,
    ).toBe(false);
    // place_id is additionally allowed on custom (R-ib-20 location resolution).
    expect(ItineraryItemCreateSchema.parse({ ...customBody, place_id: A }).place_id).toBe(A);
  });

  it("structural time rules: end_day ≥ day; single-day end_time ≥ start_time; multi-day exempt", () => {
    expect(
      ItineraryItemCreateSchema.safeParse({ ...customBody, end_day: "2026-09-01" }).success,
    ).toBe(false);
    expect(
      ItineraryItemCreateSchema.safeParse({
        ...customBody,
        start_time: "15:00",
        end_time: "11:00",
      }).success,
    ).toBe(false);
    // Multi-day span: the end time is on a later wall-date — legal.
    expect(
      ItineraryItemCreateSchema.parse({
        ...customBody,
        end_day: "2026-09-05",
        start_time: "15:00",
        end_time: "11:00",
      }).end_time,
    ).toBe("11:00");
    // end_day == day is still single-day for the time rule.
    expect(
      ItineraryItemCreateSchema.safeParse({
        ...customBody,
        end_day: "2026-09-03",
        start_time: "15:00",
        end_time: "11:00",
      }).success,
    ).toBe(false);
  });

  it("overlaps are never a schema concern (R-ib-17) — equal times parse", () => {
    expect(
      ItineraryItemCreateSchema.parse({ ...customBody, start_time: "11:00", end_time: "11:00" })
        .start_time,
    ).toBe("11:00");
  });

  it("caps free text (title 200 / notes 2000 — T-6.1 convention)", () => {
    expect(
      ItineraryItemCreateSchema.safeParse({ ...customBody, title: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      ItineraryItemCreateSchema.safeParse({ ...customBody, notes: "x".repeat(2001) }).success,
    ).toBe(false);
  });
});

describe("ItineraryItemUpdate", () => {
  it("accepts partial bodies; explicit null clears nullable fields", () => {
    const parsed = ItineraryItemUpdateSchema.parse({
      notes: null,
      start_time: null,
      end_time: null,
      end_day: null,
      sort_order: 0,
    });
    expect(parsed.notes).toBeNull();
    expect(parsed.sort_order).toBe(0); // falsy pin: 0 must survive parsing
  });

  it("title/place_id are non-nullable (clearing would break the kind CHECK)", () => {
    expect(ItineraryItemUpdateSchema.safeParse({ title: null }).success).toBe(false);
    expect(ItineraryItemUpdateSchema.safeParse({ place_id: null }).success).toBe(false);
  });

  it("bounds sort_order at ±SORT_ORDER_ABS_MAX — int4 append headroom (the member.ts max_uses convention)", () => {
    expect(ItineraryItemUpdateSchema.parse({ sort_order: SORT_ORDER_ABS_MAX }).sort_order).toBe(
      SORT_ORDER_ABS_MAX,
    );
    expect(ItineraryItemUpdateSchema.parse({ sort_order: -SORT_ORDER_ABS_MAX }).sort_order).toBe(
      -SORT_ORDER_ABS_MAX,
    );
    expect(
      ItineraryItemUpdateSchema.safeParse({ sort_order: SORT_ORDER_ABS_MAX + 1 }).success,
    ).toBe(false);
    expect(
      ItineraryItemUpdateSchema.safeParse({ sort_order: -SORT_ORDER_ABS_MAX - 1 }).success,
    ).toBe(false);
    // The original failure mode: int4 max is schema-valid only below the cap —
    // 2147483648 must be a 400, never a driver 22003 → 500.
    expect(ItineraryItemUpdateSchema.safeParse({ sort_order: 2_147_483_648 }).success).toBe(false);
  });

  it("caps title/notes on the Update surface independently of Create (each wire surface pins its own caps)", () => {
    expect(ItineraryItemUpdateSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(ItineraryItemUpdateSchema.parse({ title: "x".repeat(200) }).title).toHaveLength(200);
    expect(ItineraryItemUpdateSchema.safeParse({ notes: "x".repeat(2001) }).success).toBe(false);
    expect(ItineraryItemUpdateSchema.parse({ notes: "x".repeat(2000) }).notes).toHaveLength(2000);
  });

  it("body-internal end_day < day is rejected; lone end_day defers to the merged-row check", () => {
    expect(
      ItineraryItemUpdateSchema.safeParse({ day: "2026-09-05", end_day: "2026-09-04" }).success,
    ).toBe(false);
    expect(ItineraryItemUpdateSchema.parse({ end_day: "2026-09-04" }).end_day).toBe("2026-09-04");
  });
});

describe("DayOrderInput (R-ib-15)", () => {
  it("accepts an ordered id list, including empty (all ids may be LWW-ignored)", () => {
    expect(DayOrderInputSchema.parse({ item_ids: [A, B] }).item_ids).toEqual([A, B]);
    expect(DayOrderInputSchema.parse({ item_ids: [] }).item_ids).toEqual([]);
  });

  it("rejects duplicates and oversize lists", () => {
    expect(DayOrderInputSchema.safeParse({ item_ids: [A, A] }).success).toBe(false);
    const ids = Array.from(
      { length: DAY_ORDER_MAX_ITEMS + 1 },
      (_, i) => `${i.toString(16).padStart(8, "0")}-9999-4999-8999-999999999999`,
    );
    expect(DayOrderInputSchema.safeParse({ item_ids: ids }).success).toBe(false);
  });
});

describe("ItineraryRangeQuery / ItineraryRead", () => {
  it("rejects to < from (the documented 400); one-sided ranges parse", () => {
    expect(
      ItineraryRangeQuerySchema.safeParse({ from: "2026-09-05", to: "2026-09-01" }).success,
    ).toBe(false);
    expect(ItineraryRangeQuerySchema.parse({ from: "2026-09-05" }).from).toBe("2026-09-05");
    expect(ItineraryRangeQuerySchema.parse({}).to).toBeUndefined();
  });

  it("ItineraryRead is the {items, legs} composite", () => {
    expect(ItineraryReadSchema.parse({ items: [], legs: [] })).toEqual({ items: [], legs: [] });
  });
});

describe("violatesSingleDayTimeOrder (shared with the server's merged-row check)", () => {
  it("fires only when single-day AND both times set AND inverted", () => {
    const base = { day: "2026-09-03" };
    expect(
      violatesSingleDayTimeOrder({ ...base, start_time: "15:00", end_time: "11:00" }),
    ).toBe(true);
    expect(
      violatesSingleDayTimeOrder({ ...base, end_day: "2026-09-03", start_time: "15:00", end_time: "11:00" }),
    ).toBe(true);
    expect(
      violatesSingleDayTimeOrder({ ...base, end_day: "2026-09-04", start_time: "15:00", end_time: "11:00" }),
    ).toBe(false);
    expect(violatesSingleDayTimeOrder({ ...base, start_time: "15:00", end_time: null })).toBe(
      false,
    );
    expect(violatesSingleDayTimeOrder({ ...base, start_time: null, end_time: "11:00" })).toBe(
      false,
    );
    expect(
      violatesSingleDayTimeOrder({ ...base, start_time: "11:00", end_time: "11:00" }),
    ).toBe(false);
  });
});

describe("itinerary endpoint descriptors (§3.4 mirror)", () => {
  it("paths and methods match the spec §3.4 routes", () => {
    expect(itineraryEndpoints.getItinerary.method).toBe("GET");
    expect(itineraryEndpoints.getItinerary.path).toBe("/trips/:tripId/itinerary");
    expect(itineraryEndpoints.createItineraryItem.method).toBe("POST");
    expect(itineraryEndpoints.createItineraryItem.path).toBe("/trips/:tripId/itinerary/items");
    expect(itineraryEndpoints.updateItineraryItem.method).toBe("PATCH");
    expect(itineraryEndpoints.updateItineraryItem.path).toBe(
      "/trips/:tripId/itinerary/items/:itemId",
    );
    expect(itineraryEndpoints.deleteItineraryItem.method).toBe("DELETE");
    expect(itineraryEndpoints.deleteItineraryItem.path).toBe(
      "/trips/:tripId/itinerary/items/:itemId",
    );
    expect(itineraryEndpoints.putDayOrder.method).toBe("PUT");
    expect(itineraryEndpoints.putDayOrder.path).toBe("/trips/:tripId/itinerary/days/:day/order");
  });
});
