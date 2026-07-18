import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Map tab (§2.4) — persistent trip map: saved places, day-colored itinerary
 * pins, photo pins, spine-backed search (R-map-25), offline-pack pill.
 * Content owned by the maps spec (Mapbox — ADR'd research call).
 */
export default function MapScreen() {
  const tripId = useTripId();
  return (
    <PlaceholderScreen
      screenId="map"
      title="Map"
      subtitle={`Trip ${tripId}`}
      icon="map-outline"
      note="The persistent trip map with saved places, itinerary pins, and place search lands with the maps phase."
    />
  );
}
