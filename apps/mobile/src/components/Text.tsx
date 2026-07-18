/**
 * AppText — the typography primitive (DS-5, spec §2.3). Every other
 * design-system component renders text through this; screens should too.
 *
 * - Type roles come from `theme.type` — components never set raw font sizes.
 * - Dynamic Type: `allowFontScaling` stays on (RN default); each role's
 *   `maxFontSizeMultiplier` cap is applied as a PROP (R-ds-10) — callers may
 *   override for special chrome, never disable scaling wholesale.
 * - `label` role renders uppercase (spec §2.3: "badges, tab labels
 *   (uppercase, +0.4 tracking)") — the tracking lives in the token, the
 *   transform lives here because TypeStyle cannot express it.
 */
import type { SemanticColors, Theme, TypeRole, TypeStyle } from "@gogo/tokens";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { StyleSheet, Text as RNText } from "react-native";
import type { TextProps as RNTextProps, TextStyle } from "react-native";

export type AppTextColor = keyof SemanticColors["text"];

/**
 * RN's own `role` (ARIA) prop is intentionally masked — the spec's API is
 * `role: TypeRole` (§2.3); use `accessibilityRole` for AT semantics.
 */
export interface AppTextProps extends Omit<RNTextProps, "role"> {
  /** Typography role (spec §2.3 table). Default `body`. */
  role?: TypeRole;
  /** Semantic text color token. Default `primary`. */
  color?: AppTextColor;
}

/** TypeStyle → RN TextStyle (drops the non-style `maxFontSizeMultiplier`). */
function toTextStyle(t: TypeStyle, role: TypeRole): TextStyle {
  return {
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    fontWeight: t.fontWeight,
    ...(t.fontFamily !== undefined ? { fontFamily: t.fontFamily } : null),
    ...(t.letterSpacing !== undefined ? { letterSpacing: t.letterSpacing } : null),
    ...(role === "label" ? { textTransform: "uppercase" as const } : null),
  };
}

function buildRoleStyles(theme: Theme): Record<TypeRole, TextStyle> {
  const entries = Object.entries(theme.type) as [TypeRole, TypeStyle][];
  const styles = {} as Record<TypeRole, TextStyle>;
  for (const [role, typeStyle] of entries) {
    styles[role] = toTextStyle(typeStyle, role);
  }
  return styles;
}

function buildColorStyles(theme: Theme): Record<AppTextColor, TextStyle> {
  const entries = Object.entries(theme.color.text) as [AppTextColor, string][];
  const styles = {} as Record<AppTextColor, TextStyle>;
  for (const [name, value] of entries) {
    styles[name] = { color: value };
  }
  return styles;
}

// Builders stay pure; the single StyleSheet.create wrap lives inside the
// factory so the R-ds-7 lint can see the createStyles ancestry.
const useStyles = createStyles((t) => ({
  role: StyleSheet.create(buildRoleStyles(t)),
  color: StyleSheet.create(buildColorStyles(t)),
}));

export function AppText({
  role = "body",
  color = "primary",
  style,
  maxFontSizeMultiplier,
  ...rest
}: AppTextProps) {
  const { theme } = useTheme();
  const s = useStyles();
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? theme.type[role].maxFontSizeMultiplier}
      style={[s.role[role], s.color[color], style]}
    />
  );
}
