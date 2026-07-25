/**
 * Sign-in screen render-safety (T-5.7 r1 blocker-1 regression).
 *
 * The real expo-auth-session `useIdTokenAuthRequest` THROWS during render when
 * no Google client id is provisioned. The screen must therefore gate the hook
 * by conditional RENDER (mount the hook-bearing button only when configured),
 * not by a disabled prop — otherwise an unconfigured Google client takes the
 * WHOLE sign-in screen (Apple included) down on the first frame.
 *
 * This suite runs the REAL `@/auth` (real `isGoogleConfigured` /
 * `useGoogleSignIn`) and installs a Google provider mock that FAITHFULLY
 * reproduces the throw-on-undefined-clientId invariant — jest.setup's global
 * stub does NOT throw, which is exactly what masked the crash in round 1. With
 * no client id (the phase-close state), the screen must still render: Apple
 * present + enabled, Google present but disabled. On the pre-fix (unconditional
 * hook call) code this render THROWS — the regression this test locks.
 */
import { screen } from "@testing-library/react-native";

import SignInScreen from "@/app/(auth)/sign-in";
import { renderWithTheme } from "@/test-utils/render";

// Faithful reproduction of expo-auth-session's ProviderUtils invariant: a hook
// call with no client id throws during render. Overrides jest.setup's benign
// global stub for this file only.
jest.mock("expo-auth-session/providers/google", () => ({
  __esModule: true,
  useIdTokenAuthRequest: ({
    iosClientId,
    webClientId,
  }: {
    iosClientId?: string;
    webClientId?: string;
  }) => {
    if (!iosClientId && !webClientId) {
      throw new Error(
        "Client Id property `iosClientId` must be defined to use Google auth on this platform.",
      );
    }
    return [{ nonce: "raw-nonce" }, null, jest.fn()];
  },
}));

// PageHeader reaches for useRouter; the screen itself does no navigation here.
jest.mock("expo-router", () => ({
  __esModule: true,
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));

describe("SignInScreen — render safety with Google unconfigured", () => {
  it("renders without throwing; Apple is present + enabled, Google present + disabled", async () => {
    // No EXPO_PUBLIC_GOOGLE_* provisioned → isGoogleConfigured() is false → the
    // Google hook is never called, so the throwing provider mock never fires.
    // The mere fact that this render resolves is the blocker-1 proof.
    await renderWithTheme(<SignInScreen />);

    const apple = await screen.findByTestId("sign-in-button-apple");
    expect(apple).toBeOnTheScreen();
    expect(apple).toBeEnabled();

    const google = screen.getByTestId("sign-in-button-google");
    expect(google).toBeOnTheScreen();
    expect(google).toBeDisabled();
  });
});
