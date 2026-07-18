import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Capture inbox (§2.4, R-nav-24) — trips-level needs-review queue reachable
 * from the trip-list header (captures can precede trip assignment). The
 * per-trip More-tab entry opens this same queue filtered to that trip.
 * Queue content is owned by the client capture spec (NAV-6 wires the data).
 */
export default function CaptureQueueScreen() {
  return (
    <PlaceholderScreen
      screenId="capture-queue"
      title="Capture inbox"
      back
      icon="file-tray-full-outline"
      note="Captures needing review across all trips land here with the capture phase (share-sheet + email-forward intake)."
    />
  );
}
