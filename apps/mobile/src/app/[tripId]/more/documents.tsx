import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Documents vault (§2.4, pushed from the More hub) — docs with expiry
 * badges and reminder toggles. Content owned by the utilities spec.
 */
export default function DocumentsScreen() {
  const tripId = useTripId();
  return (
    <PlaceholderScreen
      screenId="documents"
      title="Documents"
      subtitle={`Trip ${tripId}`}
      back
      icon="document-text-outline"
      note="The document vault with expiry badges and reminders lands with the utilities phase."
    />
  );
}
