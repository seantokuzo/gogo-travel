import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Packing (§2.4, pushed from the More hub) — AI-generated + manual
 * checklist. Content owned by the utilities spec.
 */
export default function PackingScreen() {
  const tripId = useTripId();
  return (
    <PlaceholderScreen
      screenId="packing"
      title="Packing"
      subtitle={`Trip ${tripId}`}
      back
      icon="briefcase-outline"
      note="The AI-generated and manual packing checklist lands with the utilities phase."
    />
  );
}
