import { Stack } from "expo-router";

import { useStackScreenOptions } from "@/navigation/stack-options";

/**
 * (trips) group (navigation.spec §2.1) — trip list + trips-level surfaces.
 * Modal presentations per §2.6 (R-nav-21): `new` (create-trip form) and
 * `capture/onboarding` (forward-address teach flow) are form/self-contained
 * flows → router modals. `join/[token]`, `profile`, and the capture screens
 * are pushes.
 */
export default function TripsLayout() {
  return (
    // initialRouteName is explicit: declared Screen children are registered
    // FIRST, and without it the navigator would boot on the first declared
    // modal instead of the trip list.
    <Stack initialRouteName="index" screenOptions={useStackScreenOptions()}>
      <Stack.Screen name="new" options={{ presentation: "modal" }} />
      <Stack.Screen name="capture/onboarding" options={{ presentation: "modal" }} />
    </Stack>
  );
}
