/**
 * Enum-field selector (T-7.6 / IT-7) — a wrap-row of selectable chips for
 * the small closed sets the detail shapes carry (lodging/activity
 * `provider`). Tapping the selected chip clears it (every detail field is
 * optional by design). Per-chip ids derive `{testID}-{value}` (the
 * SegmentedControl convention).
 */
import { createStyles } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/components";

export interface OptionChipsProps {
  label: string;
  options: readonly string[];
  /** `""` = none selected. */
  value: string;
  onChange(value: string): void;
  /** Required (R-ds-20). */
  testID: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: { gap: t.space[1] },
    row: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
    chip: {
      // Full touch target (R-ds-9) — a 32pt chip is below the platform
      // minimum every neighboring field honors.
      minHeight: t.touchTarget,
      justifyContent: "center",
      paddingHorizontal: t.space[3],
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      backgroundColor: t.color.bg.inset,
    },
    chipSelected: {
      borderColor: t.color.border.focus,
      backgroundColor: t.color.bg.surfaceRaised,
    },
  }),
);

export function OptionChips({ label, options, value, onChange, testID }: OptionChipsProps) {
  const s = useStyles();
  return (
    <View style={s.container}>
      <AppText role="caption" color="secondary">
        {label}
      </AppText>
      <View style={s.row}>
        {options.map((option) => {
          const selected = option === value;
          return (
            <Pressable
              key={option}
              onPress={() => onChange(selected ? "" : option)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${label}: ${option}`}
              style={[s.chip, selected && s.chipSelected]}
              testID={`${testID}-${option}`}
            >
              <AppText role="caption" color={selected ? "primary" : "secondary"}>
                {option}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
