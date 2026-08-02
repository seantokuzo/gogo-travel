/**
 * Grid projection (R-itin-13..17, R-itin-31 grid half; §2.5–§2.6). Pure —
 * fixtures are wire-faithful rows from the shared itinerary fixtures.
 */
import type { Booking } from "@gogo/shared";

import {
  BOOKING_LODGING_ID,
  ITEM_LODGING_ID,
  defaultBookings,
  makeBooking,
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";

import {
  buildGridDays,
  DEFAULT_BLOCK_MINUTES,
  initialDayIndex,
  MINUTES_PER_DAY,
  parseISOTime,
  slotPrefillTime,
} from "./model";

const TRIP = { start_date: TRIP_START, end_date: TRIP_END };

function bookingsMap(bookings: Booking[] = defaultBookings()): Map<string, Booking> {
  return new Map(bookings.map((b) => [b.id, b]));
}

describe("parseISOTime", () => {
  it("converts HH:MM wall times to minutes from midnight", () => {
    expect(parseISOTime("00:00")).toBe(0);
    expect(parseISOTime("09:30")).toBe(570);
    expect(parseISOTime("23:59")).toBe(1439);
  });
});

describe("slotPrefillTime (R-itin-14 30-min rounding)", () => {
  it("floors the top half of the hour row to :00", () => {
    expect(slotPrefillTime(9, 0)).toBe("09:00");
    expect(slotPrefillTime(9, 0.49)).toBe("09:00");
  });

  it("floors the bottom half to :30", () => {
    expect(slotPrefillTime(9, 0.5)).toBe("09:30");
    expect(slotPrefillTime(9, 0.99)).toBe("09:30");
  });

  it("zero-pads and clamps the hour", () => {
    expect(slotPrefillTime(7, 0)).toBe("07:00");
    expect(slotPrefillTime(25, 0)).toBe("23:00");
    expect(slotPrefillTime(-1, 0.8)).toBe("00:30");
  });
});

describe("initialDayIndex (R-itin-17 landing column)", () => {
  const dates = [TRIP_START, TRIP_DAY_2, TRIP_END];

  it("lands on today's column when today is a grid day", () => {
    expect(initialDayIndex(dates, TRIP_DAY_2)).toBe(1);
  });

  it("falls back to the first day when today is out of range", () => {
    expect(initialDayIndex(dates, "2026-01-01")).toBe(0);
  });
});

describe("buildGridDays", () => {
  it("emits one column per trip day, unioned with outside item days", () => {
    const outside = makeItineraryItem({ id: "out-1", day: "2027-03-10" });
    const { days } = buildGridDays(TRIP, [outside], bookingsMap());
    expect(days.map((d) => d.date)).toEqual([TRIP_START, TRIP_DAY_2, TRIP_END, "2027-03-10"]);
  });

  it("projects a timed item to a positioned block with booking enrichment", () => {
    const item = makeItineraryItem({
      id: "t-1",
      kind: "booking",
      booking_id: defaultBookings()[0]?.id ?? "",
      title: null,
      start_time: "10:00",
      end_time: "12:30",
    });
    const { days } = buildGridDays(TRIP, [item], bookingsMap());
    const block = days[0]?.blocks[0];
    expect(block).toMatchObject({
      itemId: "t-1",
      title: "UA 837 SFO→NRT",
      status: "booked",
      startMinutes: 600,
      endMinutes: 750,
      plusOne: false,
      column: 0,
      columns: 1,
      overlapping: false,
    });
  });

  it("renders a timed item with no end_time at the default block length", () => {
    const item = makeItineraryItem({ id: "t-2", start_time: "09:00" });
    const { days } = buildGridDays(TRIP, [item], bookingsMap());
    expect(days[0]?.blocks[0]?.endMinutes).toBe(540 + DEFAULT_BLOCK_MINUTES);
  });

  it("puts untimed items in the all-day lane, not the block layer (R-itin-16)", () => {
    const item = makeItineraryItem({ id: "u-1", title: "Walk Shibuya" });
    const { days, maxAllDayCount } = buildGridDays(TRIP, [item], bookingsMap());
    expect(days[0]?.blocks).toHaveLength(0);
    expect(days[0]?.allDay[0]).toMatchObject({ itemId: "u-1", title: "Walk Shibuya" });
    expect(maxAllDayCount).toBe(1);
  });

  it("renders spanning lodging as lane segments across covered columns, never blocks (R-itin-31)", () => {
    const lodging = makeItineraryItem({
      id: ITEM_LODGING_ID,
      kind: "booking",
      booking_id: BOOKING_LODGING_ID,
      title: null,
      day: TRIP_START,
      end_day: TRIP_END,
      start_time: "15:00",
      end_time: "11:00",
    });
    const { days, laneCount } = buildGridDays(TRIP, [lodging], bookingsMap());
    expect(laneCount).toBe(1);
    // Despite carrying check-in/check-out times, it never becomes a block.
    expect(days.flatMap((d) => d.blocks)).toHaveLength(0);
    const segments = days.map((d) => d.spans[0]);
    expect(segments.map((seg) => seg?.isStart)).toEqual([true, false, false]);
    expect(segments.map((seg) => seg?.isEnd)).toEqual([false, false, true]);
    expect(segments.every((seg) => seg?.title === "Park Hyatt Tokyo")).toBe(true);
    expect(segments.every((seg) => seg?.bookingId === BOOKING_LODGING_ID)).toBe(true);
    expect(segments.every((seg) => seg?.lane === 0)).toBe(true);
  });

  it("stacks overlapping spans into distinct lanes", () => {
    const lodgingA = makeItineraryItem({
      id: "span-a",
      kind: "booking",
      booking_id: BOOKING_LODGING_ID,
      title: null,
      day: TRIP_START,
      end_day: TRIP_DAY_2,
      start_time: "15:00",
      end_time: "11:00",
    });
    const secondBooking = makeBooking({
      id: "bbbbbbb9-bbbb-4bbb-8bbb-bbbbbbbbbbb9",
      category: "lodging",
      title: "Ryokan Annex",
    });
    const lodgingB = makeItineraryItem({
      id: "span-b",
      kind: "booking",
      booking_id: secondBooking.id,
      title: null,
      day: TRIP_DAY_2,
      end_day: TRIP_END,
      start_time: "16:00",
      end_time: "10:00",
    });
    const { days, laneCount } = buildGridDays(
      TRIP,
      [lodgingA, lodgingB],
      bookingsMap([...defaultBookings(), secondBooking]),
    );
    expect(laneCount).toBe(2);
    const day2 = days[1];
    expect(day2?.spans).toHaveLength(2);
    expect(new Set(day2?.spans.map((seg) => seg.lane))).toEqual(new Set([0, 1]));
  });

  it("clips a cross-midnight non-lodging span at midnight with a +1 tail (§2.6)", () => {
    const redEye = makeItineraryItem({
      id: "fly-1",
      kind: "booking",
      booking_id: defaultBookings()[0]?.id ?? "",
      title: null,
      day: TRIP_START,
      end_day: TRIP_DAY_2,
      start_time: "22:00",
      end_time: "06:15",
    });
    const { days, laneCount } = buildGridDays(TRIP, [redEye], bookingsMap());
    const block = days[0]?.blocks[0];
    expect(block?.startMinutes).toBe(22 * 60);
    expect(block?.endMinutes).toBe(MINUTES_PER_DAY);
    expect(block?.plusOne).toBe(true);
    // Nothing renders on the arrival day; it is not a lane either.
    expect(days[1]?.blocks).toHaveLength(0);
    expect(days[1]?.spans).toHaveLength(0);
    expect(laneCount).toBe(0);
  });

  it("assigns side-by-side columns to same-day overlapping blocks (R-itin-15)", () => {
    const a = makeItineraryItem({ id: "ov-a", start_time: "09:00", end_time: "11:00" });
    const b = makeItineraryItem({ id: "ov-b", start_time: "10:00", end_time: "12:00" });
    const { days } = buildGridDays(TRIP, [a, b], bookingsMap());
    const blocks = days[0]?.blocks ?? [];
    expect(blocks.map((bl) => bl.columns)).toEqual([2, 2]);
    expect(blocks.every((bl) => bl.overlapping)).toBe(true);
  });

  it("falls back to generic metadata when booking enrichment is missing", () => {
    const orphan = makeItineraryItem({
      id: "orphan-1",
      kind: "booking",
      booking_id: "bbbbbbb8-bbbb-4bbb-8bbb-bbbbbbbbbbb8",
      title: null,
      start_time: "13:00",
      end_time: "14:00",
    });
    const { days } = buildGridDays(TRIP, [orphan], new Map());
    expect(days[0]?.blocks[0]?.title).toBe("Booking");
    expect(days[0]?.blocks[0]?.status).toBeNull();
  });
});
