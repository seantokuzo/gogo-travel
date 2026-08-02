/* eslint-env jest */
/**
 * Per-test-file setup (setupFilesAfterEnv — the jest-expo preset owns
 * `setupFiles`, so this file must NOT be listed there or it would clobber
 * the preset's RN mocks).
 *
 * Safe-area: PageHeader/TabNav/Sheet read insets; the package's sanctioned
 * jest mock provides deterministic zero insets without a provider wrapper.
 */
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);

/**
 * Auth native modules (T-5.7): the `(auth)/sign-in` route file is eagerly
 * required whenever the route tree is rendered (renderRouter builds the whole
 * manifest), so the native Apple button + Google auth-session hook get global
 * jest stubs here — otherwise the native view / hook would fault outside a
 * device. The button stub forwards its testID + onPress so E2E-style flows
 * still reach it. Tests that exercise the real flows (apple.test/google.test)
 * declare their own file-local jest.mock, which overrides these.
 */
jest.mock("expo-apple-authentication", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  return {
    __esModule: true,
    AppleAuthenticationButton: ({ onPress, testID }) =>
      React.createElement(Pressable, { onPress, testID, accessibilityRole: "button" }),
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1, SIGN_UP: 2 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    isAvailableAsync: jest.fn(async () => true),
    signInAsync: jest.fn(async () => {
      throw new Error("signInAsync not stubbed");
    }),
  };
});

jest.mock("expo-auth-session/providers/google", () => ({
  __esModule: true,
  useIdTokenAuthRequest: () => [null, null, jest.fn(async () => ({ type: "dismiss" }))],
}));

/**
 * Gesture/animation runtime (T-7.4 — the itinerary drag list rides
 * react-native-reorderable-list over gesture-handler + reanimated): all
 * three packages ship sanctioned jest environments — RNGH's jestSetup mocks
 * the native handler modules, react-native-worklets' documented jest mock
 * replaces its TurboModule (reanimated 4 initializes worklets at import, so
 * the mock must be registered FIRST), and reanimated's setUpTests installs
 * its official mock + matchers. Without these the drag list's native
 * imports fault under jest (same class as the auth stubs above).
 */
require("react-native-gesture-handler/jestSetup");
jest.mock("react-native-worklets", () => require("react-native-worklets/lib/module/mock"));
require("react-native-reanimated").setUpTests();
