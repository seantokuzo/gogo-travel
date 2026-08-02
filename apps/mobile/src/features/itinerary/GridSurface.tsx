/**
 * Calendar-grid surface (T-7.7 / IT-6, §2.5–§2.6, R-itin-13..17 +
 * R-itin-31 grid half) — fills the W4 FROZEN SEAM. The exported props and
 * the root `itinerary-grid-surface` testID are the frozen contract with the
 * screen (T-7.6 owns `app/[tripId]/itinerary/index.tsx`); everything below
 * the root View is T-7.7 internals under `./grid/`.
 *
 * Composition (Google-Calendar-style split panes):
 * - PINNED header strip (§2.5 "all-day lane on top", R-itin-16): day label +
 *   spanning-lodging lane segments + all-day chips per column. Rendered by a
 *   second, non-scrollable horizontal FlatList kept in lockstep with the
 *   pager via `scrollToOffset` (no state on scroll — no re-render storm).
 * - Body: ONE shared vertical scroller (the §2.5 shared hour axis) holding
 *   the hour gutter beside a horizontally-paged, VIRTUALIZED FlatList of day
 *   columns (one full day per page + neighbor peek — `snapToInterval`).
 *
 * R-itin-17: hour height derives from the measured viewport so the
 * 08:00–20:00 band exactly fills it (clamped); the initial vertical offset
 * lands on 08:00, and `initialScrollIndex` lands on today's column when
 * today is a column, else the first day.
 *
 * Viewer gating (R-ib-24): gap-tap is a write affordance — viewers get an
 * inert gap layer (no Pressables, no slot testIDs). Blocks/chips/lanes stay
 * pressable for every role (they route to detail — reads).
 */
import type { Booking, ItineraryItem, TripWithRole } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import { localTodayISO } from "@/navigation/trip-defaults";

import {
  COLUMN_FRACTION,
  DEFAULT_HOUR_HEIGHT,
  FIRST_VISIBLE_HOUR,
  GUTTER_WIDTH,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
  VISIBLE_HOURS,
} from "./grid/constants";
import { GridDayColumn } from "./grid/GridDayColumn";
import { GridHeaderCell, headerStripHeight } from "./grid/GridHeaderCell";
import { HourGutter } from "./grid/HourGutter";
import { buildGridDays, initialDayIndex, type GridDay } from "./grid/model";

export interface GridSurfaceProps {
  trip: TripWithRole;
  /** Scheduled items from the R-ib-13 composite read (ideas never render here). */
  items: ItineraryItem[];
  /** Booking enrichment by id — the same map the day list's rows are built from. */
  bookingsById: Map<string, Booking>;
  /** §2.5 gap-tap prefill: day (YYYY-MM-DD) + rounded HH:mm when an hour slot is tapped. */
  onAddAt: (day: string, time?: string) => void;
  /** R-itin-27 routing — same targets as the day list rows. */
  onOpenBooking: (bookingId: string) => void;
  onOpenItem: (itemId: string) => void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    shell: { flex: 1 },
    headerRow: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
      backgroundColor: t.color.bg.surface,
    },
    gutterSpacer: { width: GUTTER_WIDTH },
    body: { flex: 1 },
    bodyRow: { flexDirection: "row" },
  }),
);

function clampHourHeight(viewportHeight: number): number {
  if (viewportHeight <= 0) return DEFAULT_HOUR_HEIGHT;
  const fit = viewportHeight / VISIBLE_HOURS;
  return Math.min(MAX_HOUR_HEIGHT, Math.max(MIN_HOUR_HEIGHT, fit));
}

export function GridSurface({
  trip,
  items,
  bookingsById,
  onAddAt,
  onOpenBooking,
  onOpenItem,
}: GridSurfaceProps) {
  const s = useStyles();
  const { width: windowWidth } = useWindowDimensions();

  const model = useMemo(() => buildGridDays(trip, items, bookingsById), [
    trip,
    items,
    bookingsById,
  ]);
  const { days, laneCount, maxAllDayCount } = model;
  const showChipRow = maxAllDayCount > 0;
  const canAdd = trip.role !== "viewer";

  const columnWidth = Math.max(1, Math.round((windowWidth - GUTTER_WIDTH) * COLUMN_FRACTION));
  const initialIndex = useMemo(() => {
    if (days.length === 0) return 0;
    return Math.min(
      initialDayIndex(days.map((day) => day.date), localTodayISO()),
      days.length - 1,
    );
  }, [days]);

  const [viewportHeight, setViewportHeight] = useState(0);
  const hourHeight = clampHourHeight(viewportHeight);

  const headerRef = useRef<FlatList<GridDay>>(null);
  const verticalRef = useRef<ScrollView>(null);
  const landedRef = useRef(false);

  // R-itin-17: scroll the shared axis to 08:00 once the viewport (and thus
  // the real hour height) is known.
  useEffect(() => {
    if (viewportHeight <= 0 || landedRef.current) return;
    landedRef.current = true;
    verticalRef.current?.scrollTo({ y: FIRST_VISIBLE_HOUR * hourHeight, animated: false });
  }, [viewportHeight, hourHeight]);

  const getItemLayout = (_data: unknown, index: number) => ({
    length: columnWidth,
    offset: columnWidth * index,
    index,
  });

  const syncHeader = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    headerRef.current?.scrollToOffset({
      offset: event.nativeEvent.contentOffset.x,
      animated: false,
    });
  };

  return (
    <View style={s.shell} testID="itinerary-grid-surface">
      <View style={[s.headerRow, { height: headerStripHeight(laneCount, showChipRow) }]}>
        <View style={s.gutterSpacer} />
        <FlatList
          ref={headerRef}
          testID="itinerary-grid-allday-lane"
          data={days}
          horizontal
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(day) => day.date}
          getItemLayout={getItemLayout}
          initialScrollIndex={initialIndex}
          renderItem={({ item: day }) => (
            <GridHeaderCell
              day={day}
              width={columnWidth}
              laneCount={laneCount}
              showChipRow={showChipRow}
              onOpenBooking={onOpenBooking}
              onOpenItem={onOpenItem}
            />
          )}
        />
      </View>
      <ScrollView
        ref={verticalRef}
        style={s.body}
        onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        showsVerticalScrollIndicator={false}
        testID="itinerary-grid-scroll"
      >
        <View style={s.bodyRow}>
          <HourGutter hourHeight={hourHeight} />
          <FlatList
            testID="itinerary-grid-pager"
            data={days}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(day) => day.date}
            getItemLayout={getItemLayout}
            initialScrollIndex={initialIndex}
            snapToInterval={columnWidth}
            decelerationRate="fast"
            disableIntervalMomentum
            nestedScrollEnabled
            // Round-1 perf: a day column is heavy (24 slot Pressables +
            // blocks) — shrink first-paint and retention windows; snap
            // paging is unaffected.
            windowSize={5}
            initialNumToRender={3}
            maxToRenderPerBatch={3}
            onScroll={syncHeader}
            scrollEventThrottle={16}
            renderItem={({ item: day }) => (
              <GridDayColumn
                day={day}
                width={columnWidth}
                hourHeight={hourHeight}
                canAdd={canAdd}
                onAddAt={onAddAt}
                onOpenBooking={onOpenBooking}
                onOpenItem={onOpenItem}
              />
            )}
          />
        </View>
      </ScrollView>
    </View>
  );
}
