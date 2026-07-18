import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Itinerary item detail (§2.4, PUSH) — place-visit/custom item detail;
 * `booking`-kind items route to booking-detail instead. Content owned by the
 * itinerary spec.
 */
export default function ItineraryItemScreen() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  return (
    <PlaceholderScreen
      screenId="itinerary-item"
      title="Itinerary item"
      subtitle={`Item ${itemId}`}
      back
      icon="location-outline"
      note="Times, place link, expenses link, and edit/delete land with the itinerary phase."
    />
  );
}
