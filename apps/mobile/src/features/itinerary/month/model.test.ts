/**
 * Month model (T-7.14 — R-itin-35, R-itin-31/36, R-itin-45). Pure projection,
 * so every pin is a plain value assertion. Calendar anchors (all verified
 * against a calendar, not the code under test):
 * - 2027-03-01 is a MONDAY; March 2027 has 31 days.
 * - Sunday-first, March 2027 = Feb 28–Mar 6 · 7–13 · 14–20 · 21–27 · Mar 28–Apr 3.
 * - Monday-first, March 2027 = Mar 1–7 · 8–14 · 15–21 · 22–28 · Mar 29–Apr 4.
 * - Feb 2026 starts on a SUNDAY (28 days) → exactly 4 Sunday-first rows;
 *   Aug 2026 starts on a SATURDAY (31 days) → 6 rows either way;
 *   Nov 2025 starts on a SATURDAY (30 days) → 6 Sunday-first, 5 Monday-first rows.
 *
 * What change makes each group red (mutation-verified — see the PR body):
 * - week chunking (`w * DAYS_PER_WEEK` stride / `weekCount`)  → "weeks" pins;
 * - overflow cap (`Math.min(pointCount, MAX_DOTS)`)             → "dots" pins;
 * - span clipping at the week edges (`firstDate`/`lastDate`)    → "bars" pins;
 * - `end_day <= day` point guard / flight category gate         → "spanning set" pins;
 * - `interactive` ← day-set membership, `inTripRange` ← range   → "range" pins.
 */
import type { Booking, ISODate, ItineraryItem } from "@gogo/shared";

import { makeBooking, makeItineraryItem } from "@/test-utils/itinerary-fixtures";

import {
  buildMonthModel,
  cellLabel,
  dayDiff,
  landingMonthKey,
  MAX_DOTS,
  stepMonthIndex,
  weekdayHeaders,
  weekdayOf,
  weekStartOf,
  type MonthGrid,
  type MonthWeek,
} from "./model";

const TRIP = { start_date: "2027-03-01", end_date: "2027-03-21" } as const;

interface World {
  items: ItineraryItem[];
  bookingsById: Map<string, Booking>;
}

function world(...parts: { item: ItineraryItem; booking?: Booking }[]): World {
  const bookingsById = new Map<string, Booking>();
  for (const part of parts) {
    if (part.booking !== undefined) bookingsById.set(part.booking.id, part.booking);
  }
  return { items: parts.map((part) => part.item), bookingsById };
}

function lodging(id: string, day: ISODate, endDay: ISODate | null) {
  const bookingId = `book-${id}`;
  return {
    item: makeItineraryItem({
      id,
      kind: "booking",
      booking_id: bookingId,
      title: null,
      day,
      end_day: endDay,
      start_time: "15:00",
      end_time: "11:00",
    }),
    booking: makeBooking({
      id: bookingId,
      category: "lodging",
      title: `Hotel ${id}`,
      details: { category: "lodging" },
    }),
  };
}

function flight(id: string, day: ISODate, endDay: ISODate | null) {
  const bookingId = `book-${id}`;
  return {
    item: makeItineraryItem({
      id,
      kind: "booking",
      booking_id: bookingId,
      title: null,
      day,
      end_day: endDay,
      start_time: "22:00",
      end_time: "06:00",
    }),
    booking: makeBooking({
      id: bookingId,
      category: "flight",
      title: `Flight ${id}`,
      details: { category: "flight" },
    }),
  };
}

/** A non-flight/non-lodging category that still carries an `end_day`. */
function train(id: string, day: ISODate, endDay: ISODate | null) {
  const bookingId = `book-${id}`;
  return {
    item: makeItineraryItem({
      id,
      kind: "booking",
      booking_id: bookingId,
      title: null,
      day,
      end_day: endDay,
      start_time: "23:00",
    }),
    booking: makeBooking({
      id: bookingId,
      category: "train",
      title: `Train ${id}`,
      details: { category: "train" },
    }),
  };
}

function custom(id: string, day: ISODate) {
  return { item: makeItineraryItem({ id, title: `Custom ${id}`, day }) };
}

function build(
  w: World,
  trip: { start_date: ISODate; end_date: ISODate } = TRIP,
  weekStartsOn?: 0 | 1,
) {
  return buildMonthModel(trip, w.items, w.bookingsById, { weekStartsOn });
}

const monthOf = (model: ReturnType<typeof build>, key: string): MonthGrid => {
  const month = model.months.find((m) => m.key === key);
  if (month === undefined) throw new Error(`no month ${key}`);
  return month;
};

const weekOf = (month: MonthGrid, firstDate: ISODate): MonthWeek => {
  const week = month.weeks.find((w) => w.key === firstDate);
  if (week === undefined) throw new Error(`no week ${firstDate}`);
  return week;
};

const cellOf = (month: MonthGrid, date: ISODate) => {
  for (const week of month.weeks) {
    const cell = week.cells.find((c) => c.date === date);
    if (cell !== undefined) return cell;
  }
  throw new Error(`no cell ${date}`);
};

const emptyWorld = (): World => ({ items: [], bookingsById: new Map() });

describe("date helpers", () => {
  it("weekdayOf / weekStartOf agree with the calendar (2027-03-01 is a Monday)", () => {
    expect(weekdayOf("2027-03-01")).toBe(1);
    expect(weekdayOf("2027-02-28")).toBe(0);
    expect(weekStartOf("2027-03-03", 1)).toBe("2027-03-01");
    expect(weekStartOf("2027-03-03", 0)).toBe("2027-02-28");
    // A date that IS the week start maps to itself, in both conventions.
    expect(weekStartOf("2027-03-01", 1)).toBe("2027-03-01");
    expect(weekStartOf("2027-02-28", 0)).toBe("2027-02-28");
    // A Sunday belongs to the PREVIOUS week when weeks start Monday.
    expect(weekStartOf("2027-03-07", 1)).toBe("2027-03-01");
  });

  it("dayDiff counts calendar days across month/year/leap boundaries", () => {
    expect(dayDiff("2027-03-01", "2027-03-01")).toBe(0);
    expect(dayDiff("2027-02-27", "2027-03-02")).toBe(3);
    expect(dayDiff("2027-12-31", "2028-01-01")).toBe(1);
    expect(dayDiff("2028-02-28", "2028-03-01")).toBe(2); // 2028 is a leap year
    expect(dayDiff("2027-03-05", "2027-03-01")).toBe(-4);
  });

  it("weekdayHeaders rotates with the week start", () => {
    expect(weekdayHeaders(0)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(weekdayHeaders(1)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("cellLabel is '<weekday> <date>, N items' with a singular 'item' at exactly one", () => {
    expect(cellLabel("2027-03-04", 3)).toBe("Thu, Mar 4, 3 items");
    expect(cellLabel("2027-03-04", 1)).toBe("Thu, Mar 4, 1 item");
    expect(cellLabel("2027-03-04", 0)).toBe("Thu, Mar 4, 0 items");
  });
});

describe("weeks — week × 7 chunking", () => {
  it("HAPPY: a 3-week trip lays out Monday-first full weeks, 7 cells each, spilling into April", () => {
    const model = build(emptyWorld(), TRIP, 1);
    expect(model.months.map((m) => m.key)).toEqual(["2027-03"]);
    const march = monthOf(model, "2027-03");
    expect(march.title).toBe("March 2027");
    expect(march.weeks.map((w) => w.key)).toEqual([
      "2027-03-01",
      "2027-03-08",
      "2027-03-15",
      "2027-03-22",
      "2027-03-29",
    ]);
    for (const week of march.weeks) expect(week.cells).toHaveLength(7);
    // Every cell of a week is the 7 consecutive dates from its key.
    expect(march.weeks[1]?.cells.map((c) => c.date)).toEqual([
      "2027-03-08",
      "2027-03-09",
      "2027-03-10",
      "2027-03-11",
      "2027-03-12",
      "2027-03-13",
      "2027-03-14",
    ]);
    // The trail of the last row belongs to April — present but not in-month.
    const last = march.weeks[4];
    expect(last?.cells.map((c) => c.inMonth)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(last?.cells[6]?.date).toBe("2027-04-04");
  });

  it("Sunday-first is the default: March 2027 leads with Feb 28", () => {
    const march = monthOf(build(emptyWorld()), "2027-03");
    expect(march.weeks[0]?.key).toBe("2027-02-28");
    expect(march.weeks[0]?.cells[0]?.inMonth).toBe(false);
    expect(march.weeks[0]?.cells[1]?.date).toBe("2027-03-01");
    expect(march.weeks.map((w) => w.key)).toEqual([
      "2027-02-28",
      "2027-03-07",
      "2027-03-14",
      "2027-03-21",
      "2027-03-28",
    ]);
  });

  it("BOUNDARY: a month fits in exactly 4, 5 or 6 rows depending on where the 1st falls", () => {
    // Feb 2026 starts on a Sunday and has 28 days: exactly 4 Sunday-first rows.
    const feb = build(emptyWorld(), { start_date: "2026-02-10", end_date: "2026-02-12" });
    expect(monthOf(feb, "2026-02").weeks).toHaveLength(4);
    // Aug 2026 starts on a Saturday and has 31 days: 6 rows.
    const aug = build(emptyWorld(), { start_date: "2026-08-10", end_date: "2026-08-12" });
    expect(monthOf(aug, "2026-08").weeks).toHaveLength(6);
    // Nov 2025 starts on a Saturday and has 30 days: 6 Sunday-first rows, but
    // only 5 Monday-first (the 1st is the 6th column, not the 7th).
    const nov = { start_date: "2025-11-10", end_date: "2025-11-12" };
    expect(monthOf(build(emptyWorld(), nov), "2025-11").weeks).toHaveLength(6);
    expect(monthOf(build(emptyWorld(), nov, 1), "2025-11").weeks).toHaveLength(5);
    // The last row always holds the month's last day, the first row its first.
    const rows = monthOf(aug, "2026-08").weeks;
    expect(rows[0]?.cells.some((c) => c.date === "2026-08-01")).toBe(true);
    expect(rows[5]?.cells.some((c) => c.date === "2026-08-31")).toBe(true);
  });

  it("BOUNDARY: a leap February renders the 29th", () => {
    const feb = monthOf(
      build(emptyWorld(), { start_date: "2028-02-27", end_date: "2028-03-01" }),
      "2028-02",
    );
    expect(cellOf(feb, "2028-02-29").inMonth).toBe(true);
    expect(feb.weeks.flatMap((w) => w.cells).filter((c) => c.inMonth)).toHaveLength(29);
  });

  it("every week key is unique and weeks tile with no gap or overlap", () => {
    const march = monthOf(build(emptyWorld()), "2027-03");
    const dates = march.weeks.flatMap((w) => w.cells.map((c) => c.date));
    expect(new Set(dates).size).toBe(dates.length);
    for (let i = 1; i < dates.length; i += 1) {
      expect(dayDiff(dates[i - 1] as ISODate, dates[i] as ISODate)).toBe(1);
    }
  });
});

describe("months — which months exist (R-itin-45 sparse day set)", () => {
  it("BOUNDARY: a trip spanning two months yields two grids that share the boundary week", () => {
    const model = build(emptyWorld(), { start_date: "2027-03-29", end_date: "2027-04-02" });
    expect(model.months.map((m) => [m.key, m.title])).toEqual([
      ["2027-03", "March 2027"],
      ["2027-04", "April 2027"],
    ]);
    // Sunday-first: Mar 28–Apr 3 is the last March row AND the first April row.
    const marchLast = monthOf(model, "2027-03").weeks.at(-1) as MonthWeek;
    const aprilFirst = monthOf(model, "2027-04").weeks[0] as MonthWeek;
    expect(marchLast.key).toBe("2027-03-28");
    expect(aprilFirst.key).toBe("2027-03-28");
    // Same dates, opposite `inMonth` — which grid is looking decides.
    expect(marchLast.cells.map((c) => c.inMonth)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(aprilFirst.cells.map((c) => c.inMonth)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("BOUNDARY: a trip across New Year titles each grid with its own year", () => {
    const model = build(emptyWorld(), { start_date: "2026-12-30", end_date: "2027-01-02" });
    expect(model.months.map((m) => m.title)).toEqual(["December 2026", "January 2027"]);
  });

  it("BOUNDARY: a 1-day trip is one month with exactly one interactive cell", () => {
    const model = build(emptyWorld(), { start_date: "2027-03-10", end_date: "2027-03-10" });
    expect(model.months).toHaveLength(1);
    expect(model.days).toEqual(["2027-03-10"]);
    const interactive = monthOf(model, "2027-03")
      .weeks.flatMap((w) => w.cells)
      .filter((c) => c.interactive);
    expect(interactive.map((c) => c.date)).toEqual(["2027-03-10"]);
  });

  it("SPARSE: a stray item months past the trip adds ONE month, not the months between", () => {
    const w = world(custom("far", "2027-08-15"));
    const model = build(w);
    expect(model.months.map((m) => m.key)).toEqual(["2027-03", "2027-08"]);
    expect(model.days.at(-1)).toBe("2027-08-15");
  });

  it("DEGENERATE: an inverted trip range with no items has no months and no crash", () => {
    const model = build(emptyWorld(), { start_date: "2027-03-10", end_date: "2027-03-01" });
    expect(model.days).toEqual([]);
    expect(model.months).toEqual([]);
  });
});

describe("range — dimmed vs interactive (R-itin-35 'dimmed and inert')", () => {
  it("cells outside the trip range are dimmed; only day-set cells are interactive", () => {
    const march = monthOf(
      build(emptyWorld(), { start_date: "2027-03-03", end_date: "2027-03-05" }),
      "2027-03",
    );
    const inRange = ["2027-03-03", "2027-03-04", "2027-03-05"];
    for (const week of march.weeks) {
      for (const cell of week.cells) {
        const expected = inRange.includes(cell.date);
        expect(cell.inTripRange).toBe(expected);
        expect(cell.interactive).toBe(expected);
      }
    }
  });

  it("an item outside the trip range makes ITS day interactive-but-dimmed (it has a Day column)", () => {
    const march = monthOf(
      build(world(custom("late", "2027-03-20")), {
        start_date: "2027-03-03",
        end_date: "2027-03-05",
      }),
      "2027-03",
    );
    const late = cellOf(march, "2027-03-20");
    expect(late.inTripRange).toBe(false);
    expect(late.interactive).toBe(true);
    expect(late.pointCount).toBe(1);
    // …while its neighbors stay inert.
    expect(cellOf(march, "2027-03-19").interactive).toBe(false);
    expect(cellOf(march, "2027-03-21").interactive).toBe(false);
  });
});

describe("dots — item-count dots + '+N' overflow (R-itin-35)", () => {
  it("HAPPY: a mixed 3-week trip counts point items per day and keeps spans out of the dots", () => {
    const w = world(
      flight("f1", "2027-03-01", null),
      custom("c1", "2027-03-02"),
      custom("c2", "2027-03-02"),
      lodging("h1", "2027-03-03", "2027-03-10"),
      {
        item: makeItineraryItem({ id: "p1", kind: "place_visit", title: null, day: "2027-03-10" }),
      },
    );
    const march = monthOf(build(w, TRIP, 1), "2027-03");
    expect(cellOf(march, "2027-03-01")).toMatchObject({ pointCount: 1, dotCount: 1, itemCount: 1 });
    expect(cellOf(march, "2027-03-02")).toMatchObject({
      pointCount: 2,
      dotCount: 2,
      overflowCount: 0,
    });
    // The stay's nights: no dots, but the day is NOT empty to a screen reader.
    expect(cellOf(march, "2027-03-05")).toMatchObject({ pointCount: 0, dotCount: 0, itemCount: 1 });
    // Check-out day: one point (the place visit) + the covering stay.
    expect(cellOf(march, "2027-03-10")).toMatchObject({ pointCount: 1, itemCount: 2 });
    expect(cellOf(march, "2027-03-11")).toMatchObject({ pointCount: 0, itemCount: 0 });
  });

  it("EMPTY: a month with no items has no dots, no overflow, no bars, and '0 items' labels", () => {
    const march = monthOf(build(emptyWorld()), "2027-03");
    for (const week of march.weeks) {
      expect(week.bars).toEqual([]);
      expect(week.laneCount).toBe(0);
      for (const cell of week.cells) {
        expect(cell).toMatchObject({ pointCount: 0, itemCount: 0, dotCount: 0, overflowCount: 0 });
        expect(cell.label).toMatch(/, 0 items$/);
      }
    }
  });

  it("BOUNDARY: exactly MAX_DOTS items → three dots, no marker; one more → '+1'", () => {
    expect(MAX_DOTS).toBe(3);
    const three = monthOf(
      build(world(custom("a", "2027-03-02"), custom("b", "2027-03-02"), custom("c", "2027-03-02"))),
      "2027-03",
    );
    expect(cellOf(three, "2027-03-02")).toMatchObject({ dotCount: 3, overflowCount: 0 });
    const four = monthOf(
      build(
        world(
          custom("a", "2027-03-02"),
          custom("b", "2027-03-02"),
          custom("c", "2027-03-02"),
          custom("d", "2027-03-02"),
        ),
      ),
      "2027-03",
    );
    expect(cellOf(four, "2027-03-02")).toMatchObject({
      dotCount: 3,
      overflowCount: 1,
      itemCount: 4,
    });
  });

  it("ADVERSARIAL: 35 items on one day cap at three dots and fold the rest into '+32'", () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      custom(`x${String(i).padStart(2, "0")}`, "2027-03-02"),
    );
    const cell = cellOf(monthOf(build(world(...many)), "2027-03"), "2027-03-02");
    expect(cell.pointCount).toBe(35);
    expect(cell.dotCount).toBe(3);
    expect(cell.overflowCount).toBe(32);
    // The announced count is the TRUE count, never the capped one.
    expect(cell.label).toBe("Tue, Mar 2, 35 items");
  });
});

describe("spanning set — which items become bars (R-itin-31 / R-itin-36 / R-itin-52)", () => {
  const barIds = (month: MonthGrid) => month.weeks.flatMap((w) => w.bars.map((b) => b.itemId));

  it("a spanning lodging is a bar via the default two-entry projection", () => {
    const march = monthOf(
      build(world(lodging("h1", "2027-03-03", "2027-03-05")), TRIP, 1),
      "2027-03",
    );
    const [bar] = weekOf(march, "2027-03-01").bars;
    expect(bar).toMatchObject({
      itemId: "h1",
      bookingId: "book-h1",
      title: "Hotel h1",
      startCol: 2,
      endCol: 4,
      spanStart: "2027-03-03",
      spanEnd: "2027-03-05",
    });
  });

  it("an overnight FLIGHT (end_day > day) is a bar like lodging — NOT the list-mode Departs/Arrives split", () => {
    const march = monthOf(
      build(world(flight("f1", "2027-03-03", "2027-03-04")), TRIP, 1),
      "2027-03",
    );
    expect(barIds(march)).toEqual(["f1"]);
    const week = weekOf(march, "2027-03-01");
    expect(week.bars).toHaveLength(1);
    expect(week.bars[0]).toMatchObject({ startCol: 2, endCol: 3 });
    // No dot on either end — the bar IS the representation.
    expect(cellOf(march, "2027-03-03").pointCount).toBe(0);
    expect(cellOf(march, "2027-03-04").pointCount).toBe(0);
  });

  it("ADVERSARIAL: a flight whose end_day PRECEDES day stays a point (wire-invalid, never a backwards bar)", () => {
    const march = monthOf(
      build(world(flight("f1", "2027-03-05", "2027-03-03")), TRIP, 1),
      "2027-03",
    );
    expect(barIds(march)).toEqual([]);
    expect(cellOf(march, "2027-03-05")).toMatchObject({ pointCount: 1, dotCount: 1 });
    expect(cellOf(march, "2027-03-03").pointCount).toBe(0);
  });

  it("a same-day flight (end_day === day) and a lodging with end_day <= day stay points", () => {
    const march = monthOf(
      build(
        world(
          flight("f1", "2027-03-05", "2027-03-05"),
          flight("f2", "2027-03-06", null),
          lodging("h1", "2027-03-08", "2027-03-08"),
          lodging("h2", "2027-03-09", "2027-03-07"),
        ),
        TRIP,
        1,
      ),
      "2027-03",
    );
    expect(barIds(march)).toEqual([]);
    expect(cellOf(march, "2027-03-05").pointCount).toBe(1);
    expect(cellOf(march, "2027-03-06").pointCount).toBe(1);
    expect(cellOf(march, "2027-03-08").pointCount).toBe(1);
    expect(cellOf(march, "2027-03-09").pointCount).toBe(1);
  });

  it("other categories with an end_day (train) keep the §2.6 one-point treatment — one dot on `day`", () => {
    const march = monthOf(
      build(world(train("t1", "2027-03-03", "2027-03-04")), TRIP, 1),
      "2027-03",
    );
    expect(barIds(march)).toEqual([]);
    expect(cellOf(march, "2027-03-03")).toMatchObject({ pointCount: 1, dotCount: 1 });
    expect(cellOf(march, "2027-03-04").pointCount).toBe(0);
  });

  it("an unknown parent booking (enrichment gap) with an end_day fails safe to a point", () => {
    const orphan = makeItineraryItem({
      id: "o1",
      kind: "booking",
      booking_id: "missing-booking",
      title: null,
      day: "2027-03-03",
      end_day: "2027-03-06",
    });
    const march = monthOf(build({ items: [orphan], bookingsById: new Map() }, TRIP, 1), "2027-03");
    expect(barIds(march)).toEqual([]);
    expect(cellOf(march, "2027-03-03").pointCount).toBe(1);
  });
});

describe("bars — week clipping, continuation markers, lanes", () => {
  it("BOUNDARY: a stay crossing a week boundary is clipped at the edge with continuation flags", () => {
    // Mar 3 (Wed) → Mar 10 (Wed), Monday-first: week 1 holds Wed–Sun, week 2 Mon–Wed.
    const march = monthOf(
      build(world(lodging("h1", "2027-03-03", "2027-03-10")), TRIP, 1),
      "2027-03",
    );
    const [first] = weekOf(march, "2027-03-01").bars;
    const [second] = weekOf(march, "2027-03-08").bars;
    expect(first).toMatchObject({
      startCol: 2,
      endCol: 6,
      firstDate: "2027-03-03",
      lastDate: "2027-03-07",
      continuesBefore: false,
      continuesAfter: true,
    });
    expect(second).toMatchObject({
      startCol: 0,
      endCol: 2,
      firstDate: "2027-03-08",
      lastDate: "2027-03-10",
      continuesBefore: true,
      continuesAfter: false,
    });
    // One segment per week row; none leak into weeks the stay never touches.
    expect(weekOf(march, "2027-03-15").bars).toEqual([]);
    // Segment keys are unique across the surface (the testID's date qualifier).
    expect(first?.key).not.toBe(second?.key);
  });

  it("a stay that covers a whole middle week fills columns 0–6 and continues both ways", () => {
    const march = monthOf(
      build(world(lodging("h1", "2027-03-03", "2027-03-17")), TRIP, 1),
      "2027-03",
    );
    const middle = weekOf(march, "2027-03-08").bars[0];
    expect(middle).toMatchObject({
      startCol: 0,
      endCol: 6,
      continuesBefore: true,
      continuesAfter: true,
    });
    // Never wider than a week, whatever the span.
    for (const week of march.weeks) {
      for (const bar of week.bars) {
        expect(bar.startCol).toBeGreaterThanOrEqual(0);
        expect(bar.endCol).toBeLessThanOrEqual(6);
        expect(bar.startCol).toBeLessThanOrEqual(bar.endCol);
      }
    }
  });

  it("BOUNDARY: a booking spanning a MONTH boundary draws the same segment in both grids", () => {
    // Mar 30 → Apr 5, Sunday-first: Mar 28–Apr 3 then Apr 4–10.
    const w = world(lodging("h1", "2027-03-30", "2027-04-05"));
    const model = build(w, { start_date: "2027-03-28", end_date: "2027-04-06" });
    const marchRow = weekOf(monthOf(model, "2027-03"), "2027-03-28").bars[0];
    const aprilRow = weekOf(monthOf(model, "2027-04"), "2027-03-28").bars[0];
    expect(marchRow).toEqual(aprilRow);
    expect(marchRow).toMatchObject({ startCol: 2, endCol: 6, continuesAfter: true });
    const aprilNext = weekOf(monthOf(model, "2027-04"), "2027-04-04").bars[0];
    expect(aprilNext).toMatchObject({
      startCol: 0,
      endCol: 1,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it("a 1-day-trip booking that is a single-night stay spans exactly two cells", () => {
    const march = monthOf(
      build(
        world(lodging("h1", "2027-03-10", "2027-03-11")),
        { start_date: "2027-03-10", end_date: "2027-03-10" },
        1,
      ),
      "2027-03",
    );
    const [bar] = weekOf(march, "2027-03-08").bars;
    expect(bar).toMatchObject({ startCol: 2, endCol: 3 });
  });

  it("overlapping spans stack in distinct lanes; abutting ones share a lane", () => {
    const march = monthOf(
      build(
        world(
          lodging("a", "2027-03-01", "2027-03-03"),
          lodging("b", "2027-03-03", "2027-03-05"), // overlaps a on the 3rd
          flight("c", "2027-03-06", "2027-03-07"), // starts after b ends → reuses a lane
        ),
        TRIP,
        1,
      ),
      "2027-03",
    );
    const week = weekOf(march, "2027-03-01");
    const lane = (id: string) => week.bars.find((b) => b.itemId === id)?.lane;
    expect(lane("a")).toBe(0);
    expect(lane("b")).toBe(1);
    expect(lane("c")).toBe(0);
    expect(week.laneCount).toBe(2);
    // The lane count is per week — an untouched week reserves nothing.
    expect(weekOf(march, "2027-03-15").laneCount).toBe(0);
  });

  it("ADVERSARIAL: a year-long stay clips to every rendered week and never overflows a row", () => {
    const march = monthOf(
      build(world(lodging("h1", "2027-01-01", "2028-01-01")), TRIP, 1),
      "2027-03",
    );
    for (const week of march.weeks) {
      expect(week.bars).toHaveLength(1);
      expect(week.bars[0]).toMatchObject({
        startCol: 0,
        endCol: 6,
        continuesBefore: true,
        continuesAfter: true,
      });
    }
  });

  it("a stay wholly outside the trip still draws across the calendar (its middle days are inert)", () => {
    const w = world(lodging("far", "2027-04-20", "2027-04-25"));
    const model = build(w);
    expect(model.months.map((m) => m.key)).toEqual(["2027-03", "2027-04"]);
    const april = monthOf(model, "2027-04");
    const row = april.weeks.find((wk) => wk.bars.length > 0) as MonthWeek;
    expect(row.bars[0]).toMatchObject({ spanStart: "2027-04-20", spanEnd: "2027-04-25" });
    // The ends are day-set members (clickable); a night between is not.
    expect(cellOf(april, "2027-04-20").interactive).toBe(true);
    expect(cellOf(april, "2027-04-25").interactive).toBe(true);
    expect(cellOf(april, "2027-04-22")).toMatchObject({ interactive: false, itemCount: 1 });
  });
});

describe("a11y labels (R-itin-30)", () => {
  it("every cell of a month grid carries a UNIQUE '<weekday> <date>, N items' label", () => {
    const w = world(custom("a", "2027-03-02"), lodging("h1", "2027-03-03", "2027-03-06"));
    const model = build(w, { start_date: "2027-03-01", end_date: "2027-04-10" });
    for (const month of model.months) {
      const labels = month.weeks.flatMap((wk) => wk.cells.map((c) => c.label));
      expect(new Set(labels).size).toBe(labels.length);
      for (const label of labels)
        expect(label).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d+ items?$/);
    }
    expect(cellOf(monthOf(model, "2027-03"), "2027-03-04").label).toBe("Thu, Mar 4, 1 item");
    expect(cellOf(monthOf(model, "2027-03"), "2027-03-02").label).toBe("Tue, Mar 2, 1 item");
  });
});

describe("landingMonthKey (R-itin-35 → R-itin-17's landing rule)", () => {
  const days = ["2027-03-30", "2027-03-31", "2027-04-01", "2027-04-02"];

  it("lands on today's month when today is a day-set date", () => {
    expect(landingMonthKey(days, "2027-04-01")).toBe("2027-04");
    expect(landingMonthKey(days, "2027-03-31")).toBe("2027-03");
  });

  it("lands on the FIRST day's month when today is outside the set (before or after)", () => {
    expect(landingMonthKey(days, "2027-02-01")).toBe("2027-03");
    expect(landingMonthKey(days, "2027-09-09")).toBe("2027-03");
  });

  it("an empty day set has no landing month", () => {
    expect(landingMonthKey([], "2027-03-01")).toBeNull();
  });
});

describe("stepMonthIndex — the stepper can never leave the touched months", () => {
  it("steps forward and back", () => {
    expect(stepMonthIndex(0, 1, 3)).toBe(1);
    expect(stepMonthIndex(2, -1, 3)).toBe(1);
  });

  it("BOUNDARY: clamps at both ends (no -1, no count)", () => {
    expect(stepMonthIndex(0, -1, 3)).toBe(0);
    expect(stepMonthIndex(2, 1, 3)).toBe(2);
    expect(stepMonthIndex(0, 1, 1)).toBe(0);
    expect(stepMonthIndex(0, -1, 0)).toBe(0);
  });
});
