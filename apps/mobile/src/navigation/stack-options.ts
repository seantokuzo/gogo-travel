/**
 * Shared screen options for every Stack in the route tree (NAV-1).
 *
 * Native headers stay OFF app-wide: PageHeader owns screen chrome — titles,
 * back affordance (tokens spec §2.9). `contentStyle` pins the scene
 * background to the theme so the native-stack white default never flashes
 * during transitions under a dark scheme (R-ds-4 posture).
 *
 * SAFE-AREA TOP is owned by whichever element is actually flush with the top
 * of the window, which is PageHeader on most screens but NOT inside the trip
 * shell — `[tripId]/_layout` puts `TripSwitcherBar` above the tabs and
 * declares a `TopInsetBoundary`, and the header then adds token spacing only
 * (B-27; `components/top-inset.tsx` is the canonical write-up).
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
