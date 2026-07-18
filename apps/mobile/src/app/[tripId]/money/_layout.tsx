import { Stack } from "expo-router";

import { useStackScreenOptions } from "@/navigation/stack-options";

/**
 * Tab-local Stack (§2.1) — per-tab navigation history (R-nav-10).
 * `expense/new` is a create/edit form → router modal (R-nav-21); expense
 * detail, settle, and settle-request are pushes.
 */
export default function MoneyStackLayout() {
  return (
    // initialRouteName is explicit: declared Screen children register FIRST,
    // and without it the stack would boot on the modal instead of the hub.
    <Stack initialRouteName="index" screenOptions={useStackScreenOptions()}>
      <Stack.Screen name="expense/new" options={{ presentation: "modal" }} />
    </Stack>
  );
}
