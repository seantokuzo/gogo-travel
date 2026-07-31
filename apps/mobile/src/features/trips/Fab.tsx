/**
 * Floating action button (T-6.7 / CT-1; §2.1 "FAB → create modal"). The DS
 * ships no FAB primitive, so this feature component composes the raw
 * Pressable under the DS rules: tokens-only styling, required testID
 * (R-ds-20), ≥44pt target (R-ds-9), pressed feedback same-frame (R-ds-13).
 * Positioning (absolute, bottom-trailing) lives here so screens just render
 * it last inside their root view.
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/components";
import type { IconName } from "@/components";

export interface FabProps {
  icon: IconName;
  /** Accessibility label for the icon-only button (R-ds-12). */
  label: string;
  onPress(): void;
  /** Required (R-ds-20). */
  testID: string;
}

const FAB_SIZE = 56;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    fab: {
      position: "absolute",
      right: t.space[4],
      width: FAB_SIZE,
      height: FAB_SIZE,
      borderRadius: t.radius.full,
      backgroundColor: t.color.primary.solid,
      alignItems: "center",
      justifyContent: "center",
      ...t.elevation[4],
    },
    pressed: { backgroundColor: t.color.primary.solidPressed },
  }),
);

export function Fab({ icon, label, onPress, testID }: FabProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const s = useStyles();
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        s.fab,
        { bottom: insets.bottom + theme.space[4] },
        pressed && s.pressed,
      ]}
    >
      <View pointerEvents="none">
        <Icon name={icon} size={26} color={theme.color.text.onPrimary} />
      </View>
    </Pressable>
  );
}
