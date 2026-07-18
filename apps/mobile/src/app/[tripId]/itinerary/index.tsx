import { useRouter } from "expo-router";

import { Button } from "@/components";
import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Itinerary tab (§2.4) — day-sectioned plan list, drag-to-reorder, inline
 * travel times, calendar-grid view toggle. Content owned by the itinerary
 * spec; non-active trips default here (R-nav-8).
 */
export default function ItineraryScreen() {
  const tripId = useTripId();
  const router = useRouter();
  return (
    <PlaceholderScreen
      screenId="itinerary"
      title="Itinerary"
      subtitle={`Trip ${tripId}`}
      icon="calendar-outline"
      note="Day-sectioned list, travel times, and the calendar-grid gap view land with the itinerary phase."
    >
      <Button
        title="Add item"
        icon="add"
        onPress={() =>
          router.push({ pathname: "/[tripId]/itinerary/item/new", params: { tripId } })
        }
        testID="itinerary-fab-add"
      />
    </PlaceholderScreen>
  );
}
