import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Photo viewer (§2.4, PUSH) — full-bleed photo, place/itinerary pin links,
 * visibility control (private/trip/public — explicit check, Law #3), delete.
 * Content owned by the photos spec.
 */
export default function PhotoViewerScreen() {
  const { photoId } = useLocalSearchParams<{ photoId: string }>();
  return (
    <PlaceholderScreen
      screenId="photo-viewer"
      title="Photo"
      subtitle={`Photo ${photoId}`}
      back
      icon="image-outline"
      note="The full-bleed viewer with visibility control and pin links lands with the photos phase."
    />
  );
}
