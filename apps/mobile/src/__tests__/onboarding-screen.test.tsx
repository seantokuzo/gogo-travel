/**
 * Onboarding wizard (T-5.8 / R-nav-2) — component-level behavior with the REAL
 * session store and the network boundary (`apiClient.request`) mocked. expo-router
 * is stubbed the way sign-in-screen.test does (PageHeader reaches for useRouter;
 * the screen itself does no navigation — the gate drives it).
 *
 * Covers: the required-name gate, skip-all still finishing on `completeOnboarding`,
 * the whole-object prefs PATCH, and the in-form zelle-requires-display-name rule.
 */
import { userEndpoints } from "@gogo/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import { apiClient, useSessionStore } from "@/auth";
import OnboardingScreen from "@/app/(auth)/onboarding";
import { renderWithProviders } from "@/test-utils/render";
import { TEST_USER, seedAuthenticated } from "@/test-utils/session-fixtures";

jest.mock("expo-router", () => ({
  __esModule: true,
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

/** Mock the network boundary — updateMe returns a User, handles returns handles. */
function mockApi(): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((descriptor: { method: string; path: string }) => {
    if (descriptor.path === "/users/me") return Promise.resolve(TEST_USER);
    if (descriptor.path === "/users/me/payment-handles") {
      return Promise.resolve({
        venmo_username: null,
        cashtag: null,
        paypalme_username: null,
        zelle_handle: null,
        zelle_display_name: null,
      });
    }
    return Promise.reject(new Error(`unexpected ${descriptor.path}`));
  });
  return request;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("OnboardingScreen", () => {
  it("gates the first step on a valid display name", async () => {
    seedAuthenticated({ firstRun: true });
    await renderWithProviders(<OnboardingScreen />);

    expect(screen.getByTestId("onboarding-button-continue")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("onboarding-input-name"), "Alice");
    expect(screen.getByTestId("onboarding-button-continue")).toBeEnabled();
  });

  it("skipping every optional step still finishes with just the name (completeOnboarding)", async () => {
    seedAuthenticated({ firstRun: true });
    const request = mockApi();
    await renderWithProviders(<OnboardingScreen />);

    await fireEvent.changeText(screen.getByTestId("onboarding-input-name"), "Alice");
    await fireEvent.press(screen.getByTestId("onboarding-button-continue")); // → currency
    await fireEvent.press(screen.getByTestId("onboarding-button-skip")); // → styles
    await fireEvent.press(screen.getByTestId("onboarding-button-skip")); // → handles
    await fireEvent.press(screen.getByTestId("onboarding-button-finish"));

    await waitFor(() => expect(useSessionStore.getState().firstRun).toBe(false));
    expect(request).toHaveBeenCalledWith(userEndpoints.updateMe, {
      body: { display_name: "Alice", prefs: {} },
    });
    expect(request).not.toHaveBeenCalledWith(userEndpoints.updatePaymentHandles, expect.anything());
  });

  it("PATCHes prefs as a whole object with the selected currency + travel styles", async () => {
    seedAuthenticated({ firstRun: true });
    const request = mockApi();
    await renderWithProviders(<OnboardingScreen />);

    await fireEvent.changeText(screen.getByTestId("onboarding-input-name"), "Alice");
    await fireEvent.press(screen.getByTestId("onboarding-button-continue")); // → currency
    await fireEvent.press(screen.getByTestId("onboarding-currency-USD"));
    await fireEvent.press(screen.getByTestId("onboarding-button-continue")); // → styles
    await fireEvent.press(screen.getByTestId("onboarding-style-budget"));
    await fireEvent.press(screen.getByTestId("onboarding-style-foodie"));
    await fireEvent.press(screen.getByTestId("onboarding-button-continue")); // → handles
    await fireEvent.press(screen.getByTestId("onboarding-button-finish"));

    await waitFor(() => expect(useSessionStore.getState().firstRun).toBe(false));
    expect(request).toHaveBeenCalledWith(userEndpoints.updateMe, {
      body: {
        display_name: "Alice",
        prefs: { home_currency: "USD", travel_style: ["budget", "foodie"] },
      },
    });
  });

  it("blocks finish when a Zelle handle has no display name, then allows + PATCHes it", async () => {
    seedAuthenticated({ firstRun: true });
    const request = mockApi();
    await renderWithProviders(<OnboardingScreen />);

    await fireEvent.changeText(screen.getByTestId("onboarding-input-name"), "Alice");
    await fireEvent.press(screen.getByTestId("onboarding-button-continue")); // → currency
    await fireEvent.press(screen.getByTestId("onboarding-button-continue")); // → styles
    await fireEvent.press(screen.getByTestId("onboarding-button-continue")); // → handles

    await fireEvent.changeText(screen.getByTestId("onboarding-input-zelle"), "sean@example.com");
    expect(screen.getByTestId("onboarding-button-finish")).toBeDisabled();
    expect(screen.getByTestId("onboarding-input-zelle-name-error")).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByTestId("onboarding-input-zelle-name"), "Sean");
    expect(screen.getByTestId("onboarding-button-finish")).toBeEnabled();

    await fireEvent.press(screen.getByTestId("onboarding-button-finish"));
    await waitFor(() => expect(useSessionStore.getState().firstRun).toBe(false));
    expect(request).toHaveBeenCalledWith(userEndpoints.updatePaymentHandles, {
      body: { zelle_handle: "sean@example.com", zelle_display_name: "Sean" },
    });
  });
});
