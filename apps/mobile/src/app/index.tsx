import { createStyles, useTheme } from "@gogo/tokens/react";
import { StyleSheet, Text, View } from "react-native";

// First live token consumer (R-ds-7 pattern): factory declared at module
// scope, StyleSheet.create runs INSIDE it, once per theme object.
const useStyles = createStyles((t) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.bg.screen,
      padding: t.space[6],
    },
    title: {
      ...t.type.title,
      color: t.color.text.primary,
    },
  }),
);

export default function Index() {
  const { theme } = useTheme();
  const s = useStyles();
  return (
    <View style={s.container} testID="home-screen">
      <Text
        style={s.title}
        testID="home-title"
        // Dynamic Type cap is a Text PROP, not a style (R-ds-10).
        maxFontSizeMultiplier={theme.type.title.maxFontSizeMultiplier}
      >
        GoGo Travel
      </Text>
    </View>
  );
}
