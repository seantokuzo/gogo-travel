/**
 * Card (DS-7, spec §2.9) — the composition surface for itinerary items,
 * bookings, expenses, and trip cards.
 *
 * Variants: `raised` (elevation 1) · `flat` (border only) · `inset`
 * (`bg.inset` well). `testID` is REQUIRED when pressable (R-ds-20) —
 * enforced by the discriminated props union.
 */
import { createStyles } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

export type CardVariant = "raised" | "flat" | "inset";

interface CardBaseProps {
  /** Default `raised`. */
  variant?: CardVariant;
  /** Default true — `space[4]` padding (§2.4 card convention). */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export type CardProps = CardBaseProps &
  (
    | {
        onPress: () => void;
        /** Required when pressable (R-ds-20). */
        testID: string;
        accessibilityLabel?: string;
      }
    | { onPress?: undefined; testID?: string; accessibilityLabel?: undefined }
  );

const useStyles = createStyles((t) => ({
  base: StyleSheet.create({
    card: { borderRadius: t.radius.md, backgroundColor: t.color.bg.surface },
    padded: { padding: t.space[4] },
    // Translucent layer OVER the variant fill (not a fill swap) — R-ds-13.
    // (RN 0.86 dropped StyleSheet.absoluteFillObject.)
    pressedOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.color.interactive.pressedOverlay,
      borderRadius: t.radius.md,
    },
  }),
  variant: StyleSheet.create({
    raised: { ...t.elevation[1] },
    flat: { borderWidth: 1, borderColor: t.color.border.subtle },
    inset: { backgroundColor: t.color.bg.inset },
  }),
}));

export function Card({
  variant = "raised",
  padded = true,
  style,
  children,
  onPress,
  testID,
  accessibilityLabel,
}: CardProps) {
  const s = useStyles();
  const cardStyle = [s.base.card, s.variant[variant], padded && s.base.padded, style];

  if (onPress === undefined) {
    return (
      <View style={cardStyle} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={cardStyle}
    >
      {({ pressed }) => (
        <>
          {children}
          {pressed ? <View style={s.base.pressedOverlay} pointerEvents="none" /> : null}
        </>
      )}
    </Pressable>
  );
}
