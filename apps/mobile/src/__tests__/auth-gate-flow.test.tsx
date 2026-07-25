/**
 * Auth-gate end-to-end walkthrough (T-5.7 / NAV-2) against the REAL route tree
 * (expo-router testing-library). One mount, sequential store transitions —
 * proves R-nav-1..4 with the actual navigator (the AuthGate.test unit covers
 * the same branches against a mocked router; this is the integration proof):
 *   unauthed deep route → sign-in + stash (R-nav-1)
 *   new-user sign-in     → onboarding      (R-nav-2 first-run)
 *   onboarding complete  → resume the stash (R-nav-2)
 *   sign-out             → reset to sign-in (R-nav-4)
 *
 * Harness note: all navigation lives in this single mount (navigation-skeleton
 * quirk 3 — a navigating mount wedges later mounts in the same file).
 */
import { authEndpoints, type SignInResponse } from "@gogo/shared";
import { act, cleanup, renderRouter, screen, waitFor } from "expo-router/testing-library";

import { apiClient, useSessionStore } from "@/auth";
import { seedUnauthenticated, TEST_USER } from "@/test-utils/session-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// In-memory Keychain so applySignIn / signOut token writes don't hit native.
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const newUserSignIn: SignInResponse = {
  user: TEST_USER,
  tokens: { access_token: "a", refresh_token: "r", expires_in: 900 },
  is_new_user: true,
};

it("gates the unauthed → onboarding → resume → sign-out lifecycle on the real tree", async () => {
  await cleanup();
  jest.useRealTimers();
  // Seeded state stands in for boot hydration; keep hydrate a no-op.
  useSessionStore.setState({ hydrate: async () => undefined });
  seedUnauthenticated();
  // signOut now fires a best-effort /auth/logout (spec §3.6.1) — stub the one
  // real ApiClient call so R-nav-4 stays a pure store/navigation assertion.
  const requestSpy = jest.spyOn(apiClient, "request").mockResolvedValue(undefined as never);

  const result = renderRouter("src/app", { initialUrl: "/trip-1/today" });
  await result;

  // R-nav-1: an unauthenticated deep route redirects to sign-in and stashes it.
  await waitFor(() => expect(screen.getByTestId("sign-in-screen")).toBeOnTheScreen());
  expect(useSessionStore.getState().pendingDestination).toBe("/trip-1/today");

  // R-nav-2 (first run): a new-user sign-in routes through onboarding.
  await act(async () => {
    await useSessionStore.getState().applySignIn(newUserSignIn);
  });
  await waitFor(() => expect(screen.getByTestId("onboarding-screen")).toBeOnTheScreen());

  // R-nav-2 (resume): completing onboarding resumes the stashed destination.
  await act(async () => {
    useSessionStore.getState().completeOnboarding();
  });
  await waitFor(() => expect(screen.getByTestId("today-screen")).toBeOnTheScreen());
  expect(useSessionStore.getState().pendingDestination).toBeNull();

  // R-nav-4: sign-out resets the stack back to sign-in.
  await act(async () => {
    await useSessionStore.getState().signOut();
  });
  await waitFor(() => expect(screen.getByTestId("sign-in-screen")).toBeOnTheScreen());
  // R-nav-4 sign-out attempts the best-effort logout before clearing.
  expect(requestSpy).toHaveBeenCalledWith(authEndpoints.logout, { body: {} });

  requestSpy.mockRestore();
});
