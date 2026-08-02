/**
 * Ideas-bucket model pins (T-7.6 / IT-5 — R-itin-10..12 pure halves):
 * zero-item membership (client R-ib-10), category grouping in tuple order
 * with `updated_at DESC` inside a group, the needs-a-day flag, cancelled
 * row placement behind the toggle, and Law #2 integer-cents price text.
 */
import {
  buildIdeasGroups,
  buildIdeasRows,
  formatIdeaPrice,
  unscheduledBookings,
} from "./ideas-model";

import {
  BOOKING_FLIGHT_ID,
  BOOKING_IDEA_ID,
  BOOKING_LODGING_ID,
  defaultBookings,
  defaultItineraryItems,
  makeBooking,
} from "@/test-utils/itinerary-fixtures";

describe("unscheduledBookings (client R-ib-10)", () => {
  it("keeps exactly the zero-item bookings", () => {
    const idea = makeBooking({ id: BOOKING_IDEA_ID, status: "idea", starts_at: null });
    const bookings = [...defaultBookings(), idea];
    // Flight + lodging both have items in the default universe; the idea
    // has none.
    const result = unscheduledBookings(bookings, defaultItineraryItems());
    expect(result.map((b) => b.id)).toEqual([BOOKING_IDEA_ID]);
  });

  it("with zero items every booking is unscheduled", () => {
    const result = unscheduledBookings(defaultBookings(), []);
    expect(result.map((b) => b.id)).toEqual([BOOKING_FLIGHT_ID, BOOKING_LODGING_ID]);
  });
});

describe("buildIdeasGroups (§2.3 grouping)", () => {
  it("groups by category in tuple order, updated_at DESC inside a group, and flags needs-a-day", () => {
    const oldFlight = makeBooking({
      id: "eeeeeee1-eeee-4eee-8eee-eeeeeeeeeee1",
      category: "flight",
      status: "idea",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    const newFlight = makeBooking({
      id: "eeeeeee2-eeee-4eee-8eee-eeeeeeeeeee2",
      category: "flight",
      status: "idea",
      updated_at: "2026-07-02T00:00:00.000Z",
    });
    const timelessPlanned = makeBooking({
      id: "eeeeeee3-eeee-4eee-8eee-eeeeeeeeeee3",
      category: "lodging",
      status: "planned",
      starts_at: null,
    });

    const groups = buildIdeasGroups([oldFlight, newFlight, timelessPlanned]);
    // lodging precedes flight in the shared category tuple.
    expect(groups.map((g) => g.category)).toEqual(["lodging", "flight"]);
    expect(groups[1]?.cards.map((c) => c.booking.id)).toEqual([newFlight.id, oldFlight.id]);
    // R-itin-12: timeless planned/booked is flagged; ideas are not.
    expect(groups[0]?.cards[0]?.needsDay).toBe(true);
    expect(groups[1]?.cards[0]?.needsDay).toBe(false);
  });
});

describe("buildIdeasRows (flattened render list)", () => {
  it("appends cancelled rows only when the toggle is on", () => {
    const idea = makeBooking({ id: BOOKING_IDEA_ID, status: "idea" });
    const cancelled = makeBooking({ id: BOOKING_FLIGHT_ID, status: "cancelled" });
    const groups = buildIdeasGroups([idea]);

    const hidden = buildIdeasRows(groups, [cancelled], false);
    expect(hidden.some((row) => row.type === "card" && row.cancelled)).toBe(false);

    const shown = buildIdeasRows(groups, [cancelled], true);
    const cancelledRows = shown.filter((row) => row.type === "card" && row.cancelled);
    expect(cancelledRows).toHaveLength(1);
    // Cancelled land at the foot, after every live group.
    expect(shown[shown.length - 1]).toMatchObject({ type: "card", cancelled: true });
  });
});

describe("formatIdeaPrice (Law #2 — integer cents)", () => {
  it("renders integer-cents math, two minor digits, no float formatting", () => {
    expect(formatIdeaPrice(123456, "USD")).toBe("USD 1234.56");
    expect(formatIdeaPrice(100, "EUR")).toBe("EUR 1.00");
    expect(formatIdeaPrice(5, "USD")).toBe("USD 0.05");
    expect(formatIdeaPrice(0, "JPY")).toBe("JPY 0.00");
  });
});
