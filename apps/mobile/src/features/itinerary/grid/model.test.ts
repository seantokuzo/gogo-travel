/**
 * Grid projection (R-itin-13..17, R-itin-31 grid half; §2.5–§2.6). Pure —
 * fixtures are wire-faithful rows from the shared itinerary fixtures.
 */
import type { Booking } from "@gogo/shared";

import {
  BOOKING_LODGING_ID,
  ITEM_LODGING_ID,
  ITEM_RENTAL_DROPOFF_ID,
  ITEM_RENTAL_PICKUP_ID,
  defaultBookings,
  makeBooking,
  makeItineraryItem,
  rentalBooking,
  rentalItems,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";

import { COLUMN_FRACTION, GUTTER_WIDTH, MIN_COLUMN_WIDTH, THREE_DAY_COLUMNS } from "./constants";
import {
  buildGridDays,
  CHECKPOINT_BLOCK_MINUTES,
  clampLandingIndex,
  DEFAULT_BLOCK_MINUTES,
  gridColumnLayout,
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

  it("carries DISTINCT pickup/drop-off subtexts on a rental's two derived blocks (B-18)", () => {
    const { days } = buildGridDays(
      TRIP,
      rentalItems(),
      bookingsMap([rentalBooking(), ...defaultBookings()]),
    );
    const pickup = days[0]?.blocks.find((b) => b.itemId === ITEM_RENTAL_PICKUP_ID);
    const dropoff = days[1]?.blocks.find((b) => b.itemId === ITEM_RENTAL_DROPOFF_ID);
    expect(pickup?.subtext).toBe("Pickup");
    expect(dropoff?.subtext).toBe("Drop off");
    // The shared `projectItem` enrichment is the one home for the mapping —
    // both blocks still carry the bare (identical) booking title.
    expect(pickup?.title).toBe(dropoff?.title);
  });

  it("CONTROL: a non-derived timed block carries no subtext (B-18)", () => {
    const item = makeItineraryItem({
      id: "t-1",
      kind: "booking",
      booking_id: defaultBookings()[0]?.id ?? "",
      title: null,
      start_time: "10:00",
      end_time: "12:30",
    });
    const { days } = buildGridDays(TRIP, [item], bookingsMap());
    expect(days[0]?.blocks[0]?.subtext).toBeNull();
  });

  it("puts untimed items in the all-day lane, not the block layer (R-itin-16)", () => {
    const item = makeItineraryItem({ id: "u-1", title: "Walk Shibuya" });
    const { days, maxAllDayCount } = buildGridDays(TRIP, [item], bookingsMap());
    expect(days[0]?.blocks).toHaveLength(0);
    expect(days[0]?.allDay[0]).toMatchObject({ itemId: "u-1", title: "Walk Shibuya" });
    expect(maxAllDayCount).toBe(1);
  });

  it("renders spanning lodging as lane segments across covered columns, never a full-height band (R-itin-31)", () => {
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
    // B-12 amended the pre-B-12 "no blocks at all" pin: the timed grid now
    // carries EXACTLY the two ~15-min checkpoint indicators (suite below) —
    // still never a full-height 15:00→11:00 band.
    expect(days.flatMap((d) => d.blocks).map((b) => b.checkpoint)).toEqual([
      "check-in",
      "check-out",
    ]);
    const segments = days.map((d) => d.spans[0]);
    expect(segments.map((seg) => seg?.isStart)).toEqual([true, false, false]);
    expect(segments.map((seg) => seg?.isEnd)).toEqual([false, false, true]);
    expect(segments.every((seg) => seg?.title === "Park Hyatt Tokyo")).toBe(true);
    expect(segments.every((seg) => seg?.bookingId === BOOKING_LODGING_ID)).toBe(true);
    expect(segments.every((seg) => seg?.lane === 0)).toBe(true);
  });

  describe("spanning-lodging checkpoint indicators (B-12 — ephemeral derived UI)", () => {
    const lodging = () =>
      makeItineraryItem({
        id: ITEM_LODGING_ID,
        kind: "booking",
        booking_id: BOOKING_LODGING_ID,
        title: null,
        day: TRIP_START,
        end_day: TRIP_END,
        start_time: "15:00",
        end_time: "11:00",
      });

    it("derives ~15-min indicators at the real check-in/check-out times from the ONE row", () => {
      // ONE itinerary row in (F-051 criterion 2 — the DB shape) …
      const { days } = buildGridDays(TRIP, [lodging()], bookingsMap());
      // … projects to a check-in block on `day` and a check-out block on
      // `end_day`, both ephemeral render data carrying the SAME item/booking
      // identity (they route to the same booking detail as the span).
      expect(days[0]?.blocks).toEqual([
        expect.objectContaining({
          itemId: ITEM_LODGING_ID,
          bookingId: BOOKING_LODGING_ID,
          checkpoint: "check-in",
          startMinutes: 15 * 60,
          endMinutes: 15 * 60 + CHECKPOINT_BLOCK_MINUTES,
          plusOne: false,
        }),
      ]);
      expect(days[2]?.blocks).toEqual([
        expect.objectContaining({
          itemId: ITEM_LODGING_ID,
          bookingId: BOOKING_LODGING_ID,
          checkpoint: "check-out",
          startMinutes: 11 * 60,
          endMinutes: 11 * 60 + CHECKPOINT_BLOCK_MINUTES,
        }),
      ]);
      // The night between shows nothing on the timed grid (§2.6 spirit).
      expect(days[1]?.blocks).toHaveLength(0);
    });

    it("skips an edge whose time is unset — no invented times", () => {
      const untimedCheckout = { ...lodging(), end_time: null };
      const { days } = buildGridDays(TRIP, [untimedCheckout], bookingsMap());
      expect(days[0]?.blocks.map((b) => b.checkpoint)).toEqual(["check-in"]);
      expect(days[2]?.blocks).toHaveLength(0);
    });

    it("joins the side-by-side split but neither carries nor causes the overlap badge", () => {
      // A real activity square over the 15:00 check-in.
      const activity = makeItineraryItem({
        id: "act-1",
        day: TRIP_START,
        start_time: "14:30",
        end_time: "16:00",
      });
      const { days } = buildGridDays(TRIP, [lodging(), activity], bookingsMap());
      const blocks = days[0]?.blocks ?? [];
      expect(blocks).toHaveLength(2);
      // Split so nothing is occluded (R-itin-15 geometry)…
      expect(blocks.map((b) => b.columns)).toEqual([2, 2]);
      // …but the WARNING stays item-vs-item: the ephemeral indicator must
      // not flag the real activity (a spanning lodging collides with
      // nothing), and never flags itself.
      expect(blocks.every((b) => b.overlapping === false)).toBe(true);
    });

    it("real-vs-real overlap still badges with an indicator present (control arm)", () => {
      const a = makeItineraryItem({
        id: "ov-a",
        day: TRIP_START,
        start_time: "14:00",
        end_time: "16:00",
      });
      const b = makeItineraryItem({
        id: "ov-b",
        day: TRIP_START,
        start_time: "15:30",
        end_time: "17:00",
      });
      const { days } = buildGridDays(TRIP, [lodging(), a, b], bookingsMap());
      const byId = new Map(days[0]?.blocks.map((block) => [block.itemId, block]));
      expect(byId.get("ov-a")?.overlapping).toBe(true);
      expect(byId.get("ov-b")?.overlapping).toBe(true);
      expect(byId.get(ITEM_LODGING_ID)?.overlapping).toBe(false);
    });
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

/**
 * Density → day-column geometry (T-7.13, R-itin-33/34). Pure. "Pager" below is
 * the window minus the hour gutter — the width the day columns share.
 *
 * What change makes these red: collapsing the `density` branching back to the
 * single `COLUMN_FRACTION` formula (every non-Day width/visible-count pin),
 * dropping the `MIN_COLUMN_WIDTH` floor (the 8+/60-day pins), or flipping
 * `snap` (the Trip-span continuous-scroll pin).
 */
describe("gridColumnLayout (R-itin-34 density → column geometry)", () => {
  // iPhone SE-class / iPhone 13-class / Pro Max-class widths + the jest default.
  const WINDOWS = [320, 360, 375, 390, 430, 750] as const;
  const pagerOf = (windowWidth: number) => windowWidth - GUTTER_WIDTH;

  describe("day (the default — regression pin)", () => {
    it.each(WINDOWS)(
      "is byte-identical to the pre-density formula at %ipt (one column + peek)",
      (w) => {
        const layout = gridColumnLayout("day", w, 3);
        expect(layout.columnWidth).toBe(Math.max(1, Math.round(pagerOf(w) * COLUMN_FRACTION)));
        expect(layout.visibleColumns).toBe(1);
        expect(layout.snap).toBe(true);
      },
    );

    it("ignores the trip length — a 1-day and a 60-day trip get the same Day column", () => {
      expect(gridColumnLayout("day", 375, 1)).toEqual(gridColumnLayout("day", 375, 60));
    });

    it("leaves a peek of the neighbor (column narrower than the pager)", () => {
      const layout = gridColumnLayout("day", 375, 5);
      expect(layout.columnWidth).toBe(301); // round(327 * 0.92)
      expect(layout.columnWidth).toBeLessThan(pagerOf(375));
    });
  });

  describe("3-day (three columns, no snap-peek)", () => {
    it.each(WINDOWS)("splits the pager three ways at %ipt — and never overflows it", (w) => {
      const layout = gridColumnLayout("3-day", w, 10);
      expect(layout.columnWidth).toBe(Math.floor(pagerOf(w) / THREE_DAY_COLUMNS));
      expect(layout.visibleColumns).toBe(3);
      expect(layout.snap).toBe(true);
      // No peek: three columns fit the pager exactly (to the rounding pixel).
      expect(layout.columnWidth * 3).toBeLessThanOrEqual(pagerOf(w));
      expect(layout.columnWidth * 3).toBeGreaterThan(pagerOf(w) - 3);
    });

    it("is narrower than Day (the whole point) and keeps no peek", () => {
      expect(gridColumnLayout("3-day", 375, 10).columnWidth).toBe(109);
      expect(gridColumnLayout("3-day", 375, 10).columnWidth).toBeLessThan(
        gridColumnLayout("day", 375, 10).columnWidth,
      );
    });

    it("is trip-length independent — a 1-day trip still gets a third-width column", () => {
      expect(gridColumnLayout("3-day", 375, 1).columnWidth).toBe(109);
      expect(gridColumnLayout("3-day", 375, 1).visibleColumns).toBe(3);
    });
  });

  describe("trip-span (every day at once, then continuous scroll)", () => {
    it("a 1-day trip is ONE full-width column (boundary)", () => {
      const layout = gridColumnLayout("trip-span", 375, 1);
      expect(layout.columnWidth).toBe(pagerOf(375));
      expect(layout.visibleColumns).toBe(1);
      expect(layout.snap).toBe(false);
    });

    it.each([
      [2, 163],
      [3, 109],
      [5, 65],
      [7, 46],
    ])("a %i-day trip fits whole at %ipt per column", (days, width) => {
      const layout = gridColumnLayout("trip-span", 375, days);
      expect(layout.columnWidth).toBe(width);
      expect(layout.visibleColumns).toBe(days);
      // Every day on screen at once — nothing to scroll to.
      expect(layout.columnWidth * days).toBeLessThanOrEqual(pagerOf(375));
    });

    it("never narrows past the floor — an 8-day trip scrolls instead (boundary)", () => {
      const layout = gridColumnLayout("trip-span", 375, 8);
      expect(layout.columnWidth).toBe(MIN_COLUMN_WIDTH);
      expect(layout.visibleColumns).toBe(7); // floor(327 / 44) — the 8th is off-screen
      expect(layout.visibleColumns).toBeLessThan(8);
    });

    it("a 60-day trip stays at the floor width — bounded, never sub-floor (no trip-length cap)", () => {
      const layout = gridColumnLayout("trip-span", 375, 60);
      expect(layout.columnWidth).toBe(MIN_COLUMN_WIDTH);
      expect(layout.visibleColumns).toBe(7);
      expect(layout.snap).toBe(false); // continuous scroll, no page-snap
    });

    it("a 3650-day trip is the same bounded floor — the width never depends on length past the floor", () => {
      expect(gridColumnLayout("trip-span", 375, 3650)).toEqual(
        gridColumnLayout("trip-span", 375, 60),
      );
    });

    it("a week fits a 360pt phone (the floor was chosen so)", () => {
      const layout = gridColumnLayout("trip-span", 360, 7);
      expect(layout.columnWidth).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
      expect(layout.visibleColumns).toBe(7);
    });

    it("never page-snaps in ANY trip length (continuous scroll, R-itin-34)", () => {
      for (const days of [1, 2, 7, 8, 60]) {
        expect(gridColumnLayout("trip-span", 390, days).snap).toBe(false);
      }
    });

    it("treats a zero-day model as one column — no divide-by-zero, no NaN width", () => {
      const layout = gridColumnLayout("trip-span", 375, 0);
      expect(layout.columnWidth).toBe(pagerOf(375));
      expect(Number.isFinite(layout.columnWidth)).toBe(true);
    });
  });

  describe("adversarial window widths", () => {
    it.each(["day", "3-day", "trip-span"] as const)(
      "%s: a window narrower than the gutter still yields a finite positive width",
      (density) => {
        for (const w of [0, 1, GUTTER_WIDTH - 1, GUTTER_WIDTH]) {
          const layout = gridColumnLayout(density, w, 5);
          expect(Number.isFinite(layout.columnWidth)).toBe(true);
          expect(layout.columnWidth).toBeGreaterThanOrEqual(1);
          expect(layout.visibleColumns).toBeGreaterThanOrEqual(1);
        }
      },
    );
  });

  it("the densities give three DIFFERENT geometries for the same trip (the branching is real)", () => {
    const day = gridColumnLayout("day", 375, 7);
    const three = gridColumnLayout("3-day", 375, 7);
    const span = gridColumnLayout("trip-span", 375, 7);
    expect(new Set([day.columnWidth, three.columnWidth, span.columnWidth]).size).toBe(3);
    expect([day.visibleColumns, three.visibleColumns, span.visibleColumns]).toEqual([1, 3, 7]);
  });
});

describe("clampLandingIndex (R-itin-17 landing, per density)", () => {
  it("Day lands on the R-itin-17 index untouched — even the last day", () => {
    expect(clampLandingIndex("day", 0, 10, 1)).toBe(0);
    expect(clampLandingIndex("day", 9, 10, 1)).toBe(9);
  });

  it("3-day never starts past the last full window (today = last day shows days N-2..N)", () => {
    expect(clampLandingIndex("3-day", 4, 10, 3)).toBe(4);
    expect(clampLandingIndex("3-day", 7, 10, 3)).toBe(7);
    expect(clampLandingIndex("3-day", 8, 10, 3)).toBe(7);
    expect(clampLandingIndex("3-day", 9, 10, 3)).toBe(7);
  });

  it("3-day on a trip shorter than the window lands on 0 (no negative index)", () => {
    expect(clampLandingIndex("3-day", 1, 2, 3)).toBe(0);
    expect(clampLandingIndex("3-day", 0, 1, 3)).toBe(0);
  });

  it("trip-span lands on 0 when every day fits (nothing to scroll)", () => {
    expect(clampLandingIndex("trip-span", 6, 7, 7)).toBe(0);
  });

  it("trip-span on an overflowing trip lands on today but never past the last full window", () => {
    expect(clampLandingIndex("trip-span", 30, 60, 7)).toBe(30);
    expect(clampLandingIndex("trip-span", 59, 60, 7)).toBe(53);
  });
});
