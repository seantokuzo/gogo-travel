import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Add/edit itinerary item (§2.4, MODAL per §2.6) — category picker, place
 * search, time set; `?itemId=` / `?bookingId=` switch it into edit mode.
 * Content owned by the itinerary spec.
 */
export default function ItineraryItemNewScreen() {
  return (
    <PlaceholderScreen
      screenId="itinerary-item-new"
      title="Add item"
      back
      icon="add-circle-outline"
      note="Category picker, place search, and conflict surfacing land with the itinerary phase. Presented modally (form flow, R-nav-21)."
    />
  );
}
