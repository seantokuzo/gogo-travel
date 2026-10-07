/**
 * MonthSurface (T-7.14 — R-itin-35, R-itin-30, §2.9). The model's arithmetic is
 * pinned in `model.test.ts`; this file pins what only the RENDER can break:
 * the 7 × N grid, the tap → `onSelectDay(ISO)` route, the a11y labels and
 * testIDs, dots/overflow in the tree, the bars (one element per week-row
 * segment, squared where the run continues), dim vs inert, the month stepper,
 * and the "reports a day, persists nothing" contract with T-7.16.
 *
 * What change makes each group red (mutation-verified — see the PR body):
 * - grid / tap:       a cell's `onPress` reports a different day, or the cell
 *                     stops being pressable                      → "taps" pins;
 * - a11y:             a cell loses `accessibilityLabel` (pressable OR inert
 *                     branch)                                    → "a11y" pins;
 * - dots:             the dot loop ignores the cap / the "+N" is not drawn
 *                                                                → "dots" pins;
 * - inert vs dimmed:  an inert cell gains a press handler / dimming dropped
 *                                                                → "range" pins;
 * - bars:             a continuing edge is rounded / a decorative bar
 *                     intercepts / the booking route is dropped  → "bars" pins;
 * - stepper:          shown for one month / not disabled at the ends / stuck
 *                                                                → "stepper" pins;
 * - contract:         the surface stores density itself          → "contract" pin.
 *
 * Inert cells are plain Views (no handler), NOT disabled Pressables: RNTL will
 * not fire a handler on a `disabled` element, so a press-and-assert-nothing
 * pin on a disabled cell would pass with the guard ungated (mobile.md). The
 * pins assert the SPY (`onSelectDay` never called) and a control press proves
 * the spy can fire.
 */
import type { Booking, ISODate, ItineraryItem, TripWithRole } from "@gogo/shared";
import { fireEvent, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import { makeBooking, makeItineraryItem } from "@/test-utils/itinerary-fixtures";
import { renderWithTheme } from "@/test-utils/render";
import { makeTrip } from "@/test-utils/trip-fixtures";
import { localTodayISO } from "@/navigation/trip-defaults";

import * as gridDensity from "../grid/grid-density";
import { MonthSurface, type MonthSurfaceProps } from "./MonthSurface";

const TRIP = makeTrip({ id: "trip-1", start_date: "2027-03-01", end_date: "2027-03-21" });

interface Part {
  item: ItineraryItem;
  booking?: Booking;
}

function custom(id: string, day: ISODate): Part {
  return { item: makeItineraryItem({ id, title: `Custom ${id}`, day }) };
}

function lodging(id: string, day: ISODate, endDay: ISODate): Part {
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

function flight(id: string, day: ISODate, endDay: ISODate | null): Part {
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
    }),
    booking: makeBooking({
      id: bookingId,
      category: "flight",
      title: `Flight ${id}`,
      details: { category: "flight" },
    }),
  };
}

async function renderMonth(
  parts: Part[] = [],
  overrides: Partial<MonthSurfaceProps> = {},
): Promise<{ onSelectDay: jest.Mock }> {
  const onSelectDay = jest.fn();
  const bookingsById = new Map<string, Booking>();
  for (const part of parts)
    if (part.booking !== undefined) bookingsById.set(part.booking.id, part.booking);
  await renderWithTheme(
    <MonthSurface
      trip={TRIP}
      items={parts.map((part) => part.item)}
      bookingsById={bookingsById}
      onSelectDay={onSelectDay}
      today="2027-03-10"
      {...overrides}
    />,
  );
  return { onSelectDay };
}

/** The strip is hidden from assistive tech on purpose, so query it include-hidden. */
const weekdayHeaderTexts = () =>
  screen
    .getAllByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/, { includeHiddenElements: true })
    .map((el) => el.props.children as string);

const cell = (date: ISODate) => screen.getByTestId(`itinerary-month-day-${date}`);
const allCells = () => screen.getAllByTestId(/^itinerary-month-day-/);
const styleOf = (el: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(el.props.style as never) ?? {}) as Record<string, unknown>;

afterEach(() => {
  jest.restoreAllMocks();
});

describe("MonthSurface — grid shape", () => {
  it("HAPPY: renders the landing month as 7 columns × N full weeks, with title and weekday headers", async () => {
    await renderMonth([
      custom("c1", "2027-03-02"),
      custom("c2", "2027-03-02"),
      lodging("h1", "2027-03-03", "2027-03-10"),
    ]);
    expect(screen.getByTestId("itinerary-month-surface")).toBeOnTheScreen();
    expect(screen.getByTestId("itinerary-month-title")).toHaveTextContent("March 2027");
    expect(weekdayHeaderTexts()).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    // March 2027 Sunday-first = 5 rows × 7 = 35 cells, Feb 28 .. Apr 3, no gaps.
    const ids = allCells().map((el) => el.props.testID as string);
    expect(ids).toHaveLength(35);
    expect(ids[0]).toBe("itinerary-month-day-2027-02-28");
    expect(ids[34]).toBe("itinerary-month-day-2027-04-03");
    expect(new Set(ids).size).toBe(35);
  });

  it("EMPTY: a month with no items has no dots, no overflow, no bars — and '0 items' on every cell", async () => {
    await renderMonth([]);
    expect(screen.queryAllByTestId(/^itinerary-month-dot-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^itinerary-month-overflow-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^itinerary-month-span-/)).toHaveLength(0);
    for (const el of allCells()) expect(el.props.accessibilityLabel).toMatch(/, 0 items$/);
  });

  it("BOUNDARY: a trip shorter than a week is still one full-width month grid", async () => {
    await renderMonth([], { trip: { start_date: "2027-03-10", end_date: "2027-03-12" } });
    expect(allCells()).toHaveLength(35);
    // Only the three trip days are pressable.
    const pressable = allCells().filter((el) => el.props.accessibilityRole === "button");
    expect(pressable.map((el) => el.props.testID)).toEqual([
      "itinerary-month-day-2027-03-10",
      "itinerary-month-day-2027-03-11",
      "itinerary-month-day-2027-03-12",
    ]);
  });

  it("BOUNDARY: a 1-day trip renders and its single day routes", async () => {
    const { onSelectDay } = await renderMonth([], {
      trip: { start_date: "2027-03-10", end_date: "2027-03-10" },
    });
    await fireEvent.press(cell("2027-03-10"));
    expect(onSelectDay).toHaveBeenCalledWith("2027-03-10");
  });

  it("honors weekStartsOn=1 — Monday-first headers and a Mar 1 first cell", async () => {
    await renderMonth([], { weekStartsOn: 1 });
    expect(weekdayHeaderTexts()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(allCells()[0]?.props.testID).toBe("itinerary-month-day-2027-03-01");
    expect(allCells()[34]?.props.testID).toBe("itinerary-month-day-2027-04-04");
  });
});

describe("MonthSurface — taps route the day (R-itin-35)", () => {
  it("a day-cell press reports exactly that cell's ISO day, once", async () => {
    const { onSelectDay } = await renderMonth([custom("c1", "2027-03-02")]);
    await fireEvent.press(cell("2027-03-10"));
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    expect(onSelectDay).toHaveBeenLastCalledWith("2027-03-10");
    await fireEvent.press(cell("2027-03-02"));
    expect(onSelectDay).toHaveBeenCalledTimes(2);
    expect(onSelectDay).toHaveBeenLastCalledWith("2027-03-02");
  });

  it("an empty in-range day routes too — Day density is where the gap-tap add lives", async () => {
    const { onSelectDay } = await renderMonth([]);
    await fireEvent.press(cell("2027-03-21"));
    expect(onSelectDay).toHaveBeenCalledWith("2027-03-21");
  });

  it("CONTRACT (T-7.16): the surface reports a day and persists nothing — density is the screen's", async () => {
    // Falsification: a `storeGridDensity(...)` call anywhere in the tap path.
    const store = jest.spyOn(gridDensity, "storeGridDensity");
    const { onSelectDay } = await renderMonth([custom("c1", "2027-03-02")]);
    await fireEvent.press(cell("2027-03-02"));
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    expect(store).not.toHaveBeenCalled();
    expect(gridDensity.readGridDensity(TRIP.id)).toBe("day");
  });
});

describe("MonthSurface — a11y labels + testIDs (R-itin-30)", () => {
  it("every cell is labelled '<weekday> <date>, N items', and the labels are unique", async () => {
    await renderMonth([
      custom("c1", "2027-03-02"),
      custom("c2", "2027-03-02"),
      lodging("h1", "2027-03-03", "2027-03-10"),
    ]);
    const labels = allCells().map((el) => el.props.accessibilityLabel as string);
    expect(labels).toHaveLength(35);
    expect(new Set(labels).size).toBe(35);
    for (const label of labels)
      expect(label).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d+ items?$/);
    expect(cell("2027-03-02").props.accessibilityLabel).toBe("Tue, Mar 2, 2 items");
    // A night inside the stay announces the booking (the bar is invisible to VoiceOver).
    expect(cell("2027-03-05").props.accessibilityLabel).toBe("Fri, Mar 5, 1 item");
    expect(cell("2027-03-11").props.accessibilityLabel).toBe("Thu, Mar 11, 0 items");
  });

  it("pressable cells are buttons; inert cells are announced as disabled, with the same label grammar", async () => {
    await renderMonth([]);
    expect(cell("2027-03-05").props.accessibilityRole).toBe("button");
    const inert = cell("2027-03-25");
    expect(inert.props.accessibilityLabel).toBe("Thu, Mar 25, 0 items");
    expect(inert.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    expect(inert.props.accessibilityRole).toBeUndefined();
  });

  it("the month title is a header and the weekday strip is hidden from assistive tech (no duplicate announce)", async () => {
    await renderMonth([]);
    expect(screen.getByTestId("itinerary-month-title").props.accessibilityRole).toBe("header");
    // Hidden from assistive tech ⇒ RNTL's default (accessibility-visible) query
    // cannot see it; the include-hidden query proves it IS rendered.
    expect(screen.queryByTestId("itinerary-month-weekdays")).toBeNull();
    expect(
      screen.getByTestId("itinerary-month-weekdays", { includeHiddenElements: true }),
    ).toBeOnTheScreen();
  });

  it("the §2.9 ids exist for the root, day cells, dots, overflow and spanning bars", async () => {
    await renderMonth([
      custom("c1", "2027-03-02"),
      custom("c2", "2027-03-02"),
      custom("c3", "2027-03-02"),
      custom("c4", "2027-03-02"),
      lodging("h1", "2027-03-03", "2027-03-05"),
    ]);
    expect(screen.getByTestId("itinerary-month-surface")).toBeOnTheScreen();
    expect(screen.getByTestId("itinerary-month-day-2027-03-02")).toBeOnTheScreen();
    expect(screen.getByTestId("itinerary-month-dot-2027-03-02-0")).toBeOnTheScreen();
    expect(screen.getByTestId("itinerary-month-overflow-2027-03-02")).toBeOnTheScreen();
    expect(screen.getByTestId("itinerary-month-span-book-h1-2027-03-03")).toBeOnTheScreen();
  });
});

describe("MonthSurface — dots + '+N' overflow (R-itin-35)", () => {
  const dotsOn = (date: ISODate) =>
    screen.queryAllByTestId(new RegExp(`^itinerary-month-dot-${date}-`));

  it("draws one dot per item up to three, with no marker at exactly three", async () => {
    await renderMonth([
      custom("a", "2027-03-02"),
      custom("b", "2027-03-02"),
      custom("c", "2027-03-02"),
    ]);
    expect(dotsOn("2027-03-02")).toHaveLength(3);
    expect(screen.queryByTestId("itinerary-month-overflow-2027-03-02")).toBeNull();
  });

  it("BOUNDARY: a fourth item adds '+1', not a fourth dot", async () => {
    await renderMonth(["a", "b", "c", "d"].map((id) => custom(id, "2027-03-02")));
    expect(dotsOn("2027-03-02")).toHaveLength(3);
    expect(screen.getByTestId("itinerary-month-overflow-2027-03-02")).toHaveTextContent("+1");
  });

  it("ADVERSARIAL: 35 items on one day → exactly 3 dots and '+32' (not 35 nodes), labelled with the true count", async () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      custom(`x${String(i).padStart(2, "0")}`, "2027-03-02"),
    );
    await renderMonth(many);
    expect(dotsOn("2027-03-02")).toHaveLength(3);
    expect(screen.getByTestId("itinerary-month-overflow-2027-03-02")).toHaveTextContent("+32");
    expect(cell("2027-03-02").props.accessibilityLabel).toBe("Tue, Mar 2, 35 items");
  });

  it("a spanning stay adds NO dot — the bar is its mark", async () => {
    await renderMonth([lodging("h1", "2027-03-03", "2027-03-05")]);
    expect(dotsOn("2027-03-03")).toHaveLength(0);
    expect(dotsOn("2027-03-04")).toHaveLength(0);
    expect(dotsOn("2027-03-05")).toHaveLength(0);
  });
});

describe("MonthSurface — range: dimmed vs inert (R-itin-35)", () => {
  it("outside the trip range a cell is dimmed; inside it is not", async () => {
    await renderMonth([]);
    expect(styleOf(cell("2027-03-25")).opacity).toBe(0.4);
    expect(styleOf(cell("2027-02-28")).opacity).toBe(0.4);
    expect(styleOf(cell("2027-03-10")).opacity).toBeUndefined();
  });

  it("an out-of-range day with NO content is inert — pressing it reports nothing (the spy can fire: control press)", async () => {
    const { onSelectDay } = await renderMonth([]);
    await fireEvent.press(cell("2027-03-25"));
    await fireEvent.press(cell("2027-02-28"));
    expect(onSelectDay).not.toHaveBeenCalled();
    // CONTROL: the same spy does fire for a live cell.
    await fireEvent.press(cell("2027-03-10"));
    expect(onSelectDay).toHaveBeenCalledTimes(1);
  });

  it("an out-of-range day WITH an item has a Day column, so it is dimmed but still routes", async () => {
    const { onSelectDay } = await renderMonth([custom("late", "2027-03-25")]);
    expect(styleOf(cell("2027-03-25")).opacity).toBe(0.4);
    await fireEvent.press(cell("2027-03-25"));
    expect(onSelectDay).toHaveBeenCalledWith("2027-03-25");
    // …its neighbors, which have no column, stay inert.
    await fireEvent.press(cell("2027-03-24"));
    expect(onSelectDay).toHaveBeenCalledTimes(1);
  });

  it("lead/trail days of the adjacent month print muted but keep their own range rules", async () => {
    await renderMonth([], { trip: { start_date: "2027-03-29", end_date: "2027-04-02" } });
    // Mar 28–Apr 3 is the shared row: Mar 29–31 are in range and in March.
    expect(styleOf(cell("2027-03-30")).opacity).toBeUndefined();
    expect(styleOf(cell("2027-03-28")).opacity).toBe(0.4);
  });
});

describe("MonthSurface — spanning bars (R-itin-31 / R-itin-36 → R-itin-35)", () => {
  it("a stay that crosses a week boundary is TWO segments, each clipped to its own week row", async () => {
    // Sunday-first: Mar 3 (Wed) → Mar 10 (Wed) = Wed–Sat in row 1, Sun–Wed in row 2.
    await renderMonth([lodging("h1", "2027-03-03", "2027-03-10")]);
    const first = screen.getByTestId("itinerary-month-span-book-h1-2027-03-03");
    const second = screen.getByTestId("itinerary-month-span-book-h1-2027-03-07");
    expect(screen.queryAllByTestId(/^itinerary-month-span-/)).toHaveLength(2);
    expect(styleOf(first)).toMatchObject({ left: `${(3 / 7) * 100}%`, width: `${(4 / 7) * 100}%` });
    expect(styleOf(second)).toMatchObject({ left: "0%", width: `${(4 / 7) * 100}%` });
  });

  it("continuation markers: rounded + inset where the stay truly begins/ends, squared where it runs on", async () => {
    await renderMonth([lodging("h1", "2027-03-03", "2027-03-10")]);
    const first = styleOf(screen.getByTestId("itinerary-month-span-book-h1-2027-03-03"));
    const second = styleOf(screen.getByTestId("itinerary-month-span-book-h1-2027-03-07"));
    // Row 1: true start (rounded left), continues (square right).
    expect(first.borderTopLeftRadius).toBe(5);
    expect(first.marginLeft).toBe(3);
    expect(first.borderTopRightRadius).toBeUndefined();
    expect(first.marginRight).toBeUndefined();
    // Row 2: continues from before (square left), true end (rounded right).
    expect(second.borderTopLeftRadius).toBeUndefined();
    expect(second.marginLeft).toBeUndefined();
    expect(second.borderTopRightRadius).toBe(5);
    expect(second.marginRight).toBe(3);
  });

  it("an overnight FLIGHT draws a bar like lodging (not a dot)", async () => {
    await renderMonth([flight("f1", "2027-03-04", "2027-03-05")]);
    expect(screen.getByTestId("itinerary-month-span-book-f1-2027-03-04")).toBeOnTheScreen();
    expect(screen.queryAllByTestId(/^itinerary-month-dot-/)).toHaveLength(0);
  });

  it("ADVERSARIAL: a flight whose end_day precedes day stays a point — one dot, no bar", async () => {
    await renderMonth([flight("f1", "2027-03-05", "2027-03-03")]);
    expect(screen.queryAllByTestId(/^itinerary-month-span-/)).toHaveLength(0);
    expect(screen.getByTestId("itinerary-month-dot-2027-03-05-0")).toBeOnTheScreen();
  });

  it("overlapping stays stack in distinct vertical lanes of the same week", async () => {
    await renderMonth([
      lodging("a", "2027-03-01", "2027-03-03"),
      lodging("b", "2027-03-02", "2027-03-04"),
    ]);
    const a = styleOf(screen.getByTestId("itinerary-month-span-book-a-2027-03-01"));
    const b = styleOf(screen.getByTestId("itinerary-month-span-book-b-2027-03-02"));
    expect(typeof a.top).toBe("number");
    expect(b.top as number).toBeGreaterThan(a.top as number);
  });

  it("without onOpenBooking a bar is decorative — it never intercepts the day tap", async () => {
    const { onSelectDay } = await renderMonth([lodging("h1", "2027-03-03", "2027-03-05")]);
    const bar = screen.getByTestId("itinerary-month-span-book-h1-2027-03-03");
    expect(bar.props.pointerEvents).toBe("none");
    expect(bar.props.accessibilityRole).toBeUndefined();
    await fireEvent.press(bar);
    expect(onSelectDay).not.toHaveBeenCalled();
  });

  it("with onOpenBooking a bar routes to booking-detail by BOOKING id — and does not select a day", async () => {
    const onSelectDay = jest.fn();
    const onOpenBooking = jest.fn();
    await renderMonth([lodging("h1", "2027-03-03", "2027-03-05")], { onSelectDay, onOpenBooking });
    const bar = screen.getByTestId("itinerary-month-span-book-h1-2027-03-03");
    expect(bar.props.accessibilityRole).toBe("button");
    expect(bar.props.accessibilityLabel).toBe("Hotel h1, Mar 3 to Mar 5");
    await fireEvent.press(bar);
    expect(onOpenBooking).toHaveBeenCalledTimes(1);
    expect(onOpenBooking).toHaveBeenCalledWith("book-h1");
    expect(onSelectDay).not.toHaveBeenCalled();
  });
});

describe("MonthSurface — month stepper (spec gap: reach every touched month)", () => {
  const TWO_MONTHS = { start_date: "2027-03-29", end_date: "2027-04-03" } as const;

  it("a one-month trip shows no stepper", async () => {
    await renderMonth([]);
    expect(screen.queryByTestId("itinerary-month-prev")).toBeNull();
    expect(screen.queryByTestId("itinerary-month-next")).toBeNull();
  });

  it("BOUNDARY: a two-month trip lands on today's month and steps to the other and back", async () => {
    await renderMonth([custom("apr", "2027-04-02")], { trip: TWO_MONTHS, today: "2027-04-01" });
    expect(screen.getByTestId("itinerary-month-title")).toHaveTextContent("April 2027");
    // The April item is reachable as a dot; March's cells are not on screen as in-month days.
    expect(screen.getByTestId("itinerary-month-dot-2027-04-02-0")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("itinerary-month-prev"));
    expect(screen.getByTestId("itinerary-month-title")).toHaveTextContent("March 2027");
    await fireEvent.press(screen.getByTestId("itinerary-month-next"));
    expect(screen.getByTestId("itinerary-month-title")).toHaveTextContent("April 2027");
  });

  it("outside the trip, today falls back to the FIRST day's month (R-itin-17)", async () => {
    await renderMonth([], { trip: TWO_MONTHS, today: "2030-01-01" });
    expect(screen.getByTestId("itinerary-month-title")).toHaveTextContent("March 2027");
  });

  it("the stepper is disabled at each end of the touched months", async () => {
    await renderMonth([], { trip: TWO_MONTHS, today: "2027-03-30" });
    expect(screen.getByTestId("itinerary-month-prev").props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    expect(screen.getByTestId("itinerary-month-next").props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: false }),
    );
    await fireEvent.press(screen.getByTestId("itinerary-month-next"));
    expect(screen.getByTestId("itinerary-month-next").props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    expect(screen.getByTestId("itinerary-month-prev").props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: false }),
    );
  });

  it("REACH: every month the day set touches is reachable by stepping — a stray far-future item included", async () => {
    const { onSelectDay } = await renderMonth([custom("far", "2027-08-15")], {
      today: "2027-03-10",
    });
    const seen: string[] = [];
    seen.push(screen.getByTestId("itinerary-month-title").props.children as string);
    await fireEvent.press(screen.getByTestId("itinerary-month-next"));
    seen.push(screen.getByTestId("itinerary-month-title").props.children as string);
    // Sparse: March → August in ONE step (no empty April–July pages), and the item is there.
    expect(seen).toEqual(["March 2027", "August 2027"]);
    expect(screen.getByTestId("itinerary-month-dot-2027-08-15-0")).toBeOnTheScreen();
    await fireEvent.press(cell("2027-08-15"));
    expect(onSelectDay).toHaveBeenCalledWith("2027-08-15");
  });

  it("a day tapped on the second month reports ITS ISO day", async () => {
    const { onSelectDay } = await renderMonth([], { trip: TWO_MONTHS, today: "2027-04-01" });
    await fireEvent.press(cell("2027-04-03"));
    expect(onSelectDay).toHaveBeenCalledWith("2027-04-03");
  });
});

describe("MonthSurface — landing + clock", () => {
  it("with no `today` prop it uses the device's local today (R-itin-17)", async () => {
    const today = localTodayISO();
    const [y, m] = today.split("-");
    await renderMonth([], { today: undefined, trip: { start_date: today, end_date: today } });
    const names = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    expect(screen.getByTestId("itinerary-month-title")).toHaveTextContent(
      `${names[Number(m) - 1]} ${y}`,
    );
  });
});

describe("MonthSurface — viewers see the same (no edit affordances)", () => {
  it("renders an IDENTICAL tree for a viewer and an owner, with no add affordance for either", async () => {
    const parts = [custom("c1", "2027-03-02"), lodging("h1", "2027-03-03", "2027-03-06")];
    const viewerTrip: TripWithRole = makeTrip({ ...TRIP, role: "viewer" });
    const ownerTrip: TripWithRole = makeTrip({ ...TRIP, role: "owner" });
    await renderMonth(parts, { trip: viewerTrip });
    const viewerTree = JSON.stringify(screen.toJSON());
    expect(screen.queryAllByTestId(/add/i)).toHaveLength(0);
    await screen.unmount();
    await renderMonth(parts, { trip: ownerTrip });
    expect(screen.queryAllByTestId(/add/i)).toHaveLength(0);
    expect(JSON.stringify(screen.toJSON())).toBe(viewerTree);
  });
});
