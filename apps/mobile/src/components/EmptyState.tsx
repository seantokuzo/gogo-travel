/**
 * EmptyState (DS-8, spec §2.9, R-ds-16) — a collection resolving to zero
 * items renders this, never a blank region. Icon + title + optional body +
 * optional CTA (the action's own `testID` is required — R-ds-20).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { Button } from "./Button";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { AppText } from "./Text";

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  body?: string;
  action?: { label: string; onPress(): void; testID: string };
  testID?: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: {
      alignItems: "center",
      justifyContent: "center",
      padding: t.space[6],
      gap: t.space[3],
    },
    text: { textAlign: "center" },
    action: { marginTop: t.space[2] },
  }),
);

export function EmptyState({ icon, title, body, action, testID }: EmptyStateProps) {
  const { theme } = useTheme();
  const s = useStyles();
  return (
    <View style={s.container} testID={testID}>
      <Icon name={icon} size={48} color={theme.color.text.muted} />
      <AppText role="heading" style={s.text}>
        {title}
      </AppText>
      {body !== undefined ? (
        <AppText color="secondary" style={s.text}>
          {body}
        </AppText>
      ) : null}
      {action !== undefined ? (
        <View style={s.action}>
          <Button
            title={action.label}
            onPress={action.onPress}
            testID={action.testID}
            variant="secondary"
          />
        </View>
      ) : null}
    </View>
  );
}
