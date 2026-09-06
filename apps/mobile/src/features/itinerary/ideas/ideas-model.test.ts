/**
 * Ideas-bucket model pins (T-7.6 / IT-5 — R-itin-10..12 pure halves):
 * zero-item membership (client R-ib-10), category grouping in tuple order
 * with `updated_at DESC` inside a group, the needs-a-day flag, the B-13
 * two-peer-bin row split (Ideas rows never carry cancelled; cancelled get
 * their own flat row list), and Law #2 integer-cents price text.
 */
import {
  buildCancelledRows,
  buildIdeasGroups,
  buildIdeasRows,
  formatIdeaPrice,
  schedulePrefill,
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

describe("buildIdeasRows / buildCancelledRows (B-13 two-peer-bin split)", () => {
  it("Ideas rows are the unscheduled groups only — never a cancelled card", () => {
    const idea = makeBooking({ id: BOOKING_IDEA_ID, status: "idea" });
    const rows = buildIdeasRows(buildIdeasGroups([idea]));
    expect(rows.map((row) => row.type)).toEqual(["group", "card"]);
    expect(rows.some((row) => row.type === "card" && row.cancelled)).toBe(false);
  });

  it("Cancelled rows are flat cancelled cards — no group label (the bin header names them)", () => {
    const cancelled = makeBooking({ id: BOOKING_FLIGHT_ID, status: "cancelled" });
    const rows = buildCancelledRows([cancelled]);
    expect(rows).toEqual([
      {
        type: "card",
        key: BOOKING_FLIGHT_ID,
        card: { booking: cancelled, needsDay: false },
        cancelled: true,
      },
    ]);
  });

  it("empty inputs yield empty row lists — the bins hide on empty, they never render blanks", () => {
    expect(buildIdeasRows(buildIdeasGroups([]))).toEqual([]);
    expect(buildCancelledRows([])).toEqual([]);
  });
});

describe("schedulePrefill (B-16 — carried date/times become the sheet's initial VALUES)", () => {
  it("same-wall-date start+end prefill day and both times (wall slices of the LOCAL strings, no tz math)", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: {
        category: "activity",
        starts_at: "2027-03-02T14:30:00+09:00",
        ends_at: "2027-03-02T16:00:00+09:00",
      },
      starts_at: "2027-03-02T05:30:00.000Z",
      ends_at: "2027-03-02T07:00:00.000Z",
    });
    // Wall values, NOT the UTC instants (05:30Z would be tz-broken output).
    expect(schedulePrefill(idea)).toEqual({
      day: "2027-03-02",
      startTime: "14:30",
      endTime: "16:00",
    });
  });

  it("a cross-day end is dropped — the sheet's single-day end_time can't carry it, and an overnight span would read inverted", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "lodging",
      status: "idea",
      details: {
        category: "lodging",
        check_in: "2027-03-01T15:00:00+09:00",
        check_out: "2027-03-03T11:00:00+09:00",
      },
      starts_at: "2027-03-01T06:00:00.000Z",
      ends_at: "2027-03-03T02:00:00.000Z",
    });
    expect(schedulePrefill(idea)).toEqual({ day: "2027-03-01", startTime: "15:00", endTime: "" });
  });

  it("nothing carried ⇒ all empty (the control state — pre-B-16 behavior preserved)", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: { category: "activity" },
      starts_at: null,
      ends_at: null,
    });
    expect(schedulePrefill(idea)).toEqual({ day: "", startTime: "", endTime: "" });
  });

  it("end-only carried time anchors the day from the end (each side independent — R-ib-4 posture)", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: { category: "activity", ends_at: "2027-03-02T16:00:00+09:00" },
      starts_at: null,
      ends_at: "2027-03-02T07:00:00.000Z",
    });
    expect(schedulePrefill(idea)).toEqual({ day: "2027-03-02", startTime: "", endTime: "16:00" });
  });

  it("date-line class (same wall-date, end before start) prefills as carried — the form's inversion rule governs, not this projection", () => {
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      details: {
        category: "activity",
        starts_at: "2027-03-02T14:30:00+13:00",
        ends_at: "2027-03-02T09:00:00-10:00",
      },
      starts_at: "2027-03-02T01:30:00.000Z",
      ends_at: "2027-03-02T19:00:00.000Z",
    });
    expect(schedulePrefill(idea)).toEqual({
      day: "2027-03-02",
      startTime: "14:30",
      endTime: "09:00",
    });
  });
});

describe("formatIdeaPrice (Law #2 — integer cents; T-9.1 R1: shared ISO-4217 formatter)", () => {
  it("2-decimal currencies render byte-identical to the pre-swap output (control arms)", () => {
    expect(formatIdeaPrice(123456, "USD")).toBe("USD 1234.56");
    expect(formatIdeaPrice(100, "EUR")).toBe("EUR 1.00");
    expect(formatIdeaPrice(5, "USD")).toBe("USD 0.05");
  });

  it("zero-decimal currencies render whole minor units (was '15.00' for 1500 — 100× off)", () => {
    expect(formatIdeaPrice(1500, "JPY")).toBe("JPY 1500");
    expect(formatIdeaPrice(0, "JPY")).toBe("JPY 0");
    // Control arm: the same minor-unit count under a 2dp currency scales.
    expect(formatIdeaPrice(1500, "USD")).toBe("USD 15.00");
  });
});
