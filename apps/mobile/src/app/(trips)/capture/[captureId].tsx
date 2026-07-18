import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Capture review (§2.4, PUSH) — proposal review/edit, trip picker Sheet,
 * confirm → booking lands. Content owned by the client capture spec.
 */
export default function CaptureReviewScreen() {
  const { captureId } = useLocalSearchParams<{ captureId: string }>();
  return (
    <PlaceholderScreen
      screenId="capture-review"
      title="Review capture"
      subtitle={`Capture ${captureId}`}
      back
      icon="document-text-outline"
      note="Proposal review and edit, trip picker, and confirm-to-booking land with the capture phase."
    />
  );
}
