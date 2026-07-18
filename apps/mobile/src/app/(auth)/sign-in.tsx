import { Button } from "@/components";
import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

const noop = () => undefined;

/** Sign-in (§2.4) — Apple/Google AuthSession wiring arrives with NAV-2 + the auth spec. */
export default function SignInScreen() {
  return (
    <PlaceholderScreen
      screenId="sign-in"
      title="Sign in"
      icon="person-circle-outline"
      note="Apple and Google sign-in land with the auth phase; NAV-2 wires the redirect gate and stash/resume."
    >
      <Button title="Continue with Apple" onPress={noop} fullWidth testID="sign-in-button-apple" />
      <Button
        title="Continue with Google"
        onPress={noop}
        variant="secondary"
        fullWidth
        testID="sign-in-button-google"
      />
    </PlaceholderScreen>
  );
}
