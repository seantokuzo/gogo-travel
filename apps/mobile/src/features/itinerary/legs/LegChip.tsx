/**
 * Travel-time chip (T-7.5 / IT-3 — itinerary spec §2.2, R-itin-4/5): the
 * row that sits between two located day entries showing the default mode's
 * icon + duration. Tap → the mode Sheet (R-itin-4).
 *
 * There is no loading and no error variant BY DESIGN (R-itin-6): a pair with
 * no computed legs emits no chip row at all, so this component only ever
 * renders real data. It is deliberately NOT a `Card` — §2.2 makes the chip
 * connective tissue between cards, not another item.
 *
 * testID §2.9: `itinerary-leg-{fromItemId}` (leg ids are rebuilt on every
 * recompute — the from-item id is the stable key).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText, Icon } from "@/components";

import {
  formatLegDuration,
  TRAVEL_MODE_ICONS,
  TRAVEL_MODE_LABELS,
  type DayLeg,
} from "./legs-model";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", paddingLeft: t.space[4] },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[1],
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      backgroundColor: t.color.bg.inset,
      paddingVertical: t.space[1],
      paddingHorizontal: t.space[3],
      marginBottom: t.space[2],
    },
  }),
);

export interface LegChipProps {
  leg: DayLeg;
  onPress(leg: DayLeg): void;
}

export function LegChip({ leg, onPress }: LegChipProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const option = leg.options.find((candidate) => candidate.mode === leg.defaultMode);
  // `defaultMode` always names one of `options` (both derive from the same
  // pair index) — the fallback keeps the row honest if that ever changes.
  const duration = option === undefined ? "" : formatLegDuration(option.durationSeconds);

  return (
    <View style={s.row}>
      <Pressable
        onPress={() => onPress(leg)}
        style={s.chip}
        hitSlop={theme.hitSlop.sm}
        accessibilityRole="button"
        accessibilityLabel={`${TRAVEL_MODE_LABELS[leg.defaultMode]} ${duration} from ${leg.fromTitle} to ${leg.toTitle}. Show travel options.`}
        testID={`itinerary-leg-${leg.fromItemId}`}
      >
        <Icon
          name={TRAVEL_MODE_ICONS[leg.defaultMode]}
          size={14}
          color={theme.color.text.secondary}
        />
        <AppText role="caption" color="secondary">
          {duration}
        </AppText>
      </Pressable>
    </View>
  );
}
