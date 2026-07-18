import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Create trip (§2.4, MODAL per §2.6) — name/destination/dates form lands with
 * the trips phase; create → land in the new trip (itinerary tab, R-nav-8).
 */
export default function TripNewScreen() {
  return (
    <PlaceholderScreen
      screenId="trip-new"
      title="New trip"
      back
      icon="add-circle-outline"
      note="Name, destination, and dates form lands with the trips phase. Presented modally (form flow, R-nav-21)."
    />
  );
}
