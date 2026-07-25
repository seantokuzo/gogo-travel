/**
 * Section (T-5.8) — a titled block for the profile screen. Tokens-only; the
 * uppercase label uses the DS `label` type role.
 */
import { createStyles } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components";

export interface SectionProps {
  title: string;
  children: ReactNode;
  testID?: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    section: { gap: t.space[3], paddingHorizontal: t.space[4], paddingVertical: t.space[3] },
  }),
);

export function Section({ title, children, testID }: SectionProps) {
  const s = useStyles();
  return (
    <View style={s.section} testID={testID}>
      <AppText role="label" color="secondary" accessibilityRole="header">
        {title}
      </AppText>
      {children}
    </View>
  );
}
