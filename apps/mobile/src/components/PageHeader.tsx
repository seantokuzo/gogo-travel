/**
 * PageHeader (DS-9, spec §2.9) — screen title chrome. Safe-area top handling
 * lives HERE, not in screens. `leading: 'back'` auto-wires expo-router's
 * back navigation (no haptic — §2.8: never on push/pop). Trailing actions
 * cap at 2 (spec); extras are dropped, each requires its own testID
 * (R-ds-20).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { AppText } from "./Text";

export interface PageHeaderAction {
  icon: IconName;
  /** Accessibility label for the icon button (R-ds-12). */
  label: string;
  onPress(): void;
  /** Required (R-ds-20). */
  testID: string;
}

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** `title` type role instead of `heading`. */
  large?: boolean;
  /** `'back'` wires router.back(); any ReactNode renders as-is. */
  leading?: "back" | ReactNode;
  /** Max 2 (spec) — extras are not rendered. */
  trailing?: PageHeaderAction[];
  testID?: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    header: {
      backgroundColor: t.color.bg.screen,
      paddingHorizontal: t.space[4],
      paddingBottom: t.space[2],
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: t.touchTarget,
      gap: t.space[3],
    },
    titles: { flex: 1, gap: 2 },
    iconButton: {
      minWidth: t.touchTarget,
      minHeight: t.touchTarget,
      alignItems: "center",
      justifyContent: "center",
    },
    backButton: {
      minHeight: t.touchTarget,
      minWidth: 32,
      alignItems: "flex-start",
      justifyContent: "center",
    },
    actions: { flexDirection: "row", alignItems: "center" },
  }),
);

export function PageHeader({
  title,
  subtitle,
  large = false,
  leading,
  trailing,
  testID = "page-header",
}: PageHeaderProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const s = useStyles();

  return (
    <View style={[s.header, { paddingTop: insets.top + theme.space[2] }]} testID={testID}>
      <View style={s.row}>
        {leading === "back" ? (
          <Pressable
            onPress={() => router.back()}
            testID={`${testID}-back`}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={theme.hitSlop.sm}
            style={s.backButton}
          >
            <Icon name="chevron-back" size={24} color={theme.color.text.accent} />
          </Pressable>
        ) : (
          (leading ?? null)
        )}
        <View style={s.titles}>
          <AppText role={large ? "title" : "heading"} accessibilityRole="header" numberOfLines={1}>
            {title}
          </AppText>
          {subtitle !== undefined ? (
            <AppText role="caption" color="secondary" numberOfLines={1}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {trailing !== undefined && trailing.length > 0 ? (
          <View style={s.actions}>
            {trailing.slice(0, 2).map((action) => (
              <Pressable
                key={action.testID}
                onPress={action.onPress}
                testID={action.testID}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                style={s.iconButton}
              >
                <Icon name={action.icon} size={22} color={theme.color.text.accent} />
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}
