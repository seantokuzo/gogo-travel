/**
 * Month surface (T-7.14 — itinerary spec R-itin-35, §2.5b, R-itin-30): the
 * true month-overview grid behind Month density — weeks × 7 day cells, NO hour
 * axis. A SEPARATE component from the hour-timeline `GridSurface` (§2.5b:
 * Day / 3-day / Trip-span share that one; Month does not).
 *
 * WHAT IT RENDERS (geometry + projection live in `./model`):
 * - the month containing the landing day (R-itin-17's rule — today when it is a
 *   day-set date, else the trip's first day), with a title and 7 weekday
 *   headers;
 * - per cell: the date, up to 3 item-count dots + a "+N" overflow marker;
 * - multi-day bookings (lodging; overnight flights) as thin connecting bars
 *   across their covered cells of each week row, squared at a week edge where
 *   the run continues, rounded where it truly begins/ends;
 * - cells outside the trip range are DIMMED; only cells with a Day column to
 *   land on (the trip range plus sparse out-of-range item days) are pressable.
 *
 * ROUTING CONTRACT (T-7.16 owns the screen): a cell press reports its ISO day
 * through `onSelectDay` — and ONLY that. This surface NEVER persists or switches
 * density itself: the screen's one `changeDensity("day")` (set + `storeGridDensity`)
 * plus its R-itin-17 landing on that date is wired by T-7.16, exactly like
 * `DensitySegment` (which also only reports). `onOpenBooking` is OPTIONAL and
 * additive: when the screen passes it, a bar routes to `booking-detail` (§2.9
 * "derived, same booking-detail routing"); omitted, bars are decorative and let
 * the day-cell press through.
 *
 * MONTH STEPPER (spec gap, flagged in the PR): R-itin-35 renders "the month
 * containing the landing day" and says nothing about reaching any other, so a
 * trip spanning two months would hide one. A prev/next stepper appears ONLY
 * when the day set touches more than one month, and clamps to those months.
 *
 * NO EDIT AFFORDANCES, for any role: Month is a read/route surface (gap-tap
 * add lives in Day density), so viewers and editors render identically and
 * the surface takes no role.
 *
 * Timezone: stored wall days render as-is — Month is NOT converted by the
 * timezone switcher (R-itin-38, display-only on the hour grid).
 *
 * A month is ≤ 6 week rows × 7 cells — a bounded body, not the long list
 * mobile.md's `FlatList` rule is about — so one `ScrollView` (for large-text /
 * tall-lane overflow) maps its rows directly.
 */
import type { Booking, ISODate, ItineraryItem, TripWithRole } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { AppText, Icon } from "@/components";
import { localTodayISO } from "@/navigation/trip-defaults";

import {
  buildMonthModel,
  dayOfMonth,
  DAYS_PER_WEEK,
  landingMonthKey,
  spanRangeLabel,
  stepMonthIndex,
  weekdayHeaders,
  type MonthDayCell,
  type MonthSpanBar,
  type MonthWeek,
  type WeekStart,
} from "./model";

export interface MonthSurfaceProps {
  /**
   * The trip's date range — the same `trip` the hour `GridSurface` takes. The
   * grid day set (R-itin-17/45), the dimming and the landing month all derive
   * from it plus `items`.
   */
  trip: Pick<TripWithRole, "start_date" | "end_date">;
  /** Scheduled items from the R-ib-13 composite read (ideas never render here). */
  items: readonly ItineraryItem[];
  /** Booking enrichment by id — the same map the list and the hour grid use. */
  bookingsById: ReadonlyMap<string, Booking>;
  /**
   * R-itin-35: a day-cell press. The caller switches to Day density landing on
   * this date (T-7.16's `changeDensity("day")`); this surface does not.
   */
  onSelectDay(day: ISODate): void;
  /** Optional §2.9 bar routing — same target as the grid's lane segments. */
  onOpenBooking?: ((bookingId: string) => void) | undefined;
  /** Landing-rule clock — defaults to the device's local today (tests pin it). */
  today?: ISODate | undefined;
  /** Week-start convention — defaults to Sunday-first (see `./model`). */
  weekStartsOn?: WeekStart | undefined;
}

// ---------------------------------------------------------------------------
// Geometry (one home — bars are absolutely positioned against these)
// ---------------------------------------------------------------------------

const CELL_PADDING = 4;
const DAY_NUMBER_HEIGHT = 22;
const SPAN_LANE_HEIGHT = 16;
const SPAN_BAR_HEIGHT = 10;
const DOT_ROW_HEIGHT = 16;
const DOT_SIZE = 6;
/** R-ds-9: a day cell is a tap target — never shorter than the 44pt floor. */
const MIN_CELL_HEIGHT = 56;
/** Dimmed (outside the trip range) cells render at this opacity (R-itin-35). */
const DIMMED_OPACITY = 0.4;

function rowHeight(laneCount: number): number {
  return Math.max(
    MIN_CELL_HEIGHT,
    CELL_PADDING * 2 + DAY_NUMBER_HEIGHT + laneCount * SPAN_LANE_HEIGHT + DOT_ROW_HEIGHT,
  );
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    shell: { flex: 1, backgroundColor: t.color.bg.surface },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: t.space[2],
      minHeight: 44,
    },
    stepper: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    stepperSpacer: { width: 44, height: 44 },
    weekdayRow: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    weekdayCell: { flex: 1, alignItems: "center", paddingVertical: t.space[1] },
    body: { flex: 1 },
    weekRow: { position: "relative" },
    cellRow: { flexDirection: "row" },
    cell: {
      flex: 1,
      paddingHorizontal: 2,
      paddingVertical: CELL_PADDING,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.subtle,
    },
    dimmed: { opacity: DIMMED_OPACITY },
    dayNumber: { height: DAY_NUMBER_HEIGHT, paddingLeft: 2, justifyContent: "center" },
    dotRow: {
      height: DOT_ROW_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      paddingLeft: 2,
    },
    dot: {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: DOT_SIZE / 2,
      backgroundColor: t.color.accent.solid,
    },
    barLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    bar: {
      position: "absolute",
      height: SPAN_BAR_HEIGHT,
      backgroundColor: t.color.accent.solid,
    },
    barStart: {
      marginLeft: 3,
      borderTopLeftRadius: SPAN_BAR_HEIGHT / 2,
      borderBottomLeftRadius: SPAN_BAR_HEIGHT / 2,
    },
    barEnd: {
      marginRight: 3,
      borderTopRightRadius: SPAN_BAR_HEIGHT / 2,
      borderBottomRightRadius: SPAN_BAR_HEIGHT / 2,
    },
  }),
);

type Styles = ReturnType<typeof useStyles>;

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function DayCell({
  cell,
  laneCount,
  onSelectDay,
  s,
}: {
  cell: MonthDayCell;
  laneCount: number;
  onSelectDay(day: ISODate): void;
  s: Styles;
}) {
  const dots = Array.from({ length: cell.dotCount }, (_, i) => i);
  const style = [s.cell, cell.inTripRange ? null : s.dimmed];
  const content = (
    <>
      <View style={s.dayNumber}>
        <AppText role="caption" color={cell.inMonth ? "primary" : "muted"}>
          {String(dayOfMonth(cell.date))}
        </AppText>
      </View>
      <View style={{ height: laneCount * SPAN_LANE_HEIGHT }} />
      <View style={s.dotRow}>
        {dots.map((i) => (
          <View key={i} style={s.dot} testID={`itinerary-month-dot-${cell.date}-${i}`} />
        ))}
        {cell.overflowCount > 0 ? (
          <AppText
            role="label"
            color="secondary"
            numberOfLines={1}
            testID={`itinerary-month-overflow-${cell.date}`}
          >
            {`+${cell.overflowCount}`}
          </AppText>
        ) : null}
      </View>
    </>
  );

  // Inert (no Day column to land on): a plain View, NOT a disabled Pressable —
  // the absence of any press handler is the guard (a disabled Pressable would
  // read as guarded in RNTL whether or not the guard existed; mobile.md).
  if (!cell.interactive) {
    return (
      <View
        testID={`itinerary-month-day-${cell.date}`}
        accessible
        accessibilityLabel={cell.label}
        accessibilityState={{ disabled: true }}
        style={style}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      testID={`itinerary-month-day-${cell.date}`}
      accessibilityRole="button"
      accessibilityLabel={cell.label}
      onPress={() => onSelectDay(cell.date)}
      style={style}
    >
      {content}
    </Pressable>
  );
}

function SpanBarView({
  bar,
  onOpenBooking,
  s,
}: {
  bar: MonthSpanBar;
  onOpenBooking?: ((bookingId: string) => void) | undefined;
  s: Styles;
}) {
  // ONE element per week-row segment: percent left/width against the row, so it
  // covers exactly its columns. A continuing edge is squared (flush with the
  // week edge — the run goes on); a true start/end is rounded and inset.
  const style = [
    s.bar,
    {
      left: `${(bar.startCol / DAYS_PER_WEEK) * 100}%` as const,
      width: `${((bar.endCol - bar.startCol + 1) / DAYS_PER_WEEK) * 100}%` as const,
      top: CELL_PADDING + DAY_NUMBER_HEIGHT + bar.lane * SPAN_LANE_HEIGHT,
    },
    bar.continuesBefore ? null : s.barStart,
    bar.continuesAfter ? null : s.barEnd,
  ];
  const testID = `itinerary-month-span-${bar.bookingId ?? bar.itemId}-${bar.firstDate}`;
  const bookingId = bar.bookingId;

  if (onOpenBooking !== undefined && bookingId !== null) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${bar.title}, ${spanRangeLabel(bar.spanStart, bar.spanEnd)}`}
        // The bar is thin by design; the slop stays inside its own lane
        // (lane pitch − bar height = 6pt) so neighboring lanes never overlap.
        hitSlop={{ top: 3, bottom: 3 }}
        onPress={() => onOpenBooking(bookingId)}
        style={style}
      />
    );
  }
  // Decorative: never intercepts — a press lands on the day cell underneath.
  return <View testID={testID} pointerEvents="none" style={style} />;
}

function WeekRow({
  week,
  onSelectDay,
  onOpenBooking,
  s,
}: {
  week: MonthWeek;
  onSelectDay(day: ISODate): void;
  onOpenBooking?: ((bookingId: string) => void) | undefined;
  s: Styles;
}) {
  return (
    <View style={[s.weekRow, { height: rowHeight(week.laneCount) }]}>
      <View style={s.cellRow}>
        {week.cells.map((cell) => (
          <DayCell
            key={cell.date}
            cell={cell}
            laneCount={week.laneCount}
            onSelectDay={onSelectDay}
            s={s}
          />
        ))}
      </View>
      {week.bars.length > 0 ? (
        <View style={s.barLayer} pointerEvents="box-none">
          {week.bars.map((bar) => (
            <SpanBarView key={bar.key} bar={bar} onOpenBooking={onOpenBooking} s={s} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function MonthSurface({
  trip,
  items,
  bookingsById,
  onSelectDay,
  onOpenBooking,
  today,
  weekStartsOn = 0,
}: MonthSurfaceProps) {
  const s = useStyles();
  const model = useMemo(
    () => buildMonthModel(trip, items, bookingsById, { weekStartsOn }),
    [trip, items, bookingsById, weekStartsOn],
  );
  const todayISO = today ?? localTodayISO();
  const landingKey = useMemo(() => landingMonthKey(model.days, todayISO), [model.days, todayISO]);

  // The stepper's choice survives item refetches; a month that stops existing
  // falls back to the landing month rather than rendering nothing.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const wantedKey =
    pickedKey !== null && model.months.some((m) => m.key === pickedKey) ? pickedKey : landingKey;
  const index = Math.max(
    0,
    model.months.findIndex((m) => m.key === wantedKey),
  );
  const month = model.months[index];
  const headers = weekdayHeaders(weekStartsOn);
  const canStep = model.months.length > 1;

  const step = (delta: number) => {
    const next = model.months[stepMonthIndex(index, delta, model.months.length)];
    if (next !== undefined) setPickedKey(next.key);
  };

  return (
    <View style={s.shell} testID="itinerary-month-surface">
      {month !== undefined ? (
        <>
          <View style={s.titleRow}>
            {canStep ? (
              <Pressable
                testID="itinerary-month-prev"
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                disabled={index === 0}
                onPress={() => step(-1)}
                style={s.stepper}
              >
                <Icon name="chevron-back" size={20} />
              </Pressable>
            ) : (
              <View style={s.stepperSpacer} />
            )}
            <AppText role="subheading" accessibilityRole="header" testID="itinerary-month-title">
              {month.title}
            </AppText>
            {canStep ? (
              <Pressable
                testID="itinerary-month-next"
                accessibilityRole="button"
                accessibilityLabel="Next month"
                disabled={index === model.months.length - 1}
                onPress={() => step(1)}
                style={s.stepper}
              >
                <Icon name="chevron-forward" size={20} />
              </Pressable>
            ) : (
              <View style={s.stepperSpacer} />
            )}
          </View>
          <View
            style={s.weekdayRow}
            testID="itinerary-month-weekdays"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {headers.map((header) => (
              <View key={header} style={s.weekdayCell}>
                <AppText role="label" color="muted">
                  {header}
                </AppText>
              </View>
            ))}
          </View>
          <ScrollView key={month.key} style={s.body} testID="itinerary-month-scroll">
            {month.weeks.map((week) => (
              <WeekRow
                key={week.key}
                week={week}
                onSelectDay={onSelectDay}
                onOpenBooking={onOpenBooking}
                s={s}
              />
            ))}
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}
