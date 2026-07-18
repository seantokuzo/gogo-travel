/**
 * Shared screen options for every Stack in the route tree (NAV-1).
 *
 * Native headers stay OFF app-wide: PageHeader owns screen chrome — titles,
 * safe-area top, back affordance (tokens spec §2.9). `contentStyle` pins the
 * scene background to the theme so the native-stack white default never
 * flashes during transitions under a dark scheme (R-ds-4 posture).
 */
import { useTheme } from "@gogo/tokens/react";
import type { NativeStackNavigationOptions } from "expo-router";
import { useMemo } from "react";

export function useStackScreenOptions(): NativeStackNavigationOptions {
  const { theme } = useTheme();
  return useMemo(
    () => ({
      headerShown: false,
      contentStyle: { backgroundColor: theme.color.bg.screen },
    }),
    [theme],
  );
}
