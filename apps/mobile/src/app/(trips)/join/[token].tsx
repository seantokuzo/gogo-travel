import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Invite accept (§2.4) — deep-link target for `/invite/[token]` (R-nav-11,
 * NAV-5). Trip preview + accept/decline + dead-token error state land with
 * the invite flow; the route + param plumbing is the skeleton's contract.
 */
export default function InviteJoinScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  // Invite tokens are bearer credentials, not entity ids (security review,
  // T-4.4 R1) — never echo one full-length. The truncated preview proves
  // param plumbing without seeding a copy-the-placeholder exposure pattern
  // in the real NAV-5 screen (which renders trip preview/inviter instead).
  const tokenPreview = token.length > 8 ? `${token.slice(0, 8)}…` : token;
  return (
    <PlaceholderScreen
      screenId="invite-join"
      title="Join trip"
      subtitle={`Invite ${tokenPreview}`}
      back
      icon="link-outline"
      note="Trip preview, inviter, role, and accept/decline land with the invite flow (NAV-5 registers the deep link)."
    />
  );
}
