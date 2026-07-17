/**
 * ErrorBanner (DS-8, spec §2.9, R-ds-17) — inline banner (not a toast)
 * pinned to the top of the failed surface; errors are never silently
 * swallowed. Retry/dismiss derive `{testID}-retry` / `{testID}-dismiss`.
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "./Icon";
import { AppText } from "./Text";

export type ErrorBannerTone = "danger" | "warning";

export interface ErrorBannerProps {
  message: string;
  onRetry?(): void;
  onDismiss?(): void;
  /** Default `danger`. */
  tone?: ErrorBannerTone;
  /** Required (R-ds-20). */
  testID: string;
}

const useStyles = createStyles((t) => ({
  base: StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[2],
      borderRadius: t.radius.md,
      borderWidth: 1,
      padding: t.space[3],
    },
    message: { flex: 1 },
    // Visually compact controls; hitSlop restores the 44 pt target (R-ds-9).
    control: { minHeight: 28, justifyContent: "center" },
  }),
  tone: {
    danger: StyleSheet.create({
      banner: {
        backgroundColor: t.color.status.danger.bg,
        borderColor: t.color.status.danger.border,
      },
      text: { color: t.color.status.danger.fg },
    }),
    warning: StyleSheet.create({
      banner: {
        backgroundColor: t.color.status.warning.bg,
        borderColor: t.color.status.warning.border,
      },
      text: { color: t.color.status.warning.fg },
    }),
  },
}));

export function ErrorBanner({
  message,
  onRetry,
  onDismiss,
  tone = "danger",
  testID,
}: ErrorBannerProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const toneStyle = s.tone[tone];
  const fg = theme.color.status[tone].fg;

  return (
    <View style={[s.base.banner, toneStyle.banner]} testID={testID} accessibilityRole="alert">
      <Icon name={tone === "danger" ? "alert-circle" : "warning"} size={20} color={fg} />
      <AppText style={[s.base.message, toneStyle.text]}>{message}</AppText>
      {onRetry !== undefined ? (
        <Pressable
          onPress={onRetry}
          testID={`${testID}-retry`}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          hitSlop={theme.hitSlop.sm}
          style={s.base.control}
        >
          <AppText role="bodyStrong" style={toneStyle.text}>
            Retry
          </AppText>
        </Pressable>
      ) : null}
      {onDismiss !== undefined ? (
        <Pressable
          onPress={onDismiss}
          testID={`${testID}-dismiss`}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={theme.hitSlop.md}
          style={s.base.control}
        >
          <Icon name="close" size={18} color={fg} />
        </Pressable>
      ) : null}
    </View>
  );
}
