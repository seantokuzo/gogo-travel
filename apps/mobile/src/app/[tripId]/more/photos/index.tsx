import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Photos (§2.4, pushed from the More hub) — album grid with visibility
 * badges and upload. Content owned by the photos spec (Law #3: visibility
 * levels are an explicit boundary).
 */
export default function PhotosScreen() {
  const tripId = useTripId();
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
