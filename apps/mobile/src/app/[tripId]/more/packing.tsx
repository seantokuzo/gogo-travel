import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Packing (§2.4, pushed from the More hub) — AI-generated + manual
 * checklist. Content owned by the utilities spec.
 */
export default function PackingScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
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
