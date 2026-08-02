/**
 * One day column of the calendar grid (T-7.7 / IT-6 — §2.5, R-itin-13..15).
 *
 * Layers, bottom to top (RN document-order stacking):
 * 1. 24 hour slots — the gap layer. Whitespace IS the feature (§2.5): an
 *    empty range renders empty, and tapping it fires the R-itin-14 add
 *    prefill (`onAddAt(day, HH:00|HH:30)` — floor-to-half-hour by tap
 *    position). Gap-tap is a WRITE affordance: viewers get inert grid
 *    lines, no Pressable, no testID (R-ib-24 posture).
 * 2. Timed blocks — absolutely positioned by start/end minutes, side-by-side
 *    split per the overlap layout (R-itin-15, never occluded), category icon
 *    + title + status-tinted left edge (§2.5), overlap Badge when sharing a
 *    time range, "+1" tail on midnight-clipped spans (§2.6).
 *
 * testIDs (§2.9): blocks `itinerary-grid-item-{itemId}`, slots
 * `itinerary-grid-slot-{date}-{HH}`.
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, Badge, Icon } from "@/components";

import { MIN_BLOCK_HEIGHT } from "./constants";
import { slotPrefillTime, type GridDay, type GridTimedBlock } from "./model";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const useStyles = createStyles((t) =>
  StyleSheet.create({
    column: {
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: t.color.border.subtle,
    },
    slot: {
      position: "absolute",
      left: 0,
      right: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.subtle,
    },
    block: {
      position: "absolute",
      borderRadius: t.radius.sm,
      backgroundColor: t.color.bg.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.subtle,
      borderLeftWidth: 3,
      overflow: "hidden",
      paddingHorizontal: t.space[2],
      paddingVertical: 2,
    },
    blockRow: { flexDirection: "row", alignItems: "center", gap: t.space[1] },
    blockTitle: { flexShrink: 1 },
    blockBadges: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[1],
      marginTop: 2,
    },
  }),
);

export interface GridDayColumnProps {
  day: GridDay;
  width: number;
  hourHeight: number;
  /** False for viewers — the gap layer renders inert (R-ib-24). */
  canAdd: boolean;
  onAddAt(day: string, time?: string): void;
  onOpenBooking(bookingId: string): void;
  onOpenItem(itemId: string): void;
}

export function GridDayColumn({
  day,
  width,
  hourHeight,
  canAdd,
  onAddAt,
  onOpenBooking,
  onOpenItem,
}: GridDayColumnProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const pxPerMinute = hourHeight / 60;

  const edgeColor = (block: GridTimedBlock): string => {
    if (block.status === "planned") return theme.color.accent.solid;
    if (block.status === "booked") return theme.color.status.success.fg;
    return theme.color.border.strong;
  };

  return (
    <View style={[s.column, { width, height: 24 * hourHeight }]}>
      {HOURS.map((hour) => {
        const slotStyle = [s.slot, { top: hour * hourHeight, height: hourHeight }];
        if (!canAdd) return <View key={hour} style={slotStyle} />;
        return (
          <Pressable
            key={hour}
            style={slotStyle}
            testID={`itinerary-grid-slot-${day.date}-${String(hour).padStart(2, "0")}`}
            accessibilityRole="button"
            accessibilityLabel={`Add on ${day.date} at ${String(hour).padStart(2, "0")}:00`}
            onPress={(event) => {
              // Defensive optional chain: RNTL fireEvent can invoke without
              // an event object; native always provides one.
              const locationY = event?.nativeEvent?.locationY ?? 0;
              const fraction = hourHeight > 0 ? locationY / hourHeight : 0;
              onAddAt(day.date, slotPrefillTime(hour, fraction));
            }}
          />
        );
      })}
      {day.blocks.map((block) => {
        const top = block.startMinutes * pxPerMinute;
        const height = Math.max(
          (block.endMinutes - block.startMinutes) * pxPerMinute,
          MIN_BLOCK_HEIGHT,
        );
        return (
          <Pressable
            key={block.itemId}
            testID={`itinerary-grid-item-${block.itemId}`}
            accessibilityRole="button"
            accessibilityLabel={block.title}
            onPress={() => {
              if (block.bookingId !== null) onOpenBooking(block.bookingId);
              else onOpenItem(block.itemId);
            }}
            style={[
              s.block,
              {
                top,
                height,
                left: `${(block.column / block.columns) * 100}%`,
                width: `${100 / block.columns}%`,
                borderLeftColor: edgeColor(block),
              },
            ]}
          >
            <View style={s.blockRow}>
              <Icon name={block.icon} size={12} color={theme.color.text.secondary} />
              <AppText role="caption" numberOfLines={1} style={s.blockTitle}>
                {block.title}
              </AppText>
            </View>
            {block.overlapping || block.plusOne ? (
              <View style={s.blockBadges}>
                {block.overlapping ? <Badge label="Overlap" tone="warning" size="sm" /> : null}
                {block.plusOne ? <Badge label="+1" tone="neutral" size="sm" /> : null}
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
