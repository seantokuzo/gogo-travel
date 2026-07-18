import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Settle-up request (§2.4) — recipient view of a settle-request link: share
 * owed, pay options, mark-settled. Deep-link target for
 * `/t/[tripId]/request/[requestId]` (R-nav-13, NAV-5); membership required
 * (app + account v1 — no unauthenticated branch, § Resolved questions).
 */
export default function SettleRequestScreen() {
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  return (
    <PlaceholderScreen
      screenId="settle-request"
      title="Settle request"
      subtitle={`Request ${requestId}`}
      back
      icon="cash-outline"
      note="Share owed, payment options, and mark-as-settled land with the money phase (NAV-5 registers the deep link)."
    />
  );
}
