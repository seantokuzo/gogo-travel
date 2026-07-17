/**
 * ListItem (DS-7, spec §2.9) — rows for members, settings, docs, packing,
 * capture queue. Min height 56 pt (≥44, R-ds-9). `testID` REQUIRED when
 * pressable (R-ds-20, discriminated union).
 *
 * `trailingSwipeActions` is a documented v1 SEAM (spec §2.9) — deliberately
 * not implemented until a screen spec calls for it.
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "./Icon";
import { AppText } from "./Text";

interface ListItemBaseProps {
  title: string;
  subtitle?: string;
  /** Icon / avatar / thumbnail slot. */
  leading?: ReactNode;
  /** `'chevron'` renders the standard disclosure indicator. */
  trailing?: ReactNode | "chevron";
}

export type ListItemProps = ListItemBaseProps &
  (
    | {
        onPress: () => void;
        /** Required when pressable (R-ds-20). */
        testID: string;
        accessibilityLabel?: string;
      }
    | { onPress?: undefined; testID?: string; accessibilityLabel?: undefined }
  );

const useStyles = createStyles((t) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 56,
      paddingVertical: t.space[2],
      paddingHorizontal: t.space[4],
      gap: t.space[3],
    },
    body: { flex: 1, gap: 2 },
    // RN 0.86 dropped StyleSheet.absoluteFillObject.
    pressedOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.color.interactive.pressedOverlay,
    },
  }),
);

export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  testID,
  accessibilityLabel,
}: ListItemProps) {
  const { theme } = useTheme();
  const s = useStyles();

  const content = (
    <>
      {leading !== undefined ? <View>{leading}</View> : null}
      <View style={s.body}>
        <AppText role="subheading" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle !== undefined ? (
          <AppText role="caption" color="secondary" numberOfLines={2}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing === "chevron" ? (
        <Icon name="chevron-forward" size={18} color={theme.color.text.muted} />
      ) : (
        (trailing ?? null)
      )}
    </>
  );

  if (onPress === undefined) {
    return (
      <View style={s.row} testID={testID}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      style={s.row}
    >
      {({ pressed }) => (
        <>
          {content}
          {pressed ? <View style={s.pressedOverlay} pointerEvents="none" /> : null}
        </>
      )}
    </Pressable>
  );
}
