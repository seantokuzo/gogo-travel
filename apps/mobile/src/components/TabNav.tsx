/**
 * TabNav (DS-9, spec §2.9) — the custom tab bar for the `[tripId]` Tabs
 * navigator. PRESENTATIONAL contract: the navigator wiring (NAV tasks) maps
 * router state → `items`/`activeKey` and `navigation.navigate` → `onSelect`
 * inside its `tabBar` render prop; this component never imports navigation.
 *
 * Active tint `primary.solid` (DECIDED 2026-07-17, two-group system),
 * inactive `text.muted`, `bg.surface` bar + `border.subtle` top hairline,
 * safe-area aware, `selection` haptic on ACTUAL switches only (§2.8 — tab
 * re-tap is a no-op, and navigation push/pop itself never fires haptics).
 * Per-item testID `tab-bar-{key}` (spec-fixed, not derived from a prop).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { triggerHaptic } from "@/theme/haptics";

import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { AppText } from "./Text";

export interface TabNavItem {
  key: string;
  label: string;
  icon: IconName;
  /** Count bubble, or `'dot'` for an unread indicator. */
  badge?: number | "dot";
}

export interface TabNavProps {
  items: TabNavItem[];
  activeKey: string;
  onSelect(key: string): void;
  testID?: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      backgroundColor: t.color.bg.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.color.border.subtle,
      paddingTop: t.space[2],
    },
    item: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      minHeight: t.touchTarget,
      gap: 2,
      paddingBottom: t.space[1],
    },
    iconWrap: { position: "relative" },
    labelActive: { color: t.color.primary.solid },
    labelInactive: { color: t.color.text.muted },
    badge: {
      position: "absolute",
      top: -t.space[1],
      right: -t.space[2],
      minWidth: 16,
      height: 16,
      borderRadius: t.radius.full,
      backgroundColor: t.color.status.danger.bg,
      borderWidth: 1,
      borderColor: t.color.status.danger.border,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 3,
    },
    badgeText: { color: t.color.status.danger.fg },
    // Non-text indicator — needs 3:1, danger.fg clears it on surfaces.
    dot: {
      position: "absolute",
      top: -2,
      right: -t.space[1],
      width: 8,
      height: 8,
      borderRadius: t.radius.full,
      backgroundColor: t.color.status.danger.fg,
    },
  }),
);

export function TabNav({ items, activeKey, onSelect, testID }: TabNavProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const s = useStyles();

  return (
    <View style={[s.bar, { paddingBottom: insets.bottom }]} testID={testID}>
      {items.map(({ key, label, icon, badge }) => {
        const active = key === activeKey;
        return (
          <Pressable
            key={key}
            testID={`tab-bar-${key}`}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            style={s.item}
            onPress={() => {
              if (active) return; // re-tap: no haptic, no navigation (§2.8)
              triggerHaptic("selection");
              onSelect(key);
            }}
          >
            <View style={s.iconWrap}>
              <Icon
                name={icon}
                size={24}
                color={active ? theme.color.primary.solid : theme.color.text.muted}
              />
              {badge === "dot" ? (
                <View style={s.dot} testID={`tab-bar-${key}-dot`} />
              ) : typeof badge === "number" ? (
                <View style={s.badge} testID={`tab-bar-${key}-badge`}>
                  <AppText role="label" style={s.badgeText} allowFontScaling={false}>
                    {badge > 99 ? "99+" : String(badge)}
                  </AppText>
                </View>
              ) : null}
            </View>
            <AppText role="label" style={active ? s.labelActive : s.labelInactive}>
              {label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
