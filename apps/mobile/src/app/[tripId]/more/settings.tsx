import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Trip settings (§2.4, pushed from the More hub) — dates/name/destination
 * edit, trip theme (R-ds-22: trip-scoped accents only), offline pack,
 * leave/delete with destructive Confirms. Content owned by the trips spec.
 */
export default function TripSettingsScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  return (
    <PlaceholderScreen
      screenId="trip-settings"
      title="Trip settings"
      subtitle={`Trip ${tripId}`}
      back
      icon="settings-outline"
      note="Trip edit, theme, offline pack, and leave/delete land with the trips phase."
    />
  );
}
