import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Place detail (§2.4) — place info from the POI spine + FSQ details, visit
 * notes, linked items/photos. §2.1: small preview is a Sheet over the map;
 * THIS route is the full-detail PUSH. Content owned by the maps spec.
 */
export default function PlaceDetailScreen() {
  const { placeId } = useLocalSearchParams<{ placeId: string }>();
  return (
    <PlaceholderScreen
      screenId="place-detail"
      title="Place"
      subtitle={`Place ${placeId}`}
      back
      icon="location-outline"
      note="Place info, visit notes, linked itinerary items and photos, and add-to-day land with the maps phase."
    />
  );
}
