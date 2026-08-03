/**
 * Plan-mode day list (T-7.4 / IT-1+IT-2 — itinerary spec §2.2). ONE
 * virtualized reorderable list over the flat `DayListRow` model: day headers
 * and empty-day add rows are plain rows, item cards attach the long-press
 * drag handle (`useReorderableDrag`), and a released drag surfaces as the
 * library's `onReorder({from, to})` which the screen resolves via
 * `resolveDrop`. Cross-day drag is therefore just an index move past a
 * header row.
 *
 * DnD: react-native-reorderable-list (JS-only over the installed
 * reanimated/gesture-handler — no native module, PR body has provenance).
 * The list is data-driven: refusing or rolling back a drop = not changing /
 * restoring the data, exactly the optimistic pattern `useDayOrder` runs.
 *
 * testIDs (§2.9): item cards `itinerary-list-item-{itemId}` — synthesized
 * check-in/check-out rows qualify with `-check-in`/`-check-out` (two rows,
 * one itemId; grammar-conforming qualifier, flagged for §2.9 sync). Day add
 * rows `itinerary-day-add-{date}`; day headers `itinerary-day-header-{date}`
 * (new id, same flag).
 *
 * TRAVEL-TIME SEAM (T-7.5 — FILLED): `leg` rows render `LegChip` between the
 * entry rows the model paired; `overlapping` entry rows carry the R-itin-7
 * warning Badge and an `unsorted` day header exposes the "Sort day by time"
 * affordance. Absent legs produce no row at all (R-itin-6).
 */
import type { ISODate } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useCallback, useImperativeHandle, useRef, type Ref } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import ReorderableList, { useReorderableDrag } from "react-native-reorderable-list";

import { AppText, Badge, Card, Icon } from "@/components";
import { triggerHaptic } from "@/theme/haptics";

import { LegChip } from "./legs/LegChip";
import type { DayLeg } from "./legs/legs-model";
import { formatDayHeader, statusBadgeTone, type DayEntry, type DayListRow } from "./model";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    list: { flex: 1 },
    listContent: { paddingHorizontal: t.space[4], paddingBottom: 96 },
    dayHeader: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      paddingTop: t.space[5],
      paddingBottom: t.space[2],
    },
    dayHeaderTrailing: { flexDirection: "row", alignItems: "center", gap: t.space[3] },
    sortAction: { flexDirection: "row", alignItems: "center", gap: t.space[1] },
    emptyDay: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[2],
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: t.color.border.subtle,
      paddingVertical: t.space[2],
      paddingHorizontal: t.space[3],
    },
    card: { marginBottom: t.space[2] },
    cardRow: { flexDirection: "row", alignItems: "center", gap: t.space[3] },
    cardBody: { flex: 1, gap: 2 },
    badges: { flexDirection: "row", alignItems: "center", gap: t.space[1] },
  }),
);

export interface ItineraryDayListHandle {
  /** Jump-strip / day-header scroll (R-itin-1 day jump). */
  scrollToDay(date: ISODate): void;
}

interface EntryCardProps {
  entry: DayEntry;
  /** R-itin-7: this item's timed span directly overlaps another's. */
  overlapping: boolean;
  onOpen(entry: DayEntry): void;
}

/** §2.2 item card — press → detail, long-press → drag lift (R-itin-2). */
function EntryCard({ entry, overlapping, onOpen }: EntryCardProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const drag = useReorderableDrag();
  const testID =
    entry.checkpoint === null
      ? `itinerary-list-item-${entry.itemId}`
      : `itinerary-list-item-${entry.itemId}-${entry.checkpoint}`;
  return (
    <Card
      onPress={() => onOpen(entry)}
      onLongPress={() => {
        // Check-out rows are render-only (model doc) — no lift, no haptic.
        if (!entry.draggable) return;
        triggerHaptic("dragLift");
        drag();
      }}
      testID={testID}
      accessibilityLabel={entry.title}
      style={s.card}
    >
      <View style={s.cardRow}>
        <Icon name={entry.icon} size={22} color={theme.color.text.secondary} />
        <View style={s.cardBody}>
          <AppText role="body" numberOfLines={1}>
            {entry.title}
          </AppText>
          <AppText role="caption" color="secondary">
            {entry.timeLabel}
          </AppText>
        </View>
        <View style={s.badges}>
          {/* R-itin-7 warning chip — the SAME overlap the grid splits
              side-by-side and badges (R-itin-15), one rule seen twice. */}
          {overlapping ? (
            <Badge
              label="Overlap"
              tone="warning"
              size="sm"
              testID={`itinerary-list-item-${entry.itemId}-overlap`}
            />
          ) : null}
          {entry.checkpoint !== null ? (
            <Badge
              label={entry.checkpoint === "check-in" ? "Check-in" : "Check-out"}
              tone="neutral"
              size="sm"
            />
          ) : null}
          {entry.plusOne ? <Badge label="+1" tone="neutral" size="sm" /> : null}
          {entry.status === "planned" || entry.status === "booked" ? (
            <Badge
              label={entry.status === "planned" ? "Planned" : "Booked"}
              tone={statusBadgeTone(entry.status)}
              size="sm"
            />
          ) : null}
        </View>
      </View>
    </Card>
  );
}

export interface ItineraryDayListProps {
  rows: DayListRow[];
  /** False while a reorder PUT is in flight (pending gate) or for viewers. */
  dragEnabled: boolean;
  onReorder(event: { from: number; to: number }): void;
  onOpenEntry(entry: DayEntry): void;
  /** Empty-day "Add to this day" row (R-itin-1). */
  onAddToDay(date: ISODate): void;
  /** R-itin-4: chip tap → the mode Sheet (owned by the screen). */
  onOpenLeg(leg: DayLeg): void;
  /**
   * R-itin-7 "Sort day by time". Undefined ⇒ the affordance never renders —
   * it issues a day-order PUT, so viewers (R-ib-24) and a pending reorder
   * must not see it.
   */
  onSortDay?: ((date: ISODate) => void) | undefined;
  ref?: Ref<ItineraryDayListHandle>;
}

export function ItineraryDayList({
  rows,
  dragEnabled,
  onReorder,
  onOpenEntry,
  onAddToDay,
  onOpenLeg,
  onSortDay,
  ref,
}: ItineraryDayListProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const listRef = useRef<FlatList<DayListRow>>(null);

  const scrollToDay = useCallback(
    (date: ISODate) => {
      const index = rows.findIndex((row) => row.type === "day" && row.date === date);
      if (index < 0) return;
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
    },
    [rows],
  );
  useImperativeHandle(ref, () => ({ scrollToDay }), [scrollToDay]);

  const renderRow = useCallback(
    ({ item: row }: { item: DayListRow }) => {
      switch (row.type) {
        case "day":
          return (
            <View style={s.dayHeader}>
              <Pressable
                onPress={() => scrollToDay(row.date)}
                testID={`itinerary-day-header-${row.date}`}
                accessibilityRole="header"
              >
                <AppText role="subheading">{formatDayHeader(row.date)}</AppText>
              </Pressable>
              <View style={s.dayHeaderTrailing}>
                {/* R-itin-7: offered only when the day's row order disagrees
                    with its start times — never an auto-resort. */}
                {row.unsorted && onSortDay !== undefined ? (
                  <Pressable
                    onPress={() => onSortDay(row.date)}
                    style={s.sortAction}
                    hitSlop={theme.hitSlop.sm}
                    accessibilityRole="button"
                    accessibilityLabel={`Sort ${formatDayHeader(row.date)} by time`}
                    testID={`itinerary-sort-by-time-${row.date}`}
                  >
                    <Icon name="swap-vertical" size={14} color={theme.color.text.accent} />
                    <AppText role="caption" color="accent">
                      Sort by time
                    </AppText>
                  </Pressable>
                ) : null}
                <AppText role="caption" color="secondary">
                  {row.count === 0 ? "" : row.count === 1 ? "1 item" : `${row.count} items`}
                </AppText>
              </View>
            </View>
          );
        case "leg":
          return <LegChip leg={row.leg} onPress={onOpenLeg} />;
        case "empty-day":
          return (
            <Pressable
              onPress={() => onAddToDay(row.date)}
              testID={`itinerary-day-add-${row.date}`}
              accessibilityRole="button"
              accessibilityLabel={`Add to ${formatDayHeader(row.date)}`}
            >
              <View style={s.emptyDay}>
                <Icon name="add" size={16} color={theme.color.text.secondary} />
                <AppText role="caption" color="secondary">
                  Add to this day
                </AppText>
              </View>
            </Pressable>
          );
        case "entry":
          return (
            <EntryCard entry={row.entry} overlapping={row.overlapping} onOpen={onOpenEntry} />
          );
      }
    },
    [onAddToDay, onOpenEntry, onOpenLeg, onSortDay, s, scrollToDay, theme],
  );

  return (
    <ReorderableList
      ref={listRef}
      testID="itinerary-day-list"
      style={s.list}
      contentContainerStyle={s.listContent}
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={renderRow}
      onReorder={onReorder}
      dragEnabled={dragEnabled}
      // scrollToIndex without getItemLayout can miss unrendered targets —
      // land near the offset, then retry once the region is mounted.
      onScrollToIndexFailed={(info) => {
        listRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: true,
        });
        setTimeout(() => {
          listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0 });
        }, 120);
      }}
    />
  );
}
