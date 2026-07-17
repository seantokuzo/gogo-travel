import { ThemeProvider, useTheme } from "@gogo/tokens/react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { systemAppearance, themeStorage } from "@/theme";

/**
 * Navigator chrome lives INSIDE the provider so useTheme re-skins the stack
 * header, screen background, and status bar on scheme/accent changes
 * (R-ds-3 / R-ds-6 end-to-end).
 */
function ThemedShell() {
  const { theme, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.color.bg.surface },
          headerTintColor: theme.color.text.accent,
          headerTitleStyle: { color: theme.color.text.primary },
          contentStyle: { backgroundColor: theme.color.bg.screen },
        }}
      />
    </>
  );
}

export default function RootLayout() {
  // Both adapters are module-level singletons (src/theme) — referentially
  // stable across renders, per the ThemeProviderProps contract.
  return (
    <ThemeProvider storage={themeStorage} systemAppearance={systemAppearance}>
      <ThemedShell />
    </ThemeProvider>
  );
}
