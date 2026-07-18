import { Stack } from "expo-router";

import { useStackScreenOptions } from "@/navigation/stack-options";

/** Tab-local Stack (§2.1) — per-tab navigation history (R-nav-10). */
export default function MapStackLayout() {
  return <Stack screenOptions={useStackScreenOptions()} />;
}
