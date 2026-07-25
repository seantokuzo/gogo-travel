/**
 * Sign-in composition (T-5.7 r1 blocker-2) — the sign-in SCREEN's own
 * press → provider → apiClient → applySignIn glue, proven on the REAL route
 * tree. Isolated RNTL v14 renders don't complete press→async chains, but the
 * `renderRouter` harness does (navigation-skeleton presses buttons + awaits).
 *
 * One mount, sequential branches (harness quirk 3: a navigating mount wedges
 * later mounts in the SAME file — so the non-navigating cancel/error branches
 * run first, the navigating success branch last). Apple stands in for both
 * providers here: it exercises the identical `submit()` assembly, and the
 * Google build/finish path is unit-covered in google.test.
 */
import { authEndpoints, type SignInResponse } from "@gogo/shared";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import { apiClient, ApiRequestError, useSessionStore } from "@/auth";
// `@/auth/apple` is jest.mock'd below (hoisted above every import) — this
// binding is the mock; the sign-in screen's `signInWithApple` resolves to it too.
import { signInWithApple } from "@/auth/apple";
import { seedUnauthenticated, TEST_USER } from "@/test-utils/session-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// Apple provider seam: replace the native sheet with deterministic outcomes,
// keeping the rest of `@/auth` real (store, apiClient, config, gate).
jest.mock("@/auth/apple", () => ({
  __esModule: true,
  signInWithApple: jest.fn(),
  isAppleAuthAvailable: jest.fn().mockResolvedValue(true),
}));

// In-memory Keychain so applySignIn's token write doesn't hit native.
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const applePayload = {
  identity_token: "id-token",
  authorization_code: "auth-code",
  raw_nonce: "raw-nonce",
  device: { platform: "ios" as const },
};

const newUserResponse: SignInResponse = {
  user: TEST_USER,
  tokens: { access_token: "a", refresh_token: "r", expires_in: 900 },
  is_new_user: true,
};

afterAll(() => {
  jest.restoreAllMocks();
});

it("drives cancel → error → success through the real sign-in composition", async () => {
  jest.useRealTimers();
  // Seeded state stands in for boot hydration; keep hydrate a no-op so nothing
  // touches the network before the presses.
  useSessionStore.setState({ hydrate: async () => undefined });
  seedUnauthenticated();

  // The one real seam we intercept: the outbound sign-in POST.
  const requestSpy = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  const apple = signInWithApple as jest.MockedFunction<typeof signInWithApple>;

  const result = renderRouter("src/app", { initialUrl: "/sign-in" });
  await result;
  // Presses are AWAITED below (RNTL v14 `fireEvent` is async) so each act
  // settles instead of leaving a floating act() that interleaves across suites
  // under CI contention (determinism, B-2). Fake timers (renderRouter's) stay
  // so navigation transition timeouts don't linger as open handles.
  await screen.findByTestId("sign-in-screen");

  // 1) Cancel — the provider sheet is dismissed → no POST, no error, no auth.
  apple.mockResolvedValueOnce(null);
  await fireEvent.press(screen.getByTestId("sign-in-button-apple"));
  await waitFor(() => expect(apple).toHaveBeenCalledTimes(1));
  expect(requestSpy).not.toHaveBeenCalled();
  expect(screen.queryByTestId("sign-in-error")).toBeNull();
  expect(useSessionStore.getState().user).toBeNull();

  // 2) Error — the sign-in POST rejects → the DS error banner shows, still no auth.
  apple.mockResolvedValueOnce(applePayload);
  requestSpy.mockRejectedValueOnce(new ApiRequestError(401, "UNAUTHENTICATED", "denied"));
  await fireEvent.press(screen.getByTestId("sign-in-button-apple"));
  await waitFor(() => expect(screen.getByTestId("sign-in-error")).toBeOnTheScreen());
  expect(useSessionStore.getState().user).toBeNull();

  // 3) Success — signInWithApple → apiClient POST → applySignIn → authed. A NEW
  // user routes through onboarding: the composition's observable end state, and
  // the proof applySignIn received the SignInResponse the POST resolved.
  apple.mockResolvedValueOnce(applePayload);
  requestSpy.mockResolvedValueOnce(newUserResponse);
  await fireEvent.press(screen.getByTestId("sign-in-button-apple"));

  await waitFor(() => expect(screen.getByTestId("onboarding-screen")).toBeOnTheScreen());
  expect(requestSpy).toHaveBeenCalledWith(authEndpoints.appleSignIn, { body: applePayload });
  expect(useSessionStore.getState().user).toEqual(TEST_USER);
});
