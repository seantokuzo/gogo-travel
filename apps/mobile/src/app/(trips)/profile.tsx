import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Profile & app settings (§ Resolved questions, Gate 2 — PUSH from the
 * trip-list header avatar): profile edit, payment handles, appearance/accent
 * theme, session list/revoke, sign-out.
 */
export default function ProfileScreen() {
  return (
    <PlaceholderScreen
      screenId="profile"
      title="Profile"
      back
      icon="person-circle-outline"
      note="Profile edit, payment handles, appearance and accent theme, sessions, and sign-out land with the auth/profile phase."
    />
  );
}
