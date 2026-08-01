/**
 * Day-jump strip (T-7.4 / IT-1 — §2.2): horizontal date chips under the
 * PageHeader; tapping one scrolls the list to that day. Rendered for every
 * trip length (the spec's "for long trips" is read as motivation, not a
 * threshold — batched spec note); chips virtualize (mobile rule: long lists
 * never `ScrollView + .map()`).
 */
import type { ISODate } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/components";

import { formatDayChip } from "./model";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    strip: { flexGrow: 0 },
    content: { paddingHorizontal: t.space[4], gap: t.space[2], paddingBottom: t.space[2] },
    chip: {
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      backgroundColor: t.color.bg.surface,
      paddingVertical: t.space[1],
      paddingHorizontal: t.space[3],
    },
  }),
);

export interface DayJumpStripProps {
  days: ISODate[];
  onJump(date: ISODate): void;
}

export function DayJumpStrip({ days, onJump }: DayJumpStripProps) {
  const s = useStyles();
  return (
    <FlatList
      style={s.strip}
      contentContainerStyle={s.content}
      horizontal
      showsHorizontalScrollIndicator={false}
      data={days}
      keyExtractor={(date) => date}
      renderItem={({ item: date }) => (
        <Pressable
          onPress={() => onJump(date)}
          testID={`itinerary-day-jump-${date}`}
          accessibilityRole="button"
          accessibilityLabel={`Jump to ${formatDayChip(date)}`}
        >
          <View style={s.chip}>
            <AppText role="caption">{formatDayChip(date)}</AppText>
          </View>
        </Pressable>
      )}
    />
  );
}
