/**
 * Pinned header cell for one day column (T-7.7 / IT-6 — §2.5 "all-day lane
 * on top", R-itin-16, R-itin-31 grid half).
 *
 * Contents, top to bottom:
 * 1. Day label (jump-strip date format — the hour grid below carries the
 *    detail; the label is orientation, not a control).
 * 2. Span lanes (R-itin-31): a spanning lodging renders one lane SEGMENT per
 *    covered column. Segments of the same lane abut edge-to-edge across
 *    columns — rounded + labeled at the check-in/check-out edges, squared
 *    and unlabeled between (§2.6 "labeled at the edges") — so the paged
 *    columns read as one continuous lane. Every cell reserves the GLOBAL
 *    lane count so strip height never varies per column.
 * 3. All-day chip row (R-itin-16): compact chips for untimed items.
 *
 * testIDs (§2.9): chips `itinerary-grid-allday-{itemId}`; span segments
 * `itinerary-grid-span-{itemId}-{date}` (new id class — one item spans many
 * columns, so the date qualifier keeps ids unique; flagged for §2.9 sync,
 * the T-7.4 `-check-in`/`-check-out` precedent).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, Badge, Icon } from "@/components";

import { formatDayChip } from "../model";
import {
  ALL_DAY_ROW_HEIGHT,
  HEADER_LABEL_HEIGHT,
  SPAN_LANE_HEIGHT,
} from "./constants";
import type { GridDay } from "./model";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    cell: {
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: t.color.border.subtle,
    },
    label: {
      height: HEADER_LABEL_HEIGHT,
      justifyContent: "center",
      paddingHorizontal: t.space[2],
    },
    lanes: { position: "relative" },
    lane: {
      position: "absolute",
      left: 0,
      right: 0,
      height: SPAN_LANE_HEIGHT - 4,
      justifyContent: "center",
      paddingHorizontal: t.space[2],
      backgroundColor: t.color.accent.subtleBg,
      borderColor: t.color.accent.subtleBorder,
      borderTopWidth: 1,
      borderBottomWidth: 1,
    },
    laneStart: {
      marginLeft: 2,
      borderLeftWidth: 1,
      borderTopLeftRadius: t.radius.sm,
      borderBottomLeftRadius: t.radius.sm,
    },
    laneEnd: {
      marginRight: 2,
      borderRightWidth: 1,
      borderTopRightRadius: t.radius.sm,
      borderBottomRightRadius: t.radius.sm,
    },
    laneRow: { flexDirection: "row", alignItems: "center", gap: t.space[1] },
    laneTitle: { flexShrink: 1 },
    chipRow: {
      height: ALL_DAY_ROW_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[1],
      paddingHorizontal: t.space[1],
    },
    chip: {
      flexShrink: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[1],
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      backgroundColor: t.color.bg.inset,
      paddingVertical: 2,
      paddingHorizontal: t.space[2],
    },
    chipTitle: { flexShrink: 1 },
  }),
);

export interface GridHeaderCellProps {
  day: GridDay;
  width: number;
  /** Global lane row count — every cell reserves the same strip height. */
  laneCount: number;
  /** True when ANY day has all-day chips (uniform strip height). */
  showChipRow: boolean;
  onOpenBooking(bookingId: string): void;
  onOpenItem(itemId: string): void;
}

/** Total header-strip height for a given model — GridSurface sizes the row. */
export function headerStripHeight(laneCount: number, showChipRow: boolean): number {
  return (
    HEADER_LABEL_HEIGHT + laneCount * SPAN_LANE_HEIGHT + (showChipRow ? ALL_DAY_ROW_HEIGHT : 0)
  );
}

export function GridHeaderCell({
  day,
  width,
  laneCount,
  showChipRow,
  onOpenBooking,
  onOpenItem,
}: GridHeaderCellProps) {
  const { theme } = useTheme();
  const s = useStyles();

  const open = (entry: { bookingId: string | null; itemId: string }) => {
    if (entry.bookingId !== null) onOpenBooking(entry.bookingId);
    else onOpenItem(entry.itemId);
  };

  return (
    <View style={[s.cell, { width, height: headerStripHeight(laneCount, showChipRow) }]}>
      <View style={s.label}>
        <AppText role="caption" color="secondary" testID={`itinerary-grid-day-${day.date}`}>
          {formatDayChip(day.date)}
        </AppText>
      </View>
      {laneCount > 0 ? (
        <View style={[s.lanes, { height: laneCount * SPAN_LANE_HEIGHT }]}>
          {day.spans.map((segment) => (
            <Pressable
              key={`${segment.itemId}-${segment.lane}`}
              testID={`itinerary-grid-span-${segment.itemId}-${day.date}`}
              accessibilityRole="button"
              accessibilityLabel={segment.title}
              onPress={() => open(segment)}
              style={[
                s.lane,
                { top: segment.lane * SPAN_LANE_HEIGHT + 2 },
                segment.isStart ? s.laneStart : null,
                segment.isEnd ? s.laneEnd : null,
              ]}
            >
              {segment.isStart || segment.isEnd ? (
                <View style={s.laneRow}>
                  <Icon name={segment.icon} size={12} color={theme.color.text.accent} />
                  <AppText role="caption" color="accent" numberOfLines={1} style={s.laneTitle}>
                    {segment.title}
                  </AppText>
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      {showChipRow ? (
        <View style={s.chipRow}>
          {day.allDay.map((chip) => (
            <Pressable
              key={chip.itemId}
              testID={`itinerary-grid-allday-${chip.itemId}`}
              accessibilityRole="button"
              accessibilityLabel={chip.title}
              onPress={() => open(chip)}
              style={s.chip}
            >
              <Icon name={chip.icon} size={12} color={theme.color.text.secondary} />
              <AppText role="caption" numberOfLines={1} style={s.chipTitle}>
                {chip.title}
              </AppText>
              {chip.plusOne ? <Badge label="+1" tone="neutral" size="sm" /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
