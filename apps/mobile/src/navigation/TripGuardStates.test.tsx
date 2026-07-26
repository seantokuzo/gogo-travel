/**
 * Guard-state surfaces (T-6.6 / NAV-4). The no-access copy is the Law #3
 * boundary artifact — pin that it stays generic (no existence oracle) and
 * that its one action leaves for the trip list.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import { renderWithTheme } from "@/test-utils/render";

import { NoAccessState, TripErrorState, TripLoadingState } from "./TripGuardStates";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, back: jest.fn() }),
}));

afterEach(() => {
  mockReplace.mockClear();
});

describe("NoAccessState (R-nav-15)", () => {
  it("renders the generic copy — never distinguishes missing from forbidden", async () => {
    await renderWithTheme(<NoAccessState />);
    expect(screen.getByTestId("no-access-screen")).toBeOnTheScreen();
    expect(screen.getByText("Trip unavailable")).toBeOnTheScreen();
    expect(
      screen.getByText("This trip doesn't exist or you don't have access to it."),
    ).toBeOnTheScreen();
  });

  it("its action replaces to the trip list", async () => {
    await renderWithTheme(<NoAccessState />);
    await fireEvent.press(screen.getByTestId("no-access-button-trips"));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/(trips)"));
  });
});

describe("TripLoadingState / TripErrorState", () => {
  it("loading holds without rendering any trip content", async () => {
    await renderWithTheme(<TripLoadingState />);
    expect(screen.getByTestId("trip-loading")).toBeOnTheScreen();
  });

  it("error surface exposes the derived retry control", async () => {
    const onRetry = jest.fn();
    await renderWithTheme(<TripErrorState onRetry={onRetry} />);
    await fireEvent.press(screen.getByTestId("trip-error-banner-retry"));
    expect(onRetry).toHaveBeenCalled();
  });
});
