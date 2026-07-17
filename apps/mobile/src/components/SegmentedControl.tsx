/**
 * SegmentedControl (DS-9, spec §2.9) — budget · expenses · balances style
 * segments. Equal-width on a `bg.inset` track, active segment `bg.surface` +
 * `text.primary`, track ≥44 pt (R-ds-9). `selection` haptic fires only on an
 * ACTUAL change (§2.8: max one per user action; re-tapping the active
 * segment is a no-op). Per-segment testIDs derive `{testID}-{key}` (nav
 * grammar's `segment` noun).
 */
import { createStyles } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { triggerHaptic } from "@/theme/haptics";

import { AppText } from "./Text";

export interface SegmentedControlProps {
  segments: { key: string; label: string }[];
  selectedKey: string;
  onChange(key: string): void;
  /** Required (R-ds-20); per-segment children derive `{testID}-{key}`. */
  testID: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    track: {
      flexDirection: "row",
      backgroundColor: t.color.bg.inset,
      borderRadius: t.radius.md,
      padding: t.space[1],
      minHeight: t.touchTarget,
    },
    segment: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radius.sm,
      minHeight: 36,
      paddingHorizontal: t.space[2],
    },
    segmentActive: {
      backgroundColor: t.color.bg.surface,
      ...t.elevation[1],
    },
  }),
);

export function SegmentedControl({
  segments,
  selectedKey,
  onChange,
  testID,
}: SegmentedControlProps) {
  const s = useStyles();

  return (
    <View style={s.track} testID={testID} accessibilityRole="tablist">
      {segments.map(({ key, label }) => {
        const selected = key === selectedKey;
        return (
          <Pressable
            key={key}
            testID={`${testID}-${key}`}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            style={[s.segment, selected && s.segmentActive]}
            onPress={() => {
              if (selected) return; // no-op: no haptic, no onChange
              triggerHaptic("selection");
              onChange(key);
            }}
          >
            <AppText
              role={selected ? "bodyStrong" : "body"}
              color={selected ? "primary" : "secondary"}
              numberOfLines={1}
            >
              {label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
