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
 * TRAVEL-TIME SEAM (T-7.5): chips render between consecutive located entry
 * rows — extend the row model (`model.ts` seam note) and add the row case to
 * `renderRow` below.
 */
import type { ISODate } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useCallback, useImperativeHandle, useRef, type Ref } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import ReorderableList, { useReorderableDrag } from "react-native-reorderable-list";

import { AppText, Badge, Card, Icon } from "@/components";
import { triggerHaptic } from "@/theme/haptics";

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
  onOpen(entry: DayEntry): void;
}

/** §2.2 item card — press → detail, long-press → drag lift (R-itin-2). */
function EntryCard({ entry, onOpen }: EntryCardProps) {
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
  ref?: Ref<ItineraryDayListHandle>;
}

export function ItineraryDayList({
  rows,
  dragEnabled,
  onReorder,
  onOpenEntry,
  onAddToDay,
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
            <Pressable
              onPress={() => scrollToDay(row.date)}
              testID={`itinerary-day-header-${row.date}`}
              accessibilityRole="header"
            >
              <View style={s.dayHeader}>
                <AppText role="subheading">{formatDayHeader(row.date)}</AppText>
                <AppText role="caption" color="secondary">
                  {row.count === 0 ? "" : row.count === 1 ? "1 item" : `${row.count} items`}
                </AppText>
              </View>
            </Pressable>
          );
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
          return <EntryCard entry={row.entry} onOpen={onOpenEntry} />;
      }
    },
    [onAddToDay, onOpenEntry, s, scrollToDay, theme],
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
