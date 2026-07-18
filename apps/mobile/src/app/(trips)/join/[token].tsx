import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Invite accept (§2.4) — deep-link target for `/invite/[token]` (R-nav-11,
 * NAV-5). Trip preview + accept/decline + dead-token error state land with
 * the invite flow; the route + param plumbing is the skeleton's contract.
 */
export default function InviteJoinScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  return (
    <PlaceholderScreen
      screenId="invite-join"
      title="Join trip"
      subtitle={`Invite ${token}`}
      back
      icon="link-outline"
      note="Trip preview, inviter, role, and accept/decline land with the invite flow (NAV-5 registers the deep link)."
    />
  );
}
