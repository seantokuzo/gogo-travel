/**
 * Conflict-analysis pins (T-7.5 / IT-4 — R-itin-7, R-itin-20).
 *
 * The load-bearing pin here is CROSS-SURFACE: the list's overlap set must
 * equal the grid's `overlapping` blocks for the same data, because R-itin-7
 * and R-itin-15 are one fact rendered twice. That is the spec's own required
 * test ("Overlap: both list chips and grid side-by-side render for the same
 * data") and the guard against the two ladders drifting apart.
 *
 * Every negative assertion is paired with a CONTROL arm that shows the same
 * shape of input CAN produce the positive result — an "expect nothing"
 * assertion over an input that could never trigger anything proves nothing.
 */
import type { Booking, ItineraryItem } from "@gogo/shared";

import {
  BOOKING_FLIGHT_ID,
  BOOKING_LODGING_ID,
  defaultBookings,
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";

import {
  analyzeDayConflicts,
  findPlacementConflicts,
  sortDayByTime,
  timedSpanOf,
  type PlacementCandidate,
} from "./conflicts";
import { buildGridDays } from "./grid/model";

const TRIP = { start_date: TRIP_START, end_date: TRIP_END };

function bookingsById(bookings: Booking[] = defaultBookings()): Map<string, Booking> {
  return new Map(bookings.map((booking) => [booking.id, booking]));
}

const ID_D = "aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const ID_E = "aaaaaaa6-aaaa-4aaa-8aaa-aaaaaaaaaaa6";

function timed(
  id: string,
  start: string,
  end: string | null,
  overrides: Partial<ItineraryItem> = {},
): ItineraryItem {
  return makeItineraryItem({ id, start_time: start, end_time: end, ...overrides });
}

describe("analyzeDayConflicts — overlap chips (R-itin-7)", () => {
  it("flags BOTH items of an overlapping pair", () => {
    const items = [
      timed(ITEM_A_ID, "10:00", "12:00", { sort_order: 1024 }),
      timed(ITEM_B_ID, "11:00", "13:00", { sort_order: 2048 }),
    ];
    const { overlappingItemIds } = analyzeDayConflicts(items, bookingsById());
    expect([...overlappingItemIds].sort()).toEqual([ITEM_A_ID, ITEM_B_ID].sort());
  });

  it("CONTROL: touching-but-not-overlapping spans flag nothing", () => {
    const items = [
      timed(ITEM_A_ID, "10:00", "11:00", { sort_order: 1024 }),
      timed(ITEM_B_ID, "11:00", "12:00", { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).overlappingItemIds.size).toBe(0);
    // …and the same pair one minute earlier DOES flag — proving the assertion
    // above could have failed.
    const nudged = [
      timed(ITEM_A_ID, "10:00", "11:01", { sort_order: 1024 }),
      timed(ITEM_B_ID, "11:00", "12:00", { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(nudged, bookingsById()).overlappingItemIds.size).toBe(2);
  });

  it("items on DIFFERENT days never conflict, identical clock times or not", () => {
    const items = [
      timed(ITEM_A_ID, "10:00", "12:00", { day: TRIP_START }),
      timed(ITEM_B_ID, "10:00", "12:00", { day: TRIP_DAY_2 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).overlappingItemIds.size).toBe(0);
    // CONTROL: same two rows on ONE day do flag.
    const sameDay = [
      timed(ITEM_A_ID, "10:00", "12:00", { day: TRIP_START }),
      timed(ITEM_B_ID, "10:00", "12:00", { day: TRIP_START }),
    ];
    expect(analyzeDayConflicts(sameDay, bookingsById()).overlappingItemIds.size).toBe(2);
  });

  it("untimed items are transparent — never flagged, never flagging", () => {
    const items = [
      makeItineraryItem({ id: ITEM_A_ID, start_time: null, sort_order: 1024 }),
      makeItineraryItem({ id: ITEM_B_ID, start_time: null, sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).overlappingItemIds.size).toBe(0);
  });

  it("spanning lodging is ambient (all-day lane), so it never conflicts", () => {
    const items = [
      makeItineraryItem({
        id: ITEM_LODGING_ID,
        kind: "booking",
        booking_id: BOOKING_LODGING_ID,
        title: null,
        day: TRIP_START,
        end_day: TRIP_END,
        start_time: "15:00",
        end_time: "11:00",
        sort_order: 1024,
      }),
      timed(ITEM_A_ID, "15:30", "17:00", { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).overlappingItemIds.size).toBe(0);
    // CONTROL: drop the span (same-day lodging) and it becomes a real block
    // that DOES collide — so the exclusion above is the span rule, not luck.
    const sameDayStay = [
      makeItineraryItem({
        id: ITEM_LODGING_ID,
        kind: "booking",
        booking_id: BOOKING_LODGING_ID,
        title: null,
        day: TRIP_START,
        end_day: null,
        start_time: "15:00",
        end_time: "18:00",
        sort_order: 1024,
      }),
      timed(ITEM_A_ID, "15:30", "17:00", { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(sameDayStay, bookingsById()).overlappingItemIds.size).toBe(2);
  });

  it("a timed item with no end still occupies its default block", () => {
    const items = [
      timed(ITEM_A_ID, "10:00", null, { sort_order: 1024 }),
      timed(ITEM_B_ID, "10:30", "11:30", { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).overlappingItemIds.size).toBe(2);
  });

  it("timedSpanOf is null exactly for the two ambient cases", () => {
    const bookings = bookingsById();
    expect(timedSpanOf(makeItineraryItem({ id: ITEM_A_ID, start_time: null }), bookings)).toBeNull();
    expect(timedSpanOf(timed(ITEM_A_ID, "09:00", "10:00"), bookings)).toEqual({
      startMinutes: 540,
      endMinutes: 600,
    });
  });
});

describe("list ≡ grid (R-itin-7 ⇔ R-itin-15 — the spec's cross-surface test)", () => {
  /** One universe exercising every branch of the ladder at once. */
  function mixedUniverse(): ItineraryItem[] {
    return [
      // three-way overlap
      timed(ITEM_A_ID, "09:00", "11:00", { sort_order: 1024 }),
      timed(ITEM_B_ID, "10:00", "10:30", { sort_order: 2048 }),
      timed(ID_D, "10:15", "12:00", { sort_order: 3072 }),
      // lone evening block — split-free, badge-free
      timed(ID_E, "19:00", "20:00", { sort_order: 4096 }),
      // untimed → all-day chip
      makeItineraryItem({ id: ITEM_C_ID, start_time: null, sort_order: 5120 }),
      // spanning lodging → all-day lane
      makeItineraryItem({
        id: ITEM_LODGING_ID,
        kind: "booking",
        booking_id: BOOKING_LODGING_ID,
        title: null,
        day: TRIP_START,
        end_day: TRIP_END,
        start_time: "15:00",
        end_time: "11:00",
        sort_order: 6144,
      }),
    ];
  }

  it("the list's overlap set is exactly the grid's overlapping blocks", () => {
    const items = mixedUniverse();
    const bookings = bookingsById();

    const listSet = [...analyzeDayConflicts(items, bookings).overlappingItemIds].sort();
    const gridSet = buildGridDays(TRIP, items, bookings)
      .days.flatMap((day) => day.blocks)
      .filter((block) => block.overlapping)
      .map((block) => block.itemId)
      .sort();

    expect(listSet).toEqual(gridSet);
    // Not vacuously equal: the universe really does contain overlaps.
    expect(listSet).toEqual([ITEM_A_ID, ITEM_B_ID, ID_D].sort());
  });

  it("cross-midnight items agree too (both clip at midnight)", () => {
    const items = [
      timed(ITEM_A_ID, "23:00", "06:00", { day: TRIP_START, end_day: TRIP_DAY_2, sort_order: 1024 }),
      timed(ITEM_B_ID, "23:30", "23:45", { day: TRIP_START, sort_order: 2048 }),
    ];
    const bookings = bookingsById();
    const listSet = [...analyzeDayConflicts(items, bookings).overlappingItemIds].sort();
    const gridSet = buildGridDays(TRIP, items, bookings)
      .days.flatMap((day) => day.blocks)
      .filter((block) => block.overlapping)
      .map((block) => block.itemId)
      .sort();
    expect(listSet).toEqual(gridSet);
    expect(listSet).toHaveLength(2);
  });
});

describe("sort-by-time affordance (R-itin-7)", () => {
  it("a day whose start times descend is unsorted; ascending is not (CONTROL)", () => {
    const descending = [
      timed(ITEM_A_ID, "14:00", null, { sort_order: 1024 }),
      timed(ITEM_B_ID, "09:00", null, { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(descending, bookingsById()).unsortedDays.has(TRIP_START)).toBe(true);

    const ascending = [
      timed(ITEM_A_ID, "09:00", null, { sort_order: 1024 }),
      timed(ITEM_B_ID, "14:00", null, { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(ascending, bookingsById()).unsortedDays.size).toBe(0);
  });

  it("equal start times are NOT out of order", () => {
    const items = [
      timed(ITEM_A_ID, "09:00", null, { sort_order: 1024 }),
      timed(ITEM_B_ID, "09:00", null, { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).unsortedDays.size).toBe(0);
  });

  it("untimed items between timed ones don't make a day unsorted", () => {
    const items = [
      timed(ITEM_A_ID, "09:00", null, { sort_order: 1024 }),
      makeItineraryItem({ id: ITEM_C_ID, start_time: null, sort_order: 2048 }),
      timed(ITEM_B_ID, "14:00", null, { sort_order: 3072 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).unsortedDays.size).toBe(0);
  });

  it("a spanning lodging check-in counts as timed for ordering (it renders inline)", () => {
    const items = [
      makeItineraryItem({
        id: ITEM_LODGING_ID,
        kind: "booking",
        booking_id: BOOKING_LODGING_ID,
        title: null,
        day: TRIP_START,
        end_day: TRIP_END,
        start_time: "15:00",
        end_time: "11:00",
        sort_order: 1024,
      }),
      timed(ITEM_A_ID, "09:00", null, { sort_order: 2048 }),
    ];
    expect(analyzeDayConflicts(items, bookingsById()).unsortedDays.has(TRIP_START)).toBe(true);
  });

  it("the sorted order permutes ONLY timed items, leaving untimed slots alone", () => {
    const ordered = [
      timed(ITEM_A_ID, "14:00", null, { sort_order: 1024 }),
      makeItineraryItem({ id: ITEM_C_ID, start_time: null, sort_order: 2048 }),
      timed(ITEM_B_ID, "09:00", null, { sort_order: 3072 }),
    ];
    // Slot 1 (the untimed row) is untouched; slots 0 and 2 swap.
    expect(sortDayByTime(ordered)).toEqual([ITEM_B_ID, ITEM_C_ID, ITEM_A_ID]);
  });

  it("ties keep their current relative order (a stable sort, not a shuffle)", () => {
    const ordered = [
      timed(ID_D, "12:00", null, { sort_order: 1024 }),
      timed(ITEM_A_ID, "09:00", null, { sort_order: 2048 }),
      timed(ITEM_B_ID, "09:00", null, { sort_order: 3072 }),
    ];
    expect(sortDayByTime(ordered)).toEqual([ITEM_A_ID, ITEM_B_ID, ID_D]);
  });

  it("the PUT payload is published only for days that need it", () => {
    const items = [
      timed(ITEM_A_ID, "14:00", null, { day: TRIP_START, sort_order: 1024 }),
      timed(ITEM_B_ID, "09:00", null, { day: TRIP_START, sort_order: 2048 }),
      timed(ITEM_C_ID, "09:00", null, { day: TRIP_DAY_2, sort_order: 1024 }),
    ];
    const { sortedDayOrders } = analyzeDayConflicts(items, bookingsById());
    expect([...sortedDayOrders.keys()]).toEqual([TRIP_START]);
    expect(sortedDayOrders.get(TRIP_START)).toEqual([ITEM_B_ID, ITEM_A_ID]);
  });
});

describe("findPlacementConflicts — the form notice (R-itin-20)", () => {
  const existing = (): ItineraryItem[] => [
    timed(ITEM_A_ID, "10:00", "12:00", { title: "Museum", sort_order: 1024 }),
    makeItineraryItem({ id: ITEM_B_ID, start_time: null, title: "Walk", sort_order: 2048 }),
  ];

  function candidate(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
    return {
      day: TRIP_START,
      end_day: null,
      start_time: "11:00",
      end_time: "13:00",
      spanning: false,
      ...overrides,
    };
  }

  it("names the overlapping item with the list's own time caption", () => {
    const hits = findPlacementConflicts([candidate()], {
      items: existing(),
      bookingsById: bookingsById(),
    });
    expect(hits).toEqual([{ itemId: ITEM_A_ID, title: "Museum", timeLabel: "10:00 – 12:00" }]);
  });

  it("CONTROL: moved clear of the existing block, there is no hit", () => {
    const hits = findPlacementConflicts([candidate({ start_time: "12:00", end_time: "13:00" })], {
      items: existing(),
      bookingsById: bookingsById(),
    });
    expect(hits).toEqual([]);
  });

  it("an untimed placement can never conflict", () => {
    expect(
      findPlacementConflicts([candidate({ start_time: null, end_time: null })], {
        items: existing(),
        bookingsById: bookingsById(),
      }),
    ).toEqual([]);
  });

  it("a spanning-lodging placement is ambient and conflicts with nothing", () => {
    const hits = findPlacementConflicts(
      [candidate({ start_time: "11:00", end_time: "10:00", end_day: TRIP_END, spanning: true })],
      { items: existing(), bookingsById: bookingsById() },
    );
    expect(hits).toEqual([]);
    // CONTROL: the identical window with `spanning: false` DOES hit.
    expect(
      findPlacementConflicts([candidate({ start_time: "11:00", end_time: "13:00" })], {
        items: existing(),
        bookingsById: bookingsById(),
      }),
    ).toHaveLength(1);
  });

  it("edit mode: the item being edited never conflicts with itself", () => {
    const hits = findPlacementConflicts([candidate()], {
      items: existing(),
      bookingsById: bookingsById(),
      excludeItemIds: [ITEM_A_ID],
    });
    expect(hits).toEqual([]);
  });

  it("booking edit: every auto-item of THIS booking is excluded", () => {
    const items = [
      timed(ITEM_A_ID, "10:00", "12:00", {
        kind: "booking",
        booking_id: BOOKING_FLIGHT_ID,
        title: null,
        sort_order: 1024,
      }),
    ];
    expect(
      findPlacementConflicts([candidate()], {
        items,
        bookingsById: bookingsById(),
        excludeBookingId: BOOKING_FLIGHT_ID,
      }),
    ).toEqual([]);
    // CONTROL: a DIFFERENT booking's item is not excluded.
    expect(
      findPlacementConflicts([candidate()], {
        items,
        bookingsById: bookingsById(),
        excludeBookingId: BOOKING_LODGING_ID,
      }),
    ).toHaveLength(1);
  });

  it("two placements hitting the same item report it once", () => {
    const hits = findPlacementConflicts(
      [candidate({ start_time: "10:30", end_time: "11:00" }), candidate()],
      { items: existing(), bookingsById: bookingsById() },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe(ITEM_A_ID);
  });

  it("a placement on another day sees nothing", () => {
    expect(
      findPlacementConflicts([candidate({ day: TRIP_DAY_2 })], {
        items: existing(),
        bookingsById: bookingsById(),
      }),
    ).toEqual([]);
  });
});
