import { Stack } from "expo-router";

import { useStackScreenOptions } from "@/navigation/stack-options";

/**
 * Tab-local Stack (§2.1 "pattern repeats per tab") — per-tab navigation
 * history (R-nav-10). Today is single-screen for now; cross-tab pushes from
 * the today timeline land in the ITINERARY stack (§2.4), not here.
 */
export default function TodayStackLayout() {
  return <Stack screenOptions={useStackScreenOptions()} />;
}
