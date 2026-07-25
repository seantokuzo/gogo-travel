/**
 * Sign-in screen (T-5.7 / NAV-2) — the native Apple button + Google button
 * render, and the auth-session error surfaces the DS error banner.
 *
 * SCOPE NOTE: the button → provider → API → session async handlers are covered
 * by the unit suites — `apple.test` (request shape + nonce), `google.test`
 * (payload), `api-client.test` (POST + SignInResponse handling), and
 * `session-store.test` (`applySignIn`). Press/effect-triggered async chains do
 * not run to completion under isolated RNTL v14 renders (they DO in the real
 * runtime and in the renderRouter tree), so this suite asserts only the
 * synchronous, DOM-observable surface here; the end-to-end happy path is a
 * device-QA step (real credentials — see the phase-close dependency).
 */
import { screen } from "@testing-library/react-native";

import SignInScreen from "@/app/(auth)/sign-in";
import { renderWithTheme } from "@/test-utils/render";

const mockUseGoogleSignIn = jest.fn(() => ({
  request: { nonce: "raw-nonce" } as unknown,
  response: null as unknown,
  promptAsync: jest.fn(),
}));

jest.mock("@/auth", () => ({
  __esModule: true,
  apiClient: { request: jest.fn() },
  useSessionStore: { getState: () => ({ applySignIn: jest.fn() }) },
  signInWithApple: jest.fn(),
  isAppleAuthAvailable: jest.fn().mockResolvedValue(true),
  useGoogleSignIn: () => mockUseGoogleSignIn(),
  buildGoogleSignInRequest: () => null,
}));

// PageHeader reaches for useRouter; the screen itself does no navigation.
jest.mock("expo-router", () => ({
  __esModule: true,
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));

beforeEach(() => {
  mockUseGoogleSignIn.mockReturnValue({
    request: { nonce: "raw-nonce" },
    response: null,
    promptAsync: jest.fn(),
  });
});

describe("SignInScreen", () => {
  it("renders the native Apple button and the Google button", async () => {
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByTestId("sign-in-button-apple")).toBeOnTheScreen();
    expect(screen.getByTestId("sign-in-button-google")).toBeOnTheScreen();
  });

  it("surfaces the error banner when the Google auth-session reports an error", async () => {
    mockUseGoogleSignIn.mockReturnValue({
      request: { nonce: "raw-nonce" },
      response: { type: "error" },
      promptAsync: jest.fn(),
    });
    await renderWithTheme(<SignInScreen />);
    expect(await screen.findByTestId("sign-in-error")).toBeOnTheScreen();
  });
});
