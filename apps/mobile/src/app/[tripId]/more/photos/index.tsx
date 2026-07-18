import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Photos (§2.4, pushed from the More hub) — album grid with visibility
 * badges and upload. Content owned by the photos spec (Law #3: visibility
 * levels are an explicit boundary).
 */
export default function PhotosScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  return (
    <PlaceholderScreen
      screenId="photos"
      title="Photos"
      subtitle={`Trip ${tripId}`}
      back
      icon="images-outline"
      note="The album grid with visibility badges and upload lands with the photos phase."
    />
  );
}
