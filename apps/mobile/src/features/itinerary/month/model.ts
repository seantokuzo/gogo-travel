/**
 * Month-overview projection (T-7.14 — itinerary spec R-itin-35, §2.5b,
 * R-itin-31/36, R-itin-45). Pure: `{trip dates, items, bookings}` → the month
 * grids `MonthSurface` renders (weeks × 7 day cells, no hour axis). REUSES
 * `projectItem` / `buildDaySet` from `../model` so the day list, the hour grid
 * and this surface can never disagree about what an item is or which days
 * exist; this module only adds the month geometry.
 *
 * Per day cell (R-itin-35):
 * - up to `MAX_DOTS` (3) compact item-count dots + a "+N" overflow marker —
 *   dots count the day's POINT items (everything that is not a spanning bar);
 * - multi-day bookings are NOT dots: they are thin connecting bars across the
 *   covered cells of a week row (the month analogue of the grid's all-day
 *   lane), clipped at the week edges with a continuation marker so a stay that
 *   crosses a week (or month) boundary reads as one run;
 * - the a11y item count is the WHOLE day: point items + every bar covering it
 *   (a VoiceOver user cannot see the bar, so "2 items" must include the hotel).
 *
 * SPANNING SET (R-itin-35 names "lodging spans, R-itin-31; overnight flights,
 * R-itin-36"): a spanning LODGING is detected the same way the grid does
 * (R-itin-52) — `projectItem`'s DEFAULT two-entry signature — and a spanning
 * FLIGHT by `end_day > day` on a flight booking. In Month a flight is a bar like
 * lodging; the list-mode Departs/Arrives split (`listMode`) is deliberately NOT
 * used here. Every other category with an `end_day` (train, activity, other)
 * keeps §2.6's one-row-plus-"+1" treatment: ONE point on `day`. Extending the
 * set is a one-line change to `spanOf`.
 *
 * DAY SET (R-itin-17/45): the grid's day set — the trip's date range UNIONED
 * with the render days of items outside it (sparse, never filler). A cell is
 * INTERACTIVE iff its date is in that set (it has a Day-density column to land
 * on); every cell outside the TRIP range is dimmed. A month is rendered for
 * every month the day set touches (sparse — a stray item five months out adds
 * one month, not five).
 *
 * Date handling is tz-free wall-value arithmetic (the `../model` precedent):
 * wire dates are ISO calendar dates, never instants. Month is NOT converted by
 * the timezone switcher (R-itin-38 is display-only on the hour grid) — stored
 * wall days render as-is.
 *
 * WEEK START: the app has no locale/week-start setting and its only weekday
 * table (`../model` `WEEKDAYS`) is Sunday-first, so Sunday is the default;
 * `weekStartsOn` is the one seam a future locale pick would feed (Hermes'
 * `Intl.Locale#getWeekInfo` is not relied on — mobile.md Intl landmines).
 */
import type { Booking, ISODate, ItineraryItem } from "@gogo/shared";

import type { IconName } from "@/components";

import { initialDayIndex } from "../grid/model";
import { addDays, buildDaySet, formatDayChip, formatDayHeader, projectItem } from "../model";

/** R-itin-35: "up to 3 compact item-count dots" — the rest fold into "+N". */
export const MAX_DOTS = 3;
export const DAYS_PER_WEEK = 7;

/** 0 = Sunday-first (default — matches the app's only weekday table), 1 = Monday-first. */
export type WeekStart = 0 | 1;
export const DEFAULT_WEEK_START: WeekStart = 0;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTH_NAMES = [
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
] as const;

// ---------------------------------------------------------------------------
// Date helpers (tz-free)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function utcMs(iso: ISODate): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function dayDiff(from: ISODate, to: ISODate): number {
  return Math.round((utcMs(to) - utcMs(from)) / MS_PER_DAY);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: ISODate): number {
  return new Date(utcMs(iso)).getUTCDay();
}

/** The first date of the week containing `iso`. */
export function weekStartOf(iso: ISODate, weekStartsOn: WeekStart): ISODate {
  return addDays(iso, -((weekdayOf(iso) - weekStartsOn + DAYS_PER_WEEK) % DAYS_PER_WEEK));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The 7 column headers for a week start — "Sun".."Sat" rotated. */
export function weekdayHeaders(weekStartsOn: WeekStart): string[] {
  return Array.from(
    { length: DAYS_PER_WEEK },
    (_, i) => WEEKDAY_SHORT[(weekStartsOn + i) % DAYS_PER_WEEK] ?? "",
  );
}

/** `YYYY-MM-DD` → its `YYYY-MM` month key. */
export function monthKeyOf(iso: ISODate): string {
  return iso.slice(0, 7);
}

/** The day-of-month number a cell prints. */
export function dayOfMonth(iso: ISODate): number {
  return Number(iso.slice(8, 10));
}

/**
 * R-itin-30 cell label — "<weekday> <date>, N items" (the day-list header
 * format, "Wed, Mar 4", so list and month announce a day identically).
 */
export function cellLabel(date: ISODate, itemCount: number): string {
  return `${formatDayHeader(date)}, ${itemCount} ${itemCount === 1 ? "item" : "items"}`;
}

// ---------------------------------------------------------------------------
// Model shapes
// ---------------------------------------------------------------------------

/** One week-row segment of a spanning booking. Columns are 0..6 in week order. */
export interface MonthSpanBar {
  /** Unique within the surface — the item + the segment's first date. */
  key: string;
  itemId: string;
  /** Booking-kind items route to booking-detail (§2.9); null on a non-booking item. */
  bookingId: string | null;
  title: string;
  icon: IconName;
  /** First / last covered date of THIS segment (already clipped to the week). */
  firstDate: ISODate;
  lastDate: ISODate;
  /** The booking's TRUE span (unclipped) — for the a11y label. */
  spanStart: ISODate;
  spanEnd: ISODate;
  startCol: number;
  endCol: number;
  /** Stacking row inside the week (spans overlapping in a week get distinct lanes). */
  lane: number;
  /** The booking began in an earlier week — this segment is clipped at the week's left edge. */
  continuesBefore: boolean;
  /** The booking runs into a later week — clipped at the week's right edge. */
  continuesAfter: boolean;
}

export interface MonthDayCell {
  date: ISODate;
  /** False on a lead/trail day that belongs to the adjacent month. */
  inMonth: boolean;
  /** Inside the trip's own date range — everything else renders dimmed (R-itin-35). */
  inTripRange: boolean;
  /** In the grid day set ⇒ has a Day column to land on. Others are inert. */
  interactive: boolean;
  /** Point items on the day — what the dots count. */
  pointCount: number;
  /** Point items + bars covering the day — what the a11y label announces. */
  itemCount: number;
  /** `min(pointCount, MAX_DOTS)` dots to draw. */
  dotCount: number;
  /** `pointCount − MAX_DOTS` when positive — the "+N" marker; 0 hides it. */
  overflowCount: number;
  label: string;
}

export interface MonthWeek {
  /** The week's first date — unique within a month grid. */
  key: ISODate;
  cells: MonthDayCell[];
  bars: MonthSpanBar[];
  /** Lane rows this week needs — every cell of the row reserves them (dots stay aligned). */
  laneCount: number;
}

export interface MonthGrid {
  /** `YYYY-MM`. */
  key: string;
  year: number;
  /** 1–12. */
  month: number;
  /** "March 2027". */
  title: string;
  weeks: MonthWeek[];
}

export interface MonthModel {
  /** The grid day set (R-itin-17/45) — the Day column dates. */
  days: ISODate[];
  /** One grid per month the day set touches, ascending. */
  months: MonthGrid[];
}

export interface BuildMonthModelOptions {
  weekStartsOn?: WeekStart;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface RawSpan {
  itemId: string;
  bookingId: string | null;
  title: string;
  icon: IconName;
  start: ISODate;
  end: ISODate;
}

interface BuildContext {
  trip: { start_date: ISODate; end_date: ISODate };
  daySet: ReadonlySet<ISODate>;
  pointsByDay: ReadonlyMap<ISODate, number>;
  spans: readonly RawSpan[];
  weekStartsOn: WeekStart;
}

/**
 * The covered range of a multi-day item, or null when it is a point.
 * - spanning LODGING: `projectItem`'s default two-entry signature (R-itin-52 —
 *   one source of truth with the day list and the grid), spanning its
 *   check-in → check-out render days;
 * - spanning FLIGHT: `end_day > day` on a flight booking (R-itin-36 / R-itin-35).
 * An `end_day` that does not follow `day` (wire-invalid, or equal) is a point.
 */
function spanOf(
  item: ItineraryItem,
  entries: ReturnType<typeof projectItem>,
  bookingsById: ReadonlyMap<string, Booking>,
): { start: ISODate; end: ISODate } | null {
  const [first, second] = entries;
  if (first !== undefined && second !== undefined) {
    return { start: first.renderDay, end: second.renderDay };
  }
  if (item.end_day === null || item.end_day <= item.day) return null;
  const category =
    item.booking_id !== null ? bookingsById.get(item.booking_id)?.category : undefined;
  return category === "flight" ? { start: item.day, end: item.end_day } : null;
}

function buildCell(date: ISODate, month: string, ctx: BuildContext): MonthDayCell {
  const pointCount = ctx.pointsByDay.get(date) ?? 0;
  let covering = 0;
  for (const span of ctx.spans) {
    if (span.start <= date && date <= span.end) covering += 1;
  }
  const itemCount = pointCount + covering;
  return {
    date,
    inMonth: monthKeyOf(date) === month,
    inTripRange: ctx.trip.start_date <= date && date <= ctx.trip.end_date,
    interactive: ctx.daySet.has(date),
    pointCount,
    itemCount,
    dotCount: Math.min(pointCount, MAX_DOTS),
    overflowCount: Math.max(0, pointCount - MAX_DOTS),
    label: cellLabel(date, itemCount),
  };
}

function buildBars(weekStart: ISODate, ctx: BuildContext): { bars: MonthSpanBar[]; lanes: number } {
  const weekEnd = addDays(weekStart, DAYS_PER_WEEK - 1);
  const segments: Omit<MonthSpanBar, "lane">[] = [];
  for (const span of ctx.spans) {
    if (span.end < weekStart || span.start > weekEnd) continue;
    // Clip at the week edges; the flags mark where the run continues.
    const firstDate = span.start < weekStart ? weekStart : span.start;
    const lastDate = span.end > weekEnd ? weekEnd : span.end;
    segments.push({
      key: `${span.itemId}-${firstDate}`,
      itemId: span.itemId,
      bookingId: span.bookingId,
      title: span.title,
      icon: span.icon,
      firstDate,
      lastDate,
      spanStart: span.start,
      spanEnd: span.end,
      startCol: dayDiff(weekStart, firstDate),
      endCol: dayDiff(weekStart, lastDate),
      continuesBefore: span.start < weekStart,
      continuesAfter: span.end > weekEnd,
    });
  }
  // Deterministic stacking: earliest column first, longer runs first, then id.
  segments.sort(
    (a, b) =>
      a.startCol - b.startCol ||
      b.endCol - b.startCol - (a.endCol - a.startCol) ||
      (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
  );
  const laneEnds: number[] = [];
  const bars = segments.map((segment) => {
    let lane = laneEnds.findIndex((end) => end < segment.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(segment.endCol);
    } else {
      laneEnds[lane] = segment.endCol;
    }
    return { ...segment, lane };
  });
  return { bars, lanes: laneEnds.length };
}

function buildWeek(weekStart: ISODate, month: string, ctx: BuildContext): MonthWeek {
  const cells = Array.from({ length: DAYS_PER_WEEK }, (_, i) =>
    buildCell(addDays(weekStart, i), month, ctx),
  );
  const { bars, lanes } = buildBars(weekStart, ctx);
  return { key: weekStart, cells, bars, laneCount: lanes };
}

function buildMonth(key: string, ctx: BuildContext): MonthGrid {
  const [yearText, monthText] = key.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const first: ISODate = `${key}-01`;
  const gridStart = weekStartOf(first, ctx.weekStartsOn);
  // Full weeks: from the week holding the 1st through the week holding the last.
  const weekCount = Math.ceil(
    (dayDiff(gridStart, first) + daysInMonth(year, month)) / DAYS_PER_WEEK,
  );
  return {
    key,
    year,
    month,
    title: `${MONTH_NAMES[month - 1] ?? ""} ${year}`,
    weeks: Array.from({ length: weekCount }, (_, w) =>
      buildWeek(addDays(gridStart, w * DAYS_PER_WEEK), key, ctx),
    ),
  };
}

export function buildMonthModel(
  trip: { start_date: ISODate; end_date: ISODate },
  items: readonly ItineraryItem[],
  bookingsById: ReadonlyMap<string, Booking>,
  options: BuildMonthModelOptions = {},
): MonthModel {
  const renderDays = new Set<ISODate>();
  const pointsByDay = new Map<ISODate, number>();
  const spans: RawSpan[] = [];

  for (const item of items) {
    const entries = projectItem(item, bookingsById);
    const first = entries[0];
    if (first === undefined) continue;
    const range = spanOf(item, entries, bookingsById);
    if (range !== null) {
      spans.push({
        itemId: first.itemId,
        bookingId: first.bookingId,
        title: first.title,
        icon: first.icon,
        start: range.start,
        end: range.end,
      });
      renderDays.add(range.start);
      renderDays.add(range.end);
      continue;
    }
    renderDays.add(first.renderDay);
    pointsByDay.set(first.renderDay, (pointsByDay.get(first.renderDay) ?? 0) + 1);
  }

  const days = buildDaySet(trip, renderDays);
  const ctx: BuildContext = {
    trip,
    daySet: new Set(days),
    pointsByDay,
    spans,
    weekStartsOn: options.weekStartsOn ?? DEFAULT_WEEK_START,
  };
  const monthKeys = [...new Set(days.map(monthKeyOf))];
  return { days, months: monthKeys.map((key) => buildMonth(key, ctx)) };
}

// ---------------------------------------------------------------------------
// Landing + month stepping
// ---------------------------------------------------------------------------

/**
 * R-itin-35 "the month containing the current landing day (R-itin-17's rule)":
 * today when it is a day-set date (the trip is active, or an item is dated
 * today), else the first day of the set. Null only for an empty set.
 */
export function landingMonthKey(days: readonly ISODate[], today: ISODate): string | null {
  const day = days[Math.min(initialDayIndex(days, today), days.length - 1)];
  return day === undefined ? null : monthKeyOf(day);
}

/** Step `delta` months through the touched-months list, clamped to its ends. */
export function stepMonthIndex(index: number, delta: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, index + delta));
}

/** "Mar 3 to Mar 10" — the bar's a11y date range (day-list chip format). */
export function spanRangeLabel(start: ISODate, end: ISODate): string {
  return `${formatDayChip(start)} to ${formatDayChip(end)}`;
}
