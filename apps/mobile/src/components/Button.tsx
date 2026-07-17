/**
 * Button (DS-7, spec §2.9) — synced color mapping (DECIDED 2026-07-17):
 * - primary     = `primary.solid` fill + `text.onPrimary`, pressed `primary.solidPressed`
 * - secondary   = primary-outline: transparent fill, `primary.solid` border,
 *                 `text.accent` label (the AA-safe primary-hued ink)
 * - ghost       = transparent + `text.accent`
 * - destructive = `status.danger` pair (fg-on-bg is the AA-validated pairing;
 *                 status groups ship no `onSolid`, so no solid-danger fill)
 *
 * R-ds-13: pressed feedback is synchronous Pressable state (same frame,
 * well under 100 ms). Haptic defaults: primary→actionLight,
 * destructive→warning, secondary/ghost→none (§2.9); `haptic` overrides.
 * R-ds-14: loading shows an inline spinner, blocks presses, and keeps the
 * label mounted at opacity 0 so layout width never shifts.
 * R-ds-9: every size resolves to a ≥44 pt touch target (sm via hitSlop).
 */
import type { HapticEvent, Theme } from "@gogo/tokens";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { triggerHaptic } from "@/theme/haptics";

import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { AppText } from "./Text";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  title: string;
  onPress(): void;
  /** Default `primary`. */
  variant?: ButtonVariant;
  /** Default `md`. All sizes hit ≥44 pt targets (R-ds-9). */
  size?: ButtonSize;
  icon?: IconName;
  /** Default `leading`. */
  iconPosition?: "leading" | "trailing";
  /** R-ds-14: spinner + press-block + stable width. */
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  /** Override the variant's default haptic; `false` silences it. */
  haptic?: HapticEvent | false;
  /** Required on every interactive component (R-ds-20). */
  testID: string;
  /** Defaults to `title` (R-ds-12). */
  accessibilityLabel?: string;
}

const DEFAULT_HAPTIC: Record<ButtonVariant, HapticEvent | false> = {
  primary: "actionLight",
  secondary: false,
  ghost: false,
  destructive: "warning",
};

interface VariantStyle {
  container: ViewStyle;
  /** Fill swap while pressed (primary only — spec: `primary.solidPressed`). */
  pressedFill?: ViewStyle;
  label: TextStyle;
}

function buildVariants(t: Theme): Record<ButtonVariant, VariantStyle> {
  return {
    primary: {
      container: { backgroundColor: t.color.primary.solid },
      pressedFill: { backgroundColor: t.color.primary.solidPressed },
      label: { color: t.color.text.onPrimary },
    },
    secondary: {
      container: {
        backgroundColor: "transparent",
        borderWidth: 1,
        borderColor: t.color.primary.solid,
      },
      label: { color: t.color.text.accent },
    },
    ghost: {
      container: { backgroundColor: "transparent" },
      label: { color: t.color.text.accent },
    },
    destructive: {
      container: {
        backgroundColor: t.color.status.danger.bg,
        borderWidth: 1,
        borderColor: t.color.status.danger.border,
      },
      label: { color: t.color.status.danger.fg },
    },
  };
}

const useStyles = createStyles((t) => ({
  base: StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radius.md,
    },
    content: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: t.space[2],
    },
    // R-ds-14: content stays MOUNTED (stable width), just invisible.
    hiddenContent: { opacity: 0 },
    hug: { alignSelf: "flex-start" },
    full: { alignSelf: "stretch" },
    disabled: {
      backgroundColor: t.color.interactive.disabledBg,
      borderWidth: 0,
    },
    disabledLabel: { color: t.color.interactive.disabledText },
    // RN 0.86 dropped StyleSheet.absoluteFillObject — spell the fill out.
    spinner: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    // Translucent press layer OVER the variant fill (secondary/ghost/
    // destructive; primary swaps its fill instead) — R-ds-13.
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
  size: StyleSheet.create({
    // sm is visually 36 pt; hitSlop.sm (8 pt each side) restores the 44 pt
    // touch target (R-ds-9).
    sm: { minHeight: 36, paddingHorizontal: t.space[3] },
    md: { minHeight: t.touchTarget, paddingHorizontal: t.space[4] },
    lg: { minHeight: 52, paddingHorizontal: t.space[5] },
  }),
  variants: buildVariants(t),
}));

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  icon,
  iconPosition = "leading",
  loading = false,
  disabled = false,
  fullWidth = false,
  haptic,
  testID,
  accessibilityLabel,
}: ButtonProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const v = s.variants[variant];
  const blocked = disabled || loading;
  const labelColor = disabled ? theme.color.interactive.disabledText : (v.label.color as string);

  const handlePress = () => {
    const event = haptic ?? DEFAULT_HAPTIC[variant];
    if (event) triggerHaptic(event);
    onPress();
  };

  const content = (
    <View style={[s.base.content, loading && s.base.hiddenContent]} pointerEvents="none">
      {icon !== undefined && iconPosition === "leading" ? (
        <Icon name={icon} size={18} color={labelColor} />
      ) : null}
      <AppText role="bodyStrong" style={[v.label, disabled && s.base.disabledLabel]}>
        {title}
      </AppText>
      {icon !== undefined && iconPosition === "trailing" ? (
        <Icon name={icon} size={18} color={labelColor} />
      ) : null}
    </View>
  );

  return (
    <Pressable
      testID={testID}
      onPress={handlePress}
      disabled={blocked}
      hitSlop={size === "sm" ? theme.hitSlop.sm : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: blocked, busy: loading }}
      style={({ pressed }) => [
        s.base.container,
        s.size[size],
        v.container,
        fullWidth ? s.base.full : s.base.hug,
        pressed && !blocked && v.pressedFill,
        disabled && s.base.disabled,
      ]}
    >
      {({ pressed }) => (
        <>
          {content}
          {pressed && !blocked && v.pressedFill === undefined ? (
            <View style={s.base.pressedOverlay} pointerEvents="none" />
          ) : null}
          {loading ? (
            <View style={s.base.spinner} pointerEvents="none">
              <ActivityIndicator size="small" color={labelColor} testID={`${testID}-spinner`} />
            </View>
          ) : null}
        </>
      )}
    </Pressable>
  );
}
