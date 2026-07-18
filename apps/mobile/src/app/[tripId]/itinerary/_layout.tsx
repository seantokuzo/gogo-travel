import { Stack } from "expo-router";

import { useStackScreenOptions } from "@/navigation/stack-options";

/**
 * Tab-local Stack (§2.1) — per-tab navigation history (R-nav-10).
 * `item/new` is the add/edit form → router modal (R-nav-21); item and
 * booking details are pushes.
 */
export default function ItineraryStackLayout() {
  return (
    // initialRouteName is explicit: declared Screen children register FIRST,
    // and without it the stack would boot on the modal instead of the list.
    <Stack initialRouteName="index" screenOptions={useStackScreenOptions()}>
      <Stack.Screen name="item/new" options={{ presentation: "modal" }} />
    </Stack>
  );
}
