import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * First-run onboarding (§ Resolved questions, Gate 2): name/avatar → home
 * currency → payment handles (skippable) → notification priming → optional
 * travel_style. Content lands with the auth/profile phase.
 */
export default function OnboardingScreen() {
  return (
    <PlaceholderScreen
      screenId="onboarding"
      title="Welcome"
      icon="sparkles-outline"
      note="First-run profile setup: display name, home currency, payment handles, notification priming — everything after name is skippable."
    />
  );
}
