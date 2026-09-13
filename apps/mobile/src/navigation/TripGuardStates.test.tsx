/**
 * Guard-state surfaces (T-6.6 / NAV-4). The no-access copy is the Law #3
 * boundary artifact — pin that it stays generic (no existence oracle) and
 * that its one action leaves for the trip list.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import { renderWithTheme } from "@/test-utils/render";

import { NoAccessState, TripErrorState, TripLoadingState } from "./TripGuardStates";

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: mockDismissTo, back: jest.fn() }),
}));

afterEach(() => {
  mockReplace.mockClear();
  mockDismissTo.mockClear();
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

  it("its action DISMISSES to the trip list — never replaces", async () => {
    await renderWithTheme(<NoAccessState />);
    await fireEvent.press(screen.getByTestId("no-access-button-trips"));
    // `replace` swaps the route at `state.index` in place, so on the push
    // entry path (`(trips)` already below) it would stack a SECOND trip list;
    // see the primitive section of `TripSwitcher.tsx`.
    await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith("/(trips)"));
    expect(mockReplace).not.toHaveBeenCalled();
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

  it("B-25: the error surface also carries an EXIT — it renders outside TripShell, so the switcher is not behind it", async () => {
    await renderWithTheme(<TripErrorState onRetry={jest.fn()} />);
    await fireEvent.press(screen.getByTestId("trip-error-button-trips"));
    await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith("/(trips)"));
  });
});
