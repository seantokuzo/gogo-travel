/**
 * Badge (DS-7, spec §2.9) — booking status, parse status, member roles,
 * offline pill, "Up next" chip. NON-interactive (no testID requirement).
 *
 * Tone mapping (DECIDED 2026-07-17, synced post-T-4.1):
 * - `accent` (incl. "Up next") = `accent.subtleBg` fill + `accent.subtleBorder`
 *   + `text.accent` ink (contrast-matrix-validated pairing)
 * - status tones = their `status.*` fg/bg/border trio
 * - `neutral` = `bg.inset` + `border.default` + `text.secondary`
 */
import type { Theme } from "@gogo/tokens";
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { AppText } from "./Text";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
export type BadgeSize = "sm" | "md";

export interface BadgeProps {
  label: string;
  /** Default `neutral`. */
  tone?: BadgeTone;
  /** Default `md`. */
  size?: BadgeSize;
  testID?: string;
}

interface ToneStyle {
  container: ViewStyle;
  label: TextStyle;
}

function buildTones(t: Theme): Record<BadgeTone, ToneStyle> {
  const status = (tone: "success" | "warning" | "danger" | "info"): ToneStyle => ({
    container: {
      backgroundColor: t.color.status[tone].bg,
      borderColor: t.color.status[tone].border,
    },
    label: { color: t.color.status[tone].fg },
  });
  return {
    neutral: {
      container: { backgroundColor: t.color.bg.inset, borderColor: t.color.border.default },
      label: { color: t.color.text.secondary },
    },
    accent: {
      container: {
        backgroundColor: t.color.accent.subtleBg,
        borderColor: t.color.accent.subtleBorder,
      },
      label: { color: t.color.text.accent },
    },
    success: status("success"),
    warning: status("warning"),
    danger: status("danger"),
    info: status("info"),
  };
}

const useStyles = createStyles((t) => ({
  base: StyleSheet.create({
    badge: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      borderRadius: t.radius.full,
      borderWidth: 1,
    },
    sm: { paddingHorizontal: t.space[2], paddingVertical: 2 },
    md: { paddingHorizontal: t.space[3], paddingVertical: t.space[1] },
  }),
  tones: buildTones(t),
}));

export function Badge({ label, tone = "neutral", size = "md", testID }: BadgeProps) {
  const s = useStyles();
  return (
    <View style={[s.base.badge, s.base[size], s.tones[tone].container]} testID={testID}>
      <AppText role="label" style={s.tones[tone].label}>
        {label}
      </AppText>
    </View>
  );
}
