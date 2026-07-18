import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Capture onboarding (§2.1, MODAL per §2.6) — the forward-address teach flow
 * (email-forward intake setup). Content owned by the client capture spec.
 */
export default function CaptureOnboardingScreen() {
  return (
    <PlaceholderScreen
      screenId="capture-onboarding"
      title="Email forwarding"
      back
      icon="mail-open-outline"
      note="The forward-address teach flow lands with the capture phase. Presented modally (self-contained flow, R-nav-21)."
    />
  );
}
