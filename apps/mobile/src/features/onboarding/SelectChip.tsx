/**
 * SelectChip (T-5.8) — a togglable pill for the onboarding single/multi-select
 * steps (home currency, travel styles). Tokens-only styling; `testID` required
 * so each option is E2E-addressable (R-ds-20 / nav §2.7 grammar).
 */
import { createStyles } from "@gogo/tokens/react";
import { Pressable, StyleSheet } from "react-native";

import { AppText } from "@/components";

export interface SelectChipProps {
  label: string;
  selected: boolean;
  onPress(): void;
  testID: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    chip: {
      minHeight: t.touchTarget,
      paddingHorizontal: t.space[4],
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      backgroundColor: t.color.bg.surface,
    },
    selected: {
      borderColor: t.color.primary.solid,
      backgroundColor: t.color.bg.inset,
    },
  }),
);

export function SelectChip({ label, selected, onPress, testID }: SelectChipProps) {
  const s = useStyles();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[s.chip, selected && s.selected]}
    >
      <AppText role="bodyStrong" color={selected ? "accent" : "primary"}>
        {label}
      </AppText>
    </Pressable>
  );
}
